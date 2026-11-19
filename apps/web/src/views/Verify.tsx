import { useEffect, useState } from "react";
import { buildSettlementReceipt, verifySettlementReceipt, type RdkClient, type ReceiptVerification, type SettlementReceipt } from "@qorechain/rdk";
import { CHAIN_ID, KNOWN, ROLLUP, chain, short } from "../chain.ts";

const CHECKS: { key: keyof ReceiptVerification["checks"]; what: string; why: string }[] = [
  { key: "rollupLayerBinding", what: "Rollup and layer belong together", why: "The chain says this rollup settles to the receipt's layer." },
  { key: "batchStateRoot", what: "The chain's batch carries this state root", why: "Read from the batch record the chain itself keeps." },
  { key: "anchorOnChain", what: "A matching anchor exists on chain", why: "State root, layer height, signature, main-chain height and time all match an anchor the chain stored." },
  { key: "creatorAuthority", what: "The signing key came from the chain", why: "The creator's ML-DSA-87 public key is read from the chain's PQ key registry, not taken from the receipt." },
  { key: "pqcSignature", what: "ML-DSA-87 signature verifies", why: "Checked in this browser against that key, over the chain's canonical anchor message." },
  { key: "chainBinding", what: "The receipt names this chain", why: `The receipt says ${CHAIN_ID}, the chain that was queried.` },
];

/**
 * The receipt for batch `i`, bound to batch `i`'s own anchor. Several batches
 * can share a state root (an entry that changes no balance leaves the root as
 * it was), and each has its own anchor with its own height and time; pick the
 * one whose layer height is this batch's index.
 */
async function buildOwnReceipt(rdk: RdkClient, i: number): Promise<SettlementReceipt> {
  const r = await buildSettlementReceipt(rdk, ROLLUP, i);
  if (r.layerHeight === i) return r;
  const own = (await rdk.rest.getAnchors(r.layerId)).find((a) => a.layerHeight === i && a.stateRoot === r.stateRoot);
  if (!own) return r;
  return {
    ...r,
    layerHeight: own.layerHeight,
    validatorSetHash: own.validatorSetHash,
    mainChainHeight: own.mainChainHeight,
    anchoredAt: own.anchoredAt,
    pqcSignature: own.pqcSignature,
    transactionCount: own.transactionCount,
    compressedStateProof: own.compressedStateProof,
  };
}

const batchFromHash = (): number | undefined => {
  const m = /[?&]batch=(\d+)/.exec(location.hash);
  return m ? Number(m[1]) : undefined;
};

function flipStateRoot(r: SettlementReceipt): SettlementReceipt {
  const s = r.stateRoot;
  return { ...r, stateRoot: (s[0] === "0" ? "1" : "0") + s.slice(1) };
}

export function VerifyView() {
  const [batchIndex, setBatchIndex] = useState<number>(batchFromHash() ?? 0);
  const [latest, setLatest] = useState<number>();
  const [receipt, setReceipt] = useState<SettlementReceipt>();
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState<ReceiptVerification>();
  const [finality, setFinality] = useState<{ final: boolean; status: string; until?: number }>();
  const [took, setTook] = useState<number>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void chain()
      .then(({ rdk }) => rdk.rest.getLatestBatch(ROLLUP))
      .then((b) => {
        setLatest(b.batchIndex);
        if (batchFromHash() === undefined) setBatchIndex(b.batchIndex);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const b = batchFromHash();
    if (b !== undefined) void build(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(r: SettlementReceipt) {
    setBusy("Verifying against the chain…");
    setError(undefined);
    setResult(undefined);
    setFinality(undefined);
    try {
      const { rdk } = await chain();
      const t0 = performance.now();
      const v = await verifySettlementReceipt(r, { client: rdk });
      setTook(Math.round(performance.now() - t0));
      // A receipt's anchor exists from the moment the batch is submitted. The
      // batch is settled only once its challenge window has closed.
      const [batch, rollup] = await Promise.all([rdk.rest.getBatch(r.rollupId, r.batchIndex).catch(() => undefined), rdk.rest.getRollup(r.rollupId)]);
      setFinality(
        batch
          ? {
              final: batch.status === "finalized",
              status: batch.status,
              ...(batch.submittedTime && rollup.challengeWindowSec ? { until: batch.submittedTime + rollup.challengeWindowSec } : {}),
            }
          : { final: false, status: "not found" },
      );
      setResult(v);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(undefined);
    }
  }

  async function build(i: number) {
    setBusy(`Building the receipt for batch ${i} from chain state…`);
    setError(undefined);
    setResult(undefined);
    try {
      const { rdk } = await chain();
      const r = await buildOwnReceipt(rdk, i);
      setReceipt(r);
      setPasted(JSON.stringify(r, null, 2));
      await verify(r);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setBusy(undefined);
    }
  }

  async function verifyPasted() {
    try {
      const r = JSON.parse(pasted) as SettlementReceipt;
      setReceipt(r);
      await verify(r);
    } catch (e) {
      setError(`That is not a receipt: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  async function tamper() {
    if (!receipt) return;
    const forged = flipStateRoot(receipt);
    setReceipt(forged);
    setPasted(JSON.stringify(forged, null, 2));
    await verify(forged);
  }

  function download() {
    if (!receipt) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${receipt.rollupId}-batch-${receipt.batchIndex}-receipt.json` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <h1>Verify a settlement receipt</h1>
      <p className="lede">
        A settlement receipt says "the chain settled this rollup at this state root, signed by the rollup's ML-DSA-87 key". Here it is checked the
        strict way: every field is re-read from chain state and the post-quantum signature is verified in your browser. A receipt on its own proves
        nothing; only this check does.
      </p>

      <div className="cols">
        <div>
          <section className="panel">
            <h2>1. Get a receipt</h2>
            <div className="row">
              <label htmlFor="batch">Batch</label>
              <input id="batch" type="number" min={0} max={latest} value={batchIndex} onChange={(e) => setBatchIndex(Number(e.target.value))} style={{ width: 90 }} />
              <button className="primary" disabled={!!busy} onClick={() => void build(batchIndex)}>
                Build from chain and verify
              </button>
              {latest !== undefined && <span className="note">batches 0 to {latest}</span>}
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              Or paste a receipt someone gave you (for example one from <code>receipts/vigil-pay-1/</code> in the repo):
            </p>
            <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} aria-label="Receipt JSON" placeholder='{"version": 2, "rollupId": "vigil-pay-1", …}' />
            <div className="row" style={{ marginTop: 8 }}>
              <button disabled={!!busy || !pasted.trim()} onClick={() => void verifyPasted()}>
                Verify this receipt
              </button>
              <button disabled={!!busy || !receipt} onClick={() => void tamper()} title="Change one hex digit of the state root and verify again">
                Forge it: change one digit of the state root
              </button>
              <button disabled={!receipt} onClick={download}>
                Download JSON
              </button>
            </div>
          </section>
        </div>

        <aside>
          <section className="panel" aria-live="polite">
            <h2>2. Result</h2>
            {busy && <p className="empty">{busy}</p>}
            {error && <p className="err">{error}</p>}
            {!busy && !error && !result && <p className="empty">Build or paste a receipt to check it.</p>}
            {result && receipt && (
              <>
                <ul className="checks">
                  {[
                    ...CHECKS.map((c) => ({ ...c, ok: result.checks[c.key] })),
                    {
                      key: "ownAnchor",
                      what: "It is this batch's own anchor",
                      why: result.anchor
                        ? `The matched anchor is layer height ${result.anchor.layerHeight}, made at block ${result.anchor.mainChainHeight.toLocaleString()}.`
                        : "The anchor's layer height equals the batch index, so its block and time are this batch's.",
                      ok: !!result.anchor && result.anchor.layerHeight === receipt.batchIndex,
                    },
                    {
                      key: "final",
                      what: "The batch is final",
                      why: finality?.final
                        ? "Its challenge window has closed, so no fraud proof can remove it."
                        : finality?.until
                          ? `It is ${finality.status} and can still be challenged until ${new Date(finality.until * 1000).toUTCString()}.`
                          : `The chain reports it as ${finality?.status ?? "unknown"}.`,
                      ok: !!finality?.final,
                    },
                  ].map((c, i, all) => {
                    const firstFail = all.findIndex((x) => !x.ok);
                    const reached = result.valid || firstFail === -1 || i <= firstFail;
                    return (
                      <li key={c.key}>
                        <span className={c.ok ? "mark-ok" : reached ? "mark-bad" : "mark-skip"} aria-label={c.ok ? "passed" : reached ? "failed" : "not reached"}>
                          {c.ok ? "✓" : reached ? "✕" : "–"}
                        </span>
                        <span>
                          <span className="what">{c.what}</span>
                          {!c.ok && !reached && <span className="note"> (not reached)</span>}
                          <br />
                          <span className="why">{c.why}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <div className={`verdict ${!result.valid ? "bad" : result.anchor?.layerHeight !== receipt.batchIndex ? "bad" : finality?.final ? "ok" : "warn"}`}>
                  {!result.valid
                    ? `Not valid: ${result.reason ?? "a check failed"}`
                    : result.anchor?.layerHeight !== receipt.batchIndex
                      ? `The state root is anchored, but this receipt carries the anchor of layer height ${result.anchor?.layerHeight}, not batch ${receipt.batchIndex}'s own. Its block and time are that batch's.`
                      : finality?.final
                        ? `Valid: batch ${receipt.batchIndex} of ${receipt.rollupId} is settled and final on ${CHAIN_ID}.`
                        : `Anchored and signed, but not final yet: batch ${receipt.batchIndex} can still be challenged. Do not treat it as settled.`}
                </div>
                <dl className="kv">
                  <dt>Mode</dt>
                  <dd>{result.mode === "chain" ? "against live chain state" : result.mode}</dd>
                  <dt>Signed by</dt>
                  <dd>{KNOWN[receipt.creator] ?? receipt.creator}</dd>
                  <dt>Algorithm</dt>
                  <dd>
                    {receipt.algorithm}
                    {result.signBytesVersion ? `, anchor message ${result.signBytesVersion}` : ""}
                  </dd>
                  <dt>State root</dt>
                  <dd>
                    <code>{short(receipt.stateRoot, 12)}</code>
                  </dd>
                  <dt>Main-chain block</dt>
                  <dd>{receipt.mainChainHeight.toLocaleString()}</dd>
                  <dt>Checked in</dt>
                  <dd>{took} ms, over the node's websocket</dd>
                </dl>
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
