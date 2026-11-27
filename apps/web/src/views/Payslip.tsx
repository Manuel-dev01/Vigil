import { useEffect, useMemo, useRef, useState } from "react";
import type { BatchView } from "@qorechain/rdk";
import { fromHex, generateSealKeys, sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import { openPayslipWithDataKey, payslipDataKey } from "@vigil/sealed/disclose";
import { batchHolding, readInbox, transferOf, type InboxPost } from "@vigil/sealed/inbox";
import { isSealedEnvelope, openPayslip, type Payslip } from "@vigil/sealed/payslip";
import { chain, isNotFound } from "../chain.ts";
import { CHAIN_ID, DEMO_READER_KEY_URL, NODE_HOST, REPO, ROLLUP, short, shortAddr } from "../config.ts";
import { parseShareFragment, type NamedTransfer, type ReceiptState } from "../disclosure.ts";
import { reveal } from "../reveal.ts";
import { leavingWithdrawals, withdrawalsIn, type ExitSeen, type SalaryPayment, type TransferSeen } from "../salary-exit.ts";
import { settlementOf, type Settlement } from "../settlement.ts";
import { Ext } from "../ui.tsx";
import { PageHead, Reading, type Sounding } from "./Head.tsx";
import { InboxStrip, kindOf } from "./Inbox.tsx";
import { DisclosedDoc, Name, PayslipBody, SalaryExitLine, ShareBox } from "./PayslipParts.tsx";
import "./payslip.css";

const env = { chainId: CHAIN_ID, rollupId: ROLLUP };

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
  /** The envelope's data key, for a share link (undefined if it could not be unwrapped). */
  dataKey?: Uint8Array;
  /** The salary it explains, once its transfer matches: what an instant exit is matched against. */
  salary?: SalaryPayment;
}

/** Whose key opened the envelopes: a key file, a key made in the page, or the published demo reader's. */
type Holder = { kind: "file"; address: string } | { kind: "random" } | { kind: "demo"; address: string };

function parseKeyFile(text: string): { address: string; keys: SealKeyPair } {
  const address = /^QSEAL_ADDRESS=(\S+)$/m.exec(text)?.[1];
  const seed = /^QSEAL_SEED_HEX=([0-9a-f]{64})$/m.exec(text)?.[1];
  if (!address || !seed) throw new Error("this is not a seal key file (it needs QSEAL_ADDRESS and QSEAL_SEED_HEX)");
  return { address, keys: sealKeysFromSeed(fromHex(seed)) };
}

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The public transfer a payslip names (by its post's hash), read from the inbox. */
function namedTransfer(p: Payslip, posts: InboxPost[]): NamedTransfer {
  const post = posts.find((x) => x.dataHash === p.payment.postDataHash.toLowerCase());
  if (!post) return { kind: "missing" };
  let t: ReturnType<typeof transferOf>;
  try {
    t = transferOf(post.payload, env);
  } catch {
    t = undefined;
  }
  return t ? { kind: "transfer", sequence: post.sequence, fromAccount: t.fromAccount, toAccount: t.toAccount, amountUqor: t.amountUqor } : { kind: "not a signed transfer", sequence: post.sequence };
}

const matchesTransfer = (p: Payslip, t: NamedTransfer): boolean =>
  t.kind === "transfer" && t.fromAccount === p.payment.fromAccount && t.toAccount === p.payment.toAccount && t.amountUqor === p.payment.amountUqor;

/** The salary a payslip explains, once its public transfer matches it: the input of the instant-exit match. */
const salaryOf = (p: Payslip, t: NamedTransfer): SalaryPayment | undefined =>
  t.kind === "transfer" && matchesTransfer(p, t) ? { sequence: t.sequence, toAccount: p.payment.toAccount, amountUqor: p.payment.amountUqor } : undefined;

const receiptStateOf = (s: Settlement | undefined): ReceiptState =>
  !s
    ? { kind: "checking" }
    : s.kind === "receipt"
      ? { kind: "receipt", batchIndex: s.batch.batchIndex, status: s.batch.status, valid: s.valid, onChain: s.onChain, finalized: s.finalized, detail: s.detail }
      : s.kind === "unchecked"
        ? { kind: "unchecked", batchIndex: s.batch.batchIndex, detail: s.detail }
        : s;

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
  if (st.kind === "unchecked")
    return (
      <>
        <span className="chip warn" title={`${st.detail}. Reload to try again.`}>
          in batch {st.batch.batchIndex} · could not check
        </span>
        {pruneNote}
      </>
    );
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
  const [holder, setHolder] = useState<Holder>();
  const [opened, setOpened] = useState<Opened[]>();
  const [keyError, setKeyError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [shareOpen, setShareOpen] = useState<number>();
  const [printing, setPrinting] = useState<string>();
  const [share, setShare] = useState(() => parseShareFragment(location.hash));
  const [exits, setExits] = useState<ExitSeen[]>();
  const [exitsError, setExitsError] = useState<string>();
  const exitsFor = useRef<string | undefined>(undefined);

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
              b ? settlementOf(rdk.rest, env, all, row.post, b) : Promise.resolve(row.settled),
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

  // A share link (#/payslip?entry=27&dk=…) opens that payslip here, on load and whenever the link changes.
  useEffect(() => {
    const fromHash = () => {
      const next = parseShareFragment(location.hash);
      setShare(next);
      if (next) requestAnimationFrame(() => document.getElementById("disclosed")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }));
    };
    addEventListener("hashchange", fromHash);
    return () => removeEventListener("hashchange", fromHash);
  }, []);

  // Print one payslip: mark it, print, and unmark it once the print dialog closes.
  useEffect(() => {
    if (!printing) return;
    const root = document.documentElement;
    const done = () => setPrinting(undefined);
    root.classList.add("printing");
    addEventListener("afterprint", done);
    const t = setTimeout(() => print(), 50);
    return () => {
      clearTimeout(t);
      removeEventListener("afterprint", done);
      root.classList.remove("printing");
    };
  }, [printing]);

  function reset() {
    setKeyError(undefined);
    setOpened(undefined);
    setHolder(undefined);
    setShareOpen(undefined);
  }

  /** Try `keys` on every sealed envelope; the ones it opens are shown, matched to their public transfers. */
  function openWith(keys: SealKeyPair, who: Holder) {
    if (!posts) return;
    setHolder(who);
    const out: Opened[] = [];
    for (const s of sealed) {
      let payslip: Payslip;
      try {
        payslip = openPayslip({ chainId: CHAIN_ID, rollupId: ROLLUP, envelope: s.post.payload, keys });
      } catch {
        continue; // not sealed to this key
      }
      const t = namedTransfer(payslip, posts);
      const salary = salaryOf(payslip, t);
      let dataKey: Uint8Array | undefined;
      try {
        dataKey = payslipDataKey({ chainId: CHAIN_ID, rollupId: ROLLUP, envelope: s.post.payload, keys });
      } catch {
        dataKey = undefined;
      }
      out.push({
        sequence: s.post.sequence,
        poster: s.post.poster,
        payslip,
        ...(t.kind !== "missing" && { payment: { sequence: t.sequence, matches: matchesTransfer(payslip, t) } }),
        ...(dataKey && { dataKey }),
        ...(salary && { salary }),
      });
    }
    // Newest first.
    setOpened(out.sort((a, b) => b.sequence - a.sequence));
  }

  async function onKeyFile(file: File | undefined) {
    reset();
    if (!file || !posts) return;
    try {
      const { address, keys } = parseKeyFile(await file.text());
      openWith(keys, { kind: "file", address });
    } catch (e) {
      setKeyError(errText(e));
    }
  }

  async function tryRandomKey() {
    reset();
    setBusy("Making a key and trying it on every envelope…");
    // Let the page say so before the work starts.
    await new Promise((r) => setTimeout(r, 30));
    try {
      openWith(generateSealKeys(), { kind: "random" });
    } catch (e) {
      setKeyError(errText(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function openAsDemoReader() {
    reset();
    if (!DEMO_READER_KEY_URL || !posts) return;
    setBusy("Fetching the demo reader's key…");
    try {
      const url = new URL(DEMO_READER_KEY_URL, location.href);
      if (url.origin !== location.origin) throw new Error("the demo reader's key must come from this site");
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`the demo reader's key could not be fetched (HTTP ${res.status})`);
      const { address, keys } = parseKeyFile(await res.text());
      openWith(keys, { kind: "demo", address });
    } catch (e) {
      setKeyError(errText(e));
    } finally {
      setBusy(undefined);
    }
  }

  // ---- a payslip shared by link
  const disclosed = useMemo(() => {
    if (!share || "error" in share || !posts) return undefined;
    const post = posts.find((p) => p.sequence === share.entry);
    if (!post) return { error: `Entry ${share.entry} is not in the inbox of ${ROLLUP}, which has ${posts.length} entries.` };
    if (!isSealedEnvelope(post.payload)) return { error: `Entry ${share.entry} is not a sealed envelope.` };
    try {
      const payslip = openPayslipWithDataKey({ rollupId: ROLLUP, envelope: post.payload, dataKey: share.dataKey });
      return { post, payslip, transfer: namedTransfer(payslip, posts) };
    } catch (e) {
      return { error: `The key in this link does not open entry ${share.entry}: ${errText(e)}.` };
    }
  }, [share, posts]);

  // ---- instant exits: loaded only if a withdrawal in the inbox could be one of these salaries leaving,
  // and only the exits of the batches that hold such a withdrawal
  const withdrawals = useMemo(() => (posts ? withdrawalsIn(posts) : []), [posts]);
  const disclosedSalary = disclosed && !("error" in disclosed) ? salaryOf(disclosed.payslip, disclosed.transfer) : undefined;
  const leaving = [...(opened ?? []).map((o) => o.salary), disclosedSalary].flatMap((s) => (s ? leavingWithdrawals(s, withdrawals) : []));
  const leavingBatches = leaving.map((w) => (batches ? batchHolding(batches, w.sequence)?.batchIndex : undefined));
  // A withdrawal whose batch record the page does not have (pruned, say): read every exit.
  const exitsKey = leaving.length === 0 ? undefined : leavingBatches.every((b) => b !== undefined) ? [...new Set(leavingBatches)].sort((a, b) => a - b).join(",") : "all";
  useEffect(() => {
    if (!exitsKey || exitsFor.current === exitsKey) return;
    const key = exitsKey;
    exitsFor.current = key;
    const wanted = new Set(key === "all" ? [] : key.split(",").map(Number));
    import("../exits.ts")
      .then((m) => m.loadExits(Number.MAX_SAFE_INTEGER, key === "all" ? undefined : (i) => wanted.has(i)))
      .then(
        (s) => {
          if (exitsFor.current !== key) return;
          setExits(s.exits);
          setExitsError(undefined);
        },
        (e: unknown) => {
          if (exitsFor.current !== key) return;
          // Not "no match": the line under each such payslip says the exits could not be read.
          setExits(undefined);
          setExitsError(errText(e));
        },
      );
  }, [exitsKey]);
  /** The exits' read error, for a salary that a withdrawal could be leaving with (no other salary needs the exits). */
  const exitsErrorFor = (s: SalaryPayment | undefined): string | undefined => (s && exitsError && leavingWithdrawals(s, withdrawals).length > 0 ? exitsError : undefined);
  const transfers = useMemo((): TransferSeen[] | undefined => {
    if (!exits || !posts) return undefined;
    return posts.flatMap((p) => {
      try {
        const t = transferOf(p.payload, env);
        return t ? [{ sequence: p.sequence, toAccount: t.toAccount, amountUqor: t.amountUqor }] : [];
      } catch {
        return [];
      }
    });
  }, [exits, posts]);

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
  const showPayslip = (seq: number) => document.getElementById(`payslip-${seq}`)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  const holderName =
    holder?.kind === "random" ? "a key made just now in this page" : holder?.kind === "demo" ? "the demo reader's key" : holder ? shortAddr(holder.address) : "";

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
              ML-KEM-1024 holds. The payment itself is a public transfer signed with ML-DSA-44; the payslip that explains it is encrypted but not signed. A
              recipient can share one payslip as a link, which opens that payslip and no other.
            </p>
          </>
        }
        soundings={soundings}
      />

      {error && <p className="err">{error}</p>}
      {!error && !posts && <Reading>Reading every inbox entry from {NODE_HOST} and checking them against the chain's accumulator…</Reading>}

      {share && (
        <section className="panel disclosed" id="disclosed" ref={reveal} aria-labelledby="disclosed-title">
          <h2 id="disclosed-title">
            A payslip shared with you <small>{"error" in share ? "link not readable" : `entry ${share.entry}`}</small>
          </h2>
          <p className="note">
            Someone who can read this payslip shared the key to this one envelope. Your browser read the entry from the transaction that posted it, opened
            it here with that key, and checked it against the chain as {NODE_HOST} reports it. No key file and no wallet are needed, and the key in the link
            is not sent anywhere.
          </p>
          {"error" in share ? (
            <p className="err">{share.error}</p>
          ) : !disclosed ? (
            !error && <Reading>Reading the inbox to find entry {share.entry}…</Reading>
          ) : "error" in disclosed ? (
            <p className="err">{disclosed.error}</p>
          ) : (
            <DisclosedDoc
              entry={share.entry}
              href={location.href}
              post={disclosed.post}
              payslip={disclosed.payslip}
              transfer={disclosed.transfer}
              receipt={receiptStateOf(sealed.find((s) => s.post.sequence === share.entry)?.settled)}
              salaryLine={<SalaryExitLine salary={disclosedSalary} transfers={transfers} exits={exits} error={exitsErrorFor(disclosedSalary)} />}
              printing={printing === "disclosed"}
              onPrint={() => setPrinting("disclosed")}
            />
          )}
        </section>
      )}

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

            <div className="key-alts">
              <div className="row">
                <button type="button" className="btn ghost" disabled={!posts || !!busy} onClick={() => void tryRandomKey()}>
                  Try a random key
                </button>
                {DEMO_READER_KEY_URL && (
                  <button type="button" className="btn ghost" disabled={!posts || !!busy} onClick={() => void openAsDemoReader()}>
                    Open as the demo reader
                  </button>
                )}
              </div>
              <p className="note">
                "Try a random key" makes a new QoreSeal key in this page and tries it on every envelope, as an attacker without a recipient's key would.
                {DEMO_READER_KEY_URL &&
                  " The demo reader's key is a testnet seal key published on purpose: it opens only the envelopes sealed to demo-reader, and it cannot sign or spend."}
              </p>
            </div>

            {busy && <Reading>{busy}</Reading>}
            {keyError && (
              <p className="err" style={{ marginTop: 10 }}>
                {keyError}
              </p>
            )}
            {holder && opened && (
              <p className={`opened-result ${opened.length ? "some" : "none"}`} role="status">
                {opened.length} of {sealed.length} envelopes open with {holderName}
                {opened.length < sealed.length ? `; ${sealed.length - opened.length} sealed to others` : ""}.
              </p>
            )}
            {opened && opened.length > 1 && <p className="note opened-count">{opened.length} payslips, newest first.</p>}
            {opened?.map((o) => (
              <article className={`pdoc${printing === `payslip-${o.sequence}` ? " print-me" : ""}`} key={o.sequence} id={`payslip-${o.sequence}`}>
                <header className="rdoc-top">
                  <span>Payslip · opened in this browser</span>
                  <span>entry {o.sequence}</span>
                </header>
                <PayslipBody payslip={o.payslip} poster={o.poster} />
                {o.payment ? (
                  <p className={o.payment.matches ? "verdict ok" : "verdict bad"}>
                    {o.payment.matches
                      ? `Matches public transfer #${o.payment.sequence}: same accounts, same amount, and that transfer's ML-DSA-44 signature verifies.`
                      : `Does not match transfer #${o.payment.sequence}.`}
                  </p>
                ) : (
                  <p className="note">The transfer it explains is not in the inbox.</p>
                )}
                <SalaryExitLine salary={o.salary} transfers={transfers} exits={exits} error={exitsErrorFor(o.salary)} />
                <p className="note" style={{ marginTop: 6 }}>
                  The transfer is signed with ML-DSA-44. The payslip, its lines and its employer field are encrypted but not signed: they say what the sender
                  wrote. Only the poster of the envelope is vouched for by the chain, which does not tie the paying L2 account to the employer.
                </p>
                {o.payslip.note && <p className="note">{o.payslip.note}</p>}
                {o.dataKey && (
                  <div className="share">
                    <button
                      type="button"
                      className="btn ghost no-print"
                      aria-expanded={shareOpen === o.sequence}
                      aria-controls={`share-${o.sequence}`}
                      onClick={() => setShareOpen((v) => (v === o.sequence ? undefined : o.sequence))}
                    >
                      Share this payslip
                    </button>
                    {shareOpen === o.sequence && <ShareBox id={`share-${o.sequence}`} base={`${location.origin}${location.pathname}`} entry={o.sequence} dataKey={o.dataKey} onPrint={() => setPrinting(`payslip-${o.sequence}`)} />}
                  </div>
                )}
                <p className="rdoc-stamp ok pdoc-stamp">Unsealed · ML-KEM + X25519</p>
              </article>
            ))}
          </section>
          <section className="panel" ref={reveal}>
            <h2>What stays public</h2>
            <p className="note">
              QoreSeal hides the content. The envelope's size, the time it was posted, the poster's address and the public transfer it explains stay
              visible. A share link is a key to one payslip that cannot be taken back. See the <Ext href={`${REPO}/blob/main/THREAT_MODEL.md`}>threat model</Ext>,
              section 13.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
