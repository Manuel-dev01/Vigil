import { useEffect, useMemo, useState } from "react";
import { EMPTY_INBOX_ACC, bytesToHex, qledgerAccumulate, type BatchView, type RdkClient } from "@qorechain/rdk";
import { fromHex, sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import { checkDataReceiptOnChain, dataReceiptFrom, verifyDataReceipt } from "@vigil/sealed/data-receipt";
import { batchHolding, readInbox, transferOf, type InboxPost } from "@vigil/sealed/inbox";
import { isSealedEnvelope, openPayslip, type Payslip } from "@vigil/sealed/payslip";
import { chain, isNotFound } from "../chain.ts";
import { CHAIN_ID, KNOWN, NODE_HOST, REPO, ROLLUP, qor, short, shortAddr, utcStamp } from "../config.ts";
import { reveal } from "../reveal.ts";
import { Ext } from "../ui.tsx";
import { PageHead, Reading, type Sounding } from "./Head.tsx";
import { InboxStrip, kindOf } from "./Inbox.tsx";

const env = { chainId: CHAIN_ID, rollupId: ROLLUP };

type Settlement =
  /** A batch record holds the entry and its data receipt verifies against it. */
  | { kind: "receipt"; batch: BatchView; valid: boolean; onChain: boolean; finalized: boolean; detail: string }
  /** The inbox says the entry was consumed, but no batch record holding it is left (pruned). */
  | { kind: "record pruned"; consumed: number }
  /** Not consumed by any batch yet. */
  | { kind: "not batched" }
  | { kind: "checking" };

interface Sealed {
  post: InboxPost;
  settled: Settlement;
  /** The chain no longer keeps this entry's posted-data record (it does so for 648,000 blocks). */
  postedDataPruned?: boolean;
}

interface Opened {
  sequence: number;
  poster: string;
  payslip: Payslip;
  /** The public transfer the payslip explains, and whether it matches. */
  payment?: { sequence: number; matches: boolean };
}

function parseKeyFile(text: string): { address: string; keys: SealKeyPair } {
  const address = /^QSEAL_ADDRESS=(\S+)$/m.exec(text)?.[1];
  const seed = /^QSEAL_SEED_HEX=([0-9a-f]{64})$/m.exec(text)?.[1];
  if (!address || !seed) throw new Error("this is not a seal key file (it needs QSEAL_ADDRESS and QSEAL_SEED_HEX)");
  return { address, keys: sealKeysFromSeed(fromHex(seed)) };
}

const Name = ({ addr }: { addr: string }) => <span title={addr}>{KNOWN[addr] ? <strong>{KNOWN[addr]}</strong> : <code>{shortAddr(addr)}</code>}</span>;
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

/**
 * A data receipt for `post`, built from the inbox entries the page read (each from the transaction that
 * posted it, all together checked against the chain's inbox accumulator), so it does not need the chain's
 * posted-data records, which are pruned after 648,000 blocks. Then checked offline and against the batch.
 */
async function settlementOf(rdk: RdkClient, posts: InboxPost[], post: InboxPost, batch: BatchView): Promise<Settlement> {
  try {
    const before = posts.filter((p) => p.sequence <= batch.inboxStart);
    if (before.length !== batch.inboxStart) throw new Error(`the page read ${before.length} of the ${batch.inboxStart} entries before this batch`);
    const accFrom = hex(qledgerAccumulate({ ...env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: before.map((p) => ({ height: BigInt(p.height), poster: p.poster, payload: p.payload })) }));
    const range = posts.filter((p) => p.sequence > batch.inboxStart && p.sequence <= batch.inboxEnd);
    const receipt = dataReceiptFrom({
      ...env,
      sequence: post.sequence,
      batch: { batchIndex: batch.batchIndex, inboxStart: batch.inboxStart, inboxEnd: batch.inboxEnd, dataHash: batch.dataHash, stateRoot: batch.stateRoot, status: batch.status },
      accFrom,
      posts: range.map((p) => ({ sequence: p.sequence, height: p.height, poster: p.poster, dataHash: p.dataHash })),
    });
    const local = verifyDataReceipt(receipt, post.payload);
    const live = await checkDataReceiptOnChain(rdk.rest, receipt);
    return { kind: "receipt", batch, valid: local.valid, ...live };
  } catch (e) {
    return { kind: "receipt", batch, valid: false, onChain: false, finalized: false, detail: errText(e) };
  }
}

function SettledCell({ s }: { s: Sealed }) {
  const st = s.settled;
  const pruneNote = s.postedDataPruned ? (
    <span className="note" title="The chain keeps each entry's posted-data record for 648,000 blocks. The receipt here is rebuilt from the transaction that posted the entry instead.">
      {" "}
      · posted-data record pruned
    </span>
  ) : null;
  if (st.kind === "checking") return <span className="note">checking…</span>;
  if (st.kind === "not batched") return <span className="chip warn">not yet batched</span>;
  if (st.kind === "record pruned")
    return (
      <>
        <span className="chip pruned" title={`The inbox shows entries up to ${st.consumed} consumed by batches, so this one was batched; the chain no longer keeps that batch's record, so its data receipt cannot be checked against it.`}>
          batched · batch record pruned
        </span>
        {pruneNote}
      </>
    );
  if (st.valid && st.onChain)
    return (
      <>
        <span className={`chip ${st.finalized ? "ok" : "warn"}`} title={st.detail}>
          batch {st.batch.batchIndex}, {st.finalized ? "final" : st.batch.status}
        </span>
        {pruneNote}
      </>
    );
  return (
    <>
      <span className="chip bad" title={st.detail}>
        in batch {st.batch.batchIndex} · receipt fails
      </span>
      {pruneNote}
    </>
  );
}

export function PayslipView() {
  const [posts, setPosts] = useState<InboxPost[]>();
  const [batches, setBatches] = useState<BatchView[]>();
  const [dragging, setDragging] = useState(false);
  const [sealed, setSealed] = useState<Sealed[]>([]);
  const [error, setError] = useState<string>();
  const [holder, setHolder] = useState<string>();
  const [opened, setOpened] = useState<Opened[]>();
  const [keyError, setKeyError] = useState<string>();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { rdk } = await chain();
        const [all, batches, inbox] = await Promise.all([readInbox(rdk.rest, env), rdk.rest.listBatches(ROLLUP), rdk.rest.getInbox(ROLLUP)]);
        if (!alive) return;
        setPosts(all);
        setBatches(batches);
        const consumed = Number(inbox.consumedSequence);
        const rows: Sealed[] = all
          .filter((p) => isSealedEnvelope(p.payload))
          .map((post) => {
            const b = batchHolding(batches, post.sequence);
            return { post, settled: b ? { kind: "checking" } : post.sequence <= consumed ? { kind: "record pruned", consumed } : { kind: "not batched" } };
          });
        setSealed(rows);
        // A data receipt for each envelope: the chain committed to it inside a settled batch.
        const checked = await Promise.all(
          rows.map(async (row): Promise<Sealed> => {
            const b = batchHolding(batches, row.post.sequence);
            const [settled, postedDataPruned] = await Promise.all([
              b ? settlementOf(rdk, all, row.post, b) : Promise.resolve(row.settled),
              rdk.rest.getPostedData(ROLLUP, row.post.sequence).then(
                () => false,
                (e: unknown) => isNotFound(e),
              ),
            ]);
            return { ...row, settled, postedDataPruned };
          }),
        );
        if (alive) setSealed(checked);
      } catch (e) {
        if (alive) setError(errText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function onKeyFile(file: File | undefined) {
    setKeyError(undefined);
    setOpened(undefined);
    setHolder(undefined);
    if (!file || !posts) return;
    try {
      const { address, keys } = parseKeyFile(await file.text());
      setHolder(address);
      const out: Opened[] = [];
      for (const s of sealed) {
        let payslip: Payslip;
        try {
          payslip = openPayslip({ chainId: CHAIN_ID, rollupId: ROLLUP, envelope: s.post.payload, keys });
        } catch {
          continue; // not sealed to this key
        }
        const paymentPost = posts.find((p) => p.dataHash === payslip.payment.postDataHash.toLowerCase());
        const t = paymentPost ? transferOf(paymentPost.payload, env) : undefined;
        out.push({
          sequence: s.post.sequence,
          poster: s.post.poster,
          payslip,
          ...(paymentPost && {
            payment: {
              sequence: paymentPost.sequence,
              matches: !!t && t.fromAccount === payslip.payment.fromAccount && t.toAccount === payslip.payment.toAccount && t.amountUqor === payslip.payment.amountUqor,
            },
          }),
        });
      }
      // Newest first.
      setOpened(out.sort((a, b) => b.sequence - a.sequence));
    } catch (e) {
      setKeyError(errText(e));
    }
  }

  const kinds = useMemo(() => new Map((posts ?? []).map((p) => [p.sequence, kindOf(p, env)])), [posts]);
  const openedSet = useMemo(() => new Set((opened ?? []).map((o) => o.sequence)), [opened]);
  const settledCount = sealed.filter((s) => s.settled.kind === "receipt" && s.settled.valid && s.settled.onChain).length;
  const checking = sealed.some((s) => s.settled.kind === "checking");
  const soundings: Sounding[] = [
    { k: "Inbox entries", v: posts?.length, s: "each read from the transaction that posted it" },
    { k: "Sealed envelopes", v: posts ? sealed.length : undefined, s: "ML-KEM-1024 with X25519" },
    {
      k: "Settled",
      v: posts ? (checking ? "checking…" : `${settledCount} of ${sealed.length}`) : undefined,
      tone: posts && !checking && settledCount === sealed.length && sealed.length > 0 ? "ok" : undefined,
      s: "a data receipt checked here for each",
    },
    { k: "Opened here", v: opened ? opened.length : "—", s: "your key never leaves this page" },
  ];
  const showPayslip = (seq: number) => document.getElementById(`payslip-${seq}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });

  return (
    <>
      <PageHead
        eyebrow={<>Sealed payslips · QoreSeal</>}
        title="Open a sealed payslip"
        lede={
          <>
            <p>
              Payslips travel inside the rollup's public inbox, sealed with QoreSeal (ML-KEM-1024 together with X25519) to the employee, the employer and an
              auditor.
            </p>
            <p>
              Anyone can check that a payslip was posted and settled. Only its recipients can read it, today and after a quantum computer exists, while
              ML-KEM-1024 holds. The payment itself is a public transfer signed with ML-DSA-44; the payslip that explains it is encrypted but not signed.
            </p>
          </>
        }
        soundings={soundings}
      />

      {error && <p className="err">{error}</p>}
      {!error && !posts && <Reading>Reading every inbox entry from {NODE_HOST} and checking them against the chain's accumulator…</Reading>}

      <InboxStrip posts={posts} kinds={kinds} batches={batches} opened={openedSet} onOpen={showPayslip} />

      <div className="cols">
        <div>
          <section className="panel" ref={reveal}>
            <h2>
              Sealed envelopes in the inbox <small>{posts ? `${sealed.length} of ${posts.length} entries` : "reading…"}</small>
            </h2>
            {posts && sealed.length === 0 && <p className="empty">No sealed envelope in the inbox yet.</p>}
            {sealed.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Entry</th>
                      <th>Posted by</th>
                      <th className="num">Size</th>
                      <th>Payload hash</th>
                      <th>Settled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sealed.map((s) => (
                      <tr key={s.post.sequence} className={openedSet.has(s.post.sequence) ? "is-opened" : undefined}>
                        <td className="num">{s.post.sequence}</td>
                        <td>
                          <Name addr={s.post.poster} />
                        </td>
                        <td className="num">{s.post.payload.length.toLocaleString()} B</td>
                        <td>
                          <code title={s.post.dataHash}>{short(s.post.dataHash, 6)}</code>
                        </td>
                        <td>
                          <SettledCell s={s} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="note" style={{ marginTop: 10 }}>
              "Settled" is a data receipt checked here: the batch's data commitment, re-folded from every entry in its range, includes this exact envelope,
              and the batch record {NODE_HOST} reports says the same. The entries are read from the transactions that posted them and checked together
              against the chain's inbox accumulator, so the receipt still works after the chain prunes an entry's posted-data record (648,000 blocks).
            </p>
          </section>
        </div>

        <aside>
          <section className="panel" ref={reveal}>
            <h2>Open with your seal key</h2>
            <label
              className={`drop${dragging ? " over" : ""}${!posts ? " off" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                if (posts) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (posts) void onKeyFile(e.dataTransfer.files?.[0]);
              }}
            >
              <span className="drop-env" aria-hidden="true">
                <svg viewBox="-12 -9 24 18" width="40" height="30">
                  <rect x={-11} y={-8} width={22} height={16} rx={1} />
                  <path className="flap" d="M-11 -8L0 1.5L11 -8" />
                </svg>
              </span>
              <span className="drop-t">{posts ? "Drop your QoreSeal key file here, or choose it" : "Reading the inbox first…"}</span>
              <span className="note">
                A file with <code>QSEAL_ADDRESS</code> and <code>QSEAL_SEED_HEX</code>. It is read in this page only: nothing is sent anywhere, and it is
                forgotten when you leave.
              </span>
              <input type="file" accept=".env,.txt,text/plain" disabled={!posts} onChange={(e) => void onKeyFile(e.target.files?.[0])} aria-label="Seal key file" />
            </label>
            {keyError && (
              <p className="err" style={{ marginTop: 10 }}>
                {keyError}
              </p>
            )}
            {holder && opened && opened.length === 0 && <p className="empty">No envelope here is sealed to {shortAddr(holder)}.</p>}
            {opened && opened.length > 1 && <p className="note opened-count">{opened.length} payslips, newest first.</p>}
            {opened?.map((o) => {
              const employerIsPoster = o.payslip.employer === o.poster;
              return (
                <article className="pdoc" key={o.sequence} id={`payslip-${o.sequence}`}>
                  <header className="rdoc-top">
                    <span>Payslip · opened in this browser</span>
                    <span>entry {o.sequence}</span>
                  </header>
                  <h3 className="pdoc-t">{o.payslip.period}</h3>
                  <dl className="kv">
                    <dt>Employer</dt>
                    <dd>
                      {employerIsPoster ? (
                        <>
                          <Name addr={o.payslip.employer} />{" "}
                          <span className="chip ok" title="The payslip's employer field names the account the chain says posted the envelope.">
                            is the poster
                          </span>
                        </>
                      ) : (
                        <>
                          <code title={o.payslip.employer}>{shortAddr(o.payslip.employer)}</code>{" "}
                          <span className="chip bad">not the poster</span>
                        </>
                      )}
                    </dd>
                    <dt>Employee</dt>
                    <dd>
                      <Name addr={o.payslip.employee} />
                    </dd>
                    <dt>Issued</dt>
                    <dd>{Number.isFinite(Date.parse(o.payslip.issuedAt)) ? utcStamp(Date.parse(o.payslip.issuedAt)) : o.payslip.issuedAt}</dd>
                  </dl>
                  {!employerIsPoster && (
                    <p className="err" style={{ marginTop: 10 }}>
                      This payslip says it is from <code>{o.payslip.employer}</code>, but the envelope was posted by <Name addr={o.poster} />. The employer field
                      is written inside the sealed payslip and is not signed; only the poster is vouched for by the chain. Do not trust who it claims to be from.
                    </p>
                  )}
                  <table className="pdoc-lines">
                    <tbody>
                      {o.payslip.lines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.label}</td>
                          <td className="num">
                            {qor(l.amountUqor.replace(/^-/, ""))}
                            {l.amountUqor.startsWith("-") ? " (deducted)" : ""}
                          </td>
                        </tr>
                      ))}
                      <tr className="pdoc-paid">
                        <td>Paid</td>
                        <td className="num">{qor(o.payslip.payment.amountUqor)}</td>
                      </tr>
                    </tbody>
                  </table>
                  {o.payment ? (
                    <p className={o.payment.matches ? "verdict ok" : "verdict bad"}>
                      {o.payment.matches
                        ? `Matches public transfer #${o.payment.sequence}: same accounts, same amount, and that transfer's ML-DSA-44 signature verifies.`
                        : `Does not match transfer #${o.payment.sequence}.`}
                    </p>
                  ) : (
                    <p className="note">The transfer it explains is not in the inbox.</p>
                  )}
                  <p className="note" style={{ marginTop: 6 }}>
                    The transfer is signed with ML-DSA-44. The payslip, its lines and its employer field are encrypted but not signed: they say what the sender
                    wrote. Only the poster of the envelope is vouched for by the chain.
                  </p>
                  {o.payslip.note && <p className="note">{o.payslip.note}</p>}
                  <p className="rdoc-stamp ok pdoc-stamp">Unsealed · ML-KEM + X25519</p>
                </article>
              );
            })}
          </section>
          <section className="panel" ref={reveal}>
            <h2>What stays public</h2>
            <p className="note">
              QoreSeal hides the content. The envelope's size, the time it was posted, the poster's address and the public transfer it explains stay
              visible. See the <Ext href={`${REPO}/blob/main/THREAT_MODEL.md`}>threat model</Ext>, section 13.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
