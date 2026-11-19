import { useEffect, useState } from "react";
import type { BatchView } from "@qorechain/rdk";
import { fromHex, sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import { buildDataReceipt, checkDataReceiptOnChain, verifyDataReceipt } from "@vigil/sealed/data-receipt";
import { batchHolding, readInbox, transferOf, type InboxPost } from "@vigil/sealed/inbox";
import { isSealedEnvelope, openPayslip, type Payslip } from "@vigil/sealed/payslip";
import { CHAIN_ID, KNOWN, REPO, ROLLUP, chain, qor, short, shortAddr } from "../chain.ts";

const env = { chainId: CHAIN_ID, rollupId: ROLLUP };

interface Sealed {
  post: InboxPost;
  batch?: BatchView;
  receipt?: { valid: boolean; onChain: boolean; finalized: boolean; detail: string };
}

interface Opened {
  sequence: number;
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

export function PayslipView() {
  const [posts, setPosts] = useState<InboxPost[]>();
  const [sealed, setSealed] = useState<Sealed[]>([]);
  const [error, setError] = useState<string>();
  const [holder, setHolder] = useState<string>();
  const [opened, setOpened] = useState<Opened[]>();
  const [keyError, setKeyError] = useState<string>();

  useEffect(() => {
    void (async () => {
      try {
        const { rdk } = await chain();
        const [all, batches] = await Promise.all([readInbox(rdk.rest, env), rdk.rest.listBatches(ROLLUP)]);
        setPosts(all);
        const env_ = all.filter((p) => isSealedEnvelope(p.payload));
        const rows: Sealed[] = env_.map((post) => ({ post, batch: batchHolding(batches, post.sequence) }));
        setSealed(rows);
        // A data receipt for each envelope: the chain committed to it inside a settled batch.
        const checked = await Promise.all(
          rows.map(async (row) => {
            if (!row.batch) return row;
            try {
              const r = await buildDataReceipt(rdk.rest, env, row.post.sequence);
              const local = verifyDataReceipt(r, row.post.payload);
              const live = await checkDataReceiptOnChain(rdk.rest, r);
              return { ...row, receipt: { valid: local.valid, ...live } };
            } catch (e) {
              return { ...row, receipt: { valid: false, onChain: false, finalized: false, detail: String(e instanceof Error ? e.message : e) } };
            }
          }),
        );
        setSealed(checked);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
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
          payslip,
          ...(paymentPost && {
            payment: {
              sequence: paymentPost.sequence,
              matches: !!t && t.fromAccount === payslip.payment.fromAccount && t.toAccount === payslip.payment.toAccount && t.amountUqor === payslip.payment.amountUqor,
            },
          }),
        });
      }
      setOpened(out);
    } catch (e) {
      setKeyError(String(e instanceof Error ? e.message : e));
    }
  }

  return (
    <>
      <h1>Open a sealed payslip</h1>
      <p className="lede">
        Payslips travel inside the rollup's public inbox, sealed with QoreSeal (ML-KEM-1024 together with X25519) to the employee, the employer and an
        auditor. Anyone can check that a payslip was posted and settled. Only its recipients can read it, today or after a quantum computer exists.
      </p>

      <div className="cols">
        <div>
          <section className="panel">
            <h2>
              Sealed envelopes in the inbox <small>{posts ? `${sealed.length} of ${posts.length} entries` : "reading…"}</small>
            </h2>
            {error && <p className="err">{error}</p>}
            {!error && !posts && <p className="empty">Reading every inbox entry and checking it against the chain's accumulator…</p>}
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
                      <tr key={s.post.sequence}>
                        <td className="num">{s.post.sequence}</td>
                        <td>
                          <Name addr={s.post.poster} />
                        </td>
                        <td className="num">{s.post.payload.length.toLocaleString()} B</td>
                        <td>
                          <code title={s.post.dataHash}>{short(s.post.dataHash, 6)}</code>
                        </td>
                        <td>
                          {!s.batch ? (
                            <span className="chip warn">not yet batched</span>
                          ) : !s.receipt ? (
                            <span className="note">checking…</span>
                          ) : s.receipt.valid && s.receipt.onChain ? (
                            <span className={`chip ${s.receipt.finalized ? "ok" : "warn"}`} title={s.receipt.detail}>
                              batch {s.batch.batchIndex}, {s.receipt.finalized ? "final" : s.batch.status}
                            </span>
                          ) : (
                            <span className="chip bad" title={s.receipt.detail}>
                              receipt fails
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="note" style={{ marginTop: 10 }}>
              "Settled" is a data receipt checked here: the batch's data commitment, re-folded from every entry in its range, includes this exact
              envelope, and the chain's batch record says the same.
            </p>
          </section>
        </div>

        <aside>
          <section className="panel">
            <h2>Open with your seal key</h2>
            <p className="note">
              Choose your QoreSeal key file (<code>QSEAL_ADDRESS</code>, <code>QSEAL_SEED_HEX</code>). It is read in this page only: nothing is sent
              anywhere, and it is forgotten when you leave.
            </p>
            <input type="file" accept=".env,.txt,text/plain" disabled={!posts} onChange={(e) => void onKeyFile(e.target.files?.[0])} aria-label="Seal key file" />
            {keyError && <p className="err" style={{ marginTop: 10 }}>{keyError}</p>}
            {holder && opened && opened.length === 0 && <p className="empty">No envelope here is sealed to {shortAddr(holder)}.</p>}
            {opened?.map((o) => (
              <div className="payslip" key={o.sequence}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>Payslip {o.payslip.period}</strong>
                  <span className="chip info">entry {o.sequence}</span>
                </div>
                <dl className="kv">
                  <dt>Employer</dt>
                  <dd>
                    <Name addr={o.payslip.employer} />
                  </dd>
                  <dt>Employee</dt>
                  <dd>
                    <Name addr={o.payslip.employee} />
                  </dd>
                  <dt>Issued</dt>
                  <dd>{new Date(o.payslip.issuedAt).toUTCString()}</dd>
                </dl>
                <table style={{ marginTop: 10 }}>
                  <tbody>
                    {o.payslip.lines.map((l, i) => (
                      <tr key={i}>
                        <td>{l.label}</td>
                        <td className="num">{qor(l.amountUqor.replace(/^-/, ""))}{l.amountUqor.startsWith("-") ? " (deducted)" : ""}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>Paid</strong>
                      </td>
                      <td className="num">
                        <strong>{qor(o.payslip.payment.amountUqor)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {o.payment ? (
                  <p className={o.payment.matches ? "verdict ok" : "verdict bad"}>
                    {o.payment.matches
                      ? `Matches public transfer #${o.payment.sequence}: same accounts, same amount, signed with ML-DSA-44.`
                      : `Does not match transfer #${o.payment.sequence}.`}
                  </p>
                ) : (
                  <p className="note">The transfer it explains is not in the inbox.</p>
                )}
                {o.payslip.note && <p className="note">{o.payslip.note}</p>}
              </div>
            ))}
          </section>
          <section className="panel">
            <h2>What stays public</h2>
            <p className="note">
              QoreSeal hides the content. The envelope's size, the time it was posted, the poster's address and the public transfer it explains stay
              visible. See the <a href={`${REPO}/blob/main/THREAT_MODEL.md`}>threat model</a>, section 13.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
