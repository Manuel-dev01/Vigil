import { useEffect, useRef, useState } from "react";
import { buildSettlementReceipt, verifySettlementReceipt, type RdkClient, type ReceiptVerification, type SettlementReceipt } from "@qorechain/rdk";
import { chain, isNotFound } from "../chain.ts";
import { CHAIN_ID, KNOWN, NODE_HOST, REPO, ROLLUP, short, utcStamp } from "../config.ts";
import { RECEIPT_VERIFIER, checkInEvm, evmCovers, type EvmCheck } from "../evm.ts";
import { keyPin, type KeyPin } from "../keys.ts";
import { prunedBatch, receiptFromOwnAnchor, verifyPrunedReceipt, type CheckKey, type PrunedVerification } from "../pruned.ts";
import { parseReceipt, receiptProblem } from "../receipt.ts";
import { Ext, Mark, type Tone } from "../ui.tsx";

type Verification = ReceiptVerification & Partial<Omit<PrunedVerification, keyof ReceiptVerification>>;

/** The checks in the order the RDK runs them, so the first one that is false is the one that failed. */
const CHECKS: { key: keyof ReceiptVerification["checks"]; what: string; why: string }[] = [
  { key: "rollupLayerBinding", what: "Rollup and layer belong together", why: "The node says this rollup settles to the receipt's layer." },
  { key: "batchStateRoot", what: "The chain's batch carries this state root", why: "Read from the batch record, as the node reports it." },
  { key: "anchorOnChain", what: "A matching anchor exists on chain", why: "State root, layer height, signature, main-chain height and time all match an anchor the node reports." },
  {
    key: "creatorAuthority",
    what: "The signing key came from the chain's PQ key registry, as reported by the node",
    why: "The creator's ML-DSA-87 public key is read from the registry through the node, not taken from the receipt.",
  },
  { key: "chainBinding", what: "The receipt names this chain", why: `The receipt says ${CHAIN_ID}, the chain that was queried.` },
  { key: "pqcSignature", what: "ML-DSA-87 signature verifies", why: "Checked in this browser against that key, over the chain's canonical anchor message." },
];
const RDK_ORDER = CHECKS.map((c) => c.key);

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

/** Why no receipt could be built for batch `i`, in words a visitor can act on. */
async function whyNoReceipt(rdk: RdkClient, i: number, e: unknown): Promise<string> {
  const raw = String(e instanceof Error ? e.message : e);
  try {
    const latest = await rdk.rest.getLatestBatch(ROLLUP);
    if (i > latest.batchIndex) return `There is no batch ${i} yet: the newest batch of ${ROLLUP} is ${latest.batchIndex}.`;
    const batch = await rdk.rest.getBatch(ROLLUP, i).catch((x: unknown) => (isNotFound(x) ? undefined : Promise.reject(x)));
    if (!batch) return `The chain holds no record of batch ${i} and no anchor for it, so it has no settlement receipt.`;
    const rollup = await rdk.rest.getRollup(ROLLUP);
    const anchors = await rdk.rest.getAnchors(rollup.layerId);
    if (!anchors.some((a) => a.layerHeight === i)) {
      if (anchors.some((a) => a.layerHeight > i) || batch.status !== "submitted") {
        return `Batch ${i} has no ML-DSA-87 anchor, and never will: it was submitted by the standby sequencer or another bonded submitter, which do not anchor (only the creator's key signs anchors). So it has no settlement receipt. The batch itself is ${batch.status}.`;
      }
      return `Batch ${i} is not anchored yet. If the creator's sequencer submitted it, its anchor appears with it; if the standby did, it will have no anchor and no receipt.`;
    }
  } catch {
    // fall through to the node's own words
  }
  return `No receipt for batch ${i}: ${raw}`;
}

const batchFromHash = (): number | undefined => {
  const m = /[?&]batch=(\d+)/.exec(location.hash);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
};

function flipStateRoot(r: SettlementReceipt): SettlementReceipt {
  const s = r.stateRoot;
  return { ...r, stateRoot: (s[0] === "0" ? "1" : "0") + s.slice(1) };
}

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

interface Row {
  key: string;
  what: string;
  why: string;
  tone: Tone;
  label: string;
}

export function VerifyView() {
  const [batchIndex, setBatchIndex] = useState<number>(batchFromHash() ?? 0);
  const [latest, setLatest] = useState<number>();
  const [receipt, setReceipt] = useState<SettlementReceipt>();
  const [pasted, setPasted] = useState("");
  const [result, setResult] = useState<Verification>();
  const [pin, setPin] = useState<KeyPin | { error: string }>();
  const [finality, setFinality] = useState<{ final: boolean; status: string; until?: number }>();
  const [took, setTook] = useState<number>();
  const [evm, setEvm] = useState<EvmCheck | { error: string }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useRef(0);

  useEffect(() => {
    void chain()
      .then(({ rdk }) => rdk.rest.getLatestBatch(ROLLUP))
      .then((b) => {
        setLatest(b.batchIndex);
        if (batchFromHash() === undefined) setBatchIndex(b.batchIndex);
      })
      .catch(() => undefined);
  }, []);

  // A link like #/verify?batch=7 builds that batch's receipt, on load and whenever the hash changes.
  useEffect(() => {
    const fromHash = () => {
      const b = batchFromHash();
      if (b === undefined) return;
      setBatchIndex(b);
      void build(b);
    };
    fromHash();
    addEventListener("hashchange", fromHash);
    return () => removeEventListener("hashchange", fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset(message: string) {
    setBusy(message);
    setError(undefined);
    setResult(undefined);
    setFinality(undefined);
    setEvm(undefined);
    setPin(undefined);
  }

  async function verify(r: SettlementReceipt) {
    const me = ++run.current;
    const current = () => me === run.current;
    reset("Verifying against the chain…");
    try {
      const problem = receiptProblem(r);
      if (problem) throw new Error(problem);
      // The contract check runs alongside; it never decides the verdict, only adds to it.
      const evmCheck = evmCovers(r) ? checkInEvm(r).catch((e: unknown) => ({ error: errText(e) })) : Promise.resolve(undefined);
      const { rdk } = await chain();
      const t0 = performance.now();
      // The creator's key as the node reports it, against the one pinned in this page.
      const pinP = rdk.rest
        .getRollup(r.rollupId)
        .then((rollup) => rdk.rest.getPqcAccount(rollup.creator).then((a) => (a.publicKey ? keyPin(rollup.creator, a.publicKey) : { error: "no key registered" })))
        .catch((e: unknown) => ({ error: errText(e) }));
      let v: Verification = await verifySettlementReceipt(r, { client: rdk });
      // The chain may prune finalized batch records after a retention window. If
      // that is why the batch read failed, re-run every check that does not
      // need the record (pruned.ts) instead of stopping there.
      const pruned = !v.valid && v.checks.rollupLayerBinding && !v.checks.batchStateRoot ? await prunedBatch(rdk, r.rollupId, r.batchIndex) : undefined;
      if (pruned) v = await verifyPrunedReceipt(rdk, r, pruned);
      else if (!v.valid) v = { ...v, failed: RDK_ORDER.find((k) => !v.checks[k]) ?? "rollupLayerBinding" };
      if (!current()) return;
      setTook(Math.round(performance.now() - t0));
      if (pruned) {
        const p = v as PrunedVerification;
        setFinality({ final: p.valid && p.fraudSearched, status: "pruned" });
      } else {
        // A receipt's anchor exists from the moment the batch is submitted. The
        // batch is settled only once its challenge window has closed.
        const [batch, rollup] = await Promise.all([rdk.rest.getBatch(r.rollupId, r.batchIndex).catch(() => undefined), rdk.rest.getRollup(r.rollupId)]);
        if (!current()) return;
        setFinality(
          batch
            ? {
                final: batch.status === "finalized",
                status: batch.status,
                ...(batch.submittedTime && rollup.challengeWindowSec ? { until: batch.submittedTime + rollup.challengeWindowSec } : {}),
              }
            : { final: false, status: "not found" },
        );
      }
      setResult(v);
      const [p, e] = await Promise.all([pinP, evmCheck]);
      if (!current()) return;
      setPin(p);
      setEvm(e);
    } catch (e) {
      if (current()) setError(errText(e));
    } finally {
      if (current()) setBusy(undefined);
    }
  }

  async function build(i: number) {
    if (!Number.isSafeInteger(i) || i < 0) {
      setError("Enter a batch number (0 or more).");
      return;
    }
    const me = ++run.current;
    reset(`Building the receipt for batch ${i} from the chain…`);
    try {
      const { rdk } = await chain();
      let r: SettlementReceipt;
      try {
        r = await buildOwnReceipt(rdk, i);
      } catch (e) {
        // A pruned batch has no record to build from; its own anchor remains.
        if (!(await prunedBatch(rdk, ROLLUP, i).catch(() => undefined))) throw new Error(await whyNoReceipt(rdk, i, e));
        r = await receiptFromOwnAnchor(rdk, ROLLUP, i);
      }
      if (me !== run.current) return;
      setReceipt(r);
      setPasted(JSON.stringify(r, null, 2));
      await verify(r);
    } catch (e) {
      if (me !== run.current) return;
      setError(errText(e));
      setBusy(undefined);
    }
  }

  async function verifyPasted() {
    const p = parseReceipt(pasted);
    if (!p.ok) {
      run.current++;
      setResult(undefined);
      setBusy(undefined);
      setError(p.error);
      return;
    }
    setReceipt(p.receipt);
    await verify(p.receipt);
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

  const rows: Row[] = [];
  if (result && receipt) {
    const failed: CheckKey | undefined = result.valid ? undefined : (result.failed ?? RDK_ORDER.find((k) => !result.checks[k]));
    const order: CheckKey[] = [...RDK_ORDER, "ownAnchor", "final"];
    const failedAt = failed ? order.indexOf(failed) : -1;
    const toneOf = (key: CheckKey, ok: boolean): [Tone, string] => {
      if (ok) return ["ok", "passed"];
      if (key === failed) return ["bad", "failed"];
      if (failedAt >= 0 && order.indexOf(key) > failedAt) return ["skip", "not reached"];
      return ["bad", "failed"];
    };
    for (const c of CHECKS) {
      if (c.key === "batchStateRoot" && result.pruned) {
        const why = `The chain keeps finalized batches for ${result.pruned.retentionBlocks.toLocaleString()} blocks, then may delete the record${result.ageBlocks !== undefined ? `; this batch's anchor is ${result.ageBlocks.toLocaleString()} blocks old` : ""}. Its own anchor still carries its state root.`;
        rows.push(
          failed === "batchStateRoot"
            ? { key: c.key, what: "The batch record is missing", why: result.reason ?? why, tone: "bad", label: "failed" }
            : failedAt >= 0 && failedAt < order.indexOf("batchStateRoot")
              ? { key: c.key, what: "The batch record has been pruned", why, tone: "skip", label: "not reached" }
              : { key: c.key, what: "The batch record has been pruned", why, tone: "skip", label: "no longer on chain" },
        );
        continue;
      }
      const [tone, label] = toneOf(c.key, result.checks[c.key]);
      rows.push({ key: c.key, what: c.what, why: c.why, tone, label });
      if (c.key === "creatorAuthority") {
        const pinNotReached = failedAt >= 0 && failedAt <= order.indexOf("creatorAuthority");
        rows.push(
          pinNotReached
            ? { key: "pin", what: "The creator's key is the one pinned in this page", why: "Compared once the key check above has passed.", tone: "skip", label: "not reached" }
            : !pin
            ? { key: "pin", what: "The creator's key is the one pinned in this page", why: "Comparing the key's SHA-256 with the one pinned in the page's source…", tone: "wait", label: "pending" }
            : "error" in pin
              ? { key: "pin", what: "The creator's key is the one pinned in this page", why: `The key could not be read to compare: ${pin.error}.`, tone: "skip", label: "not checked" }
              : pin.status === "match"
                ? { key: "pin", what: "The creator's key is the one pinned in this page", why: `SHA-256 ${short(pin.sha256, 8)}, the same as pinned in the page's source, so a node reporting another key would be caught.`, tone: "ok", label: "passed" }
                : pin.status === "mismatch"
                  ? { key: "pin", what: "The creator's key differs from the one pinned in this page", why: `The node reports a key with SHA-256 ${short(pin.sha256, 8)}; the page pins ${short(pin.pinned ?? "", 8)}. Either the creator changed keys or the node is wrong.`, tone: "bad", label: "failed" }
                  : { key: "pin", what: "No key is pinned for this creator", why: "This receipt's rollup is not one this page pins a key for.", tone: "skip", label: "not checked" },
        );
      }
    }
    const own = !!result.anchor && result.anchor.layerHeight === receipt.batchIndex;
    const [ownTone, ownLabel] = toneOf("ownAnchor", own);
    rows.push({
      key: "ownAnchor",
      what: "It is this batch's own anchor",
      why: result.anchor
        ? `The matched anchor is layer height ${result.anchor.layerHeight}, made at block ${result.anchor.mainChainHeight.toLocaleString()}.`
        : "The anchor's layer height equals the batch index, so its block and time are this batch's.",
      tone: ownTone,
      label: ownLabel,
    });
    const finalWhy = result.pruned
      ? result.fraud
        ? `A fraud proof against the creator's batch ${receipt.batchIndex} was upheld at block ${result.fraud.height.toLocaleString()}.`
        : result.fraudSearched
          ? `Only finalized batches are pruned, and the node's index shows no upheld fraud proof against the creator's batch ${receipt.batchIndex}.`
          : "The batch record is gone and the node's transaction index could not be searched for fraud proofs, so finality cannot be confirmed here."
      : finality?.final
        ? "Its challenge window has closed, so no fraud proof can remove it."
        : finality?.until
          ? `It is ${finality.status} and can still be challenged until ${utcStamp(finality.until * 1000)}.`
          : `The node reports it as ${finality?.status ?? "unknown"}.`;
    const [finalTone, finalLabel]: [Tone, string] =
      failed && failed !== "final"
        ? ["skip", "not reached"]
        : failed === "final"
          ? ["bad", "failed"]
          : finality?.final
            ? ["ok", "passed"]
            : result.pruned && !result.fraudSearched
              ? ["skip", "not checked"]
              : ["wait", "pending"];
    rows.push({ key: "final", what: "The batch is final", why: finalLabel === "not reached" ? "Checked once the receipt itself verifies." : finalWhy, tone: finalTone, label: finalLabel });
  }

  const pinMismatch = !!pin && !("error" in pin) && pin.status === "mismatch";
  const ownAnchor = !!result?.anchor && !!receipt && result.anchor.layerHeight === receipt.batchIndex;
  const verdict =
    result && receipt
      ? !result.valid
        ? { cls: "bad", text: `Not valid: ${result.reason ?? "a check failed"}` }
        : !ownAnchor
          ? { cls: "bad", text: `The state root is anchored, but this receipt carries the anchor of layer height ${result.anchor?.layerHeight}, not batch ${receipt.batchIndex}'s own. Its block and time are that batch's.` }
          : pinMismatch
            ? { cls: "bad", text: "The signature verifies, but against a creator key that differs from the one pinned in this page. Treat this receipt as unconfirmed." }
            : result.pruned
              ? finality?.final
                ? { cls: "ok", text: `Valid according to ${NODE_HOST}: batch ${receipt.batchIndex} of ${receipt.rollupId} settled on ${CHAIN_ID}. The chain has since pruned the batch record; its anchor and the creator's key were read from the node and the ML-DSA-87 signature was verified in this browser.` }
                : { cls: "warn", text: "Anchored and signed, but the batch record is pruned and its finality could not be confirmed here." }
              : finality?.final
                ? { cls: "ok", text: `Valid: batch ${receipt.batchIndex} of ${receipt.rollupId} is settled and final on ${CHAIN_ID}, according to ${NODE_HOST}. The ML-DSA-87 signature was verified in this browser.` }
                : { cls: "warn", text: `Anchored and signed, but not final yet: batch ${receipt.batchIndex} can still be challenged. Do not treat it as settled.` }
      : undefined;

  return (
    <>
      <h1>Verify a settlement receipt</h1>
      <p className="lede">
        A settlement receipt says "the chain settled this rollup at this state root, signed by the rollup's ML-DSA-87 key". Here it is checked the
        strict way: every field is re-read from {NODE_HOST} (the node's answers are not proven), and the post-quantum signature is verified in your
        browser against the creator's key, which is also compared with the one pinned in this page. A receipt on its own proves nothing; only a check
        like this does.
      </p>

      <div className="cols">
        <div>
          <section className="panel">
            <h2>1. Get a receipt</h2>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void build(batchIndex);
              }}
            >
              <label htmlFor="batch">Batch</label>
              <input
                id="batch"
                type="number"
                min={0}
                max={latest}
                step={1}
                value={Number.isFinite(batchIndex) ? batchIndex : ""}
                onChange={(e) => setBatchIndex(e.target.value === "" ? NaN : Number(e.target.value))}
                style={{ width: 90 }}
              />
              <button className="primary" disabled={!!busy}>
                Build from chain and verify
              </button>
              {latest !== undefined && <span className="note">batches 0 to {latest}</span>}
            </form>
            <p className="note" style={{ marginTop: 10 }}>
              Or paste a receipt someone gave you (for example a <code>batch-N.json</code> from <code>receipts/vigil-pay-1/</code> in the repo):
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
            {result && receipt && verdict && (
              <>
                <ul className="checks">
                  {rows.map((c) => (
                    <li key={c.key}>
                      <Mark tone={c.tone} label={c.label} />
                      <span>
                        <span className="what">{c.what}</span>
                        {c.label === "not reached" && <span className="note"> (not reached)</span>}
                        <br />
                        <span className="why">{c.why}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className={`verdict ${verdict.cls}`}>{verdict.text}</div>
                <dl className="kv">
                  <dt>Mode</dt>
                  <dd>
                    {result.pruned ? `against the state ${NODE_HOST} reports (batch record pruned; anchor checked)` : result.mode === "chain" ? `against the state ${NODE_HOST} reports` : result.mode}
                  </dd>
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
                  <dd>{Number(receipt.mainChainHeight).toLocaleString()}</dd>
                  <dt>Checked in</dt>
                  <dd>{took} ms, over the node's websocket</dd>
                </dl>
              </>
            )}
          </section>
          {result && receipt && RECEIPT_VERIFIER && evmCovers(receipt) && (
            <section className="panel" aria-live="polite">
              <h2>
                3. In Solidity <small>QoreChain EVM, a second opinion</small>
              </h2>
              {!evm && <p className="empty">Asking the contract…</p>}
              {evm && "error" in evm && <p className="err">The EVM check did not run: {evm.error}</p>}
              {evm && !("error" in evm) && (
                <ul className="checks">
                  <li>
                    <Mark tone={evm.valid ? "ok" : "bad"} />
                    <span>
                      <span className="what">
                        The contract says: {evm.result} (layer height {receipt.layerHeight})
                      </span>
                      <br />
                      <span className="why">
                        It rebuilt the anchor message, read the creator's key through the pqcKeyStatus precompile and verified the ML-DSA-87
                        signature with pqcVerify ({evm.ms} ms, a free eth_call to the node operator's EVM endpoint, whose answer is not proven).
                      </span>
                    </span>
                  </li>
                  <li>
                    <Mark
                      tone={evm.record.attested ? (evm.record.sameRoot && !evm.record.conflicted ? "ok" : "bad") : "skip"}
                      label={evm.record.attested ? (evm.record.sameRoot && !evm.record.conflicted ? "passed" : "failed") : "not yet"}
                    />
                    <span>
                      <span className="what">
                        {!evm.record.attested
                          ? "Not on the contract's record yet"
                          : evm.record.conflicted
                            ? "Conflicted on the contract's record"
                            : evm.record.sameRoot
                              ? `On the contract's record since EVM block ${evm.record.block.toLocaleString()}`
                              : "The contract's record shows another root for this height"}
                      </span>
                      <br />
                      <span className="why">
                        Anyone can submit an anchor; the contract records the first valid root for each layer height, and marks a height
                        conflicted for good if the creator's key ever signed two roots for it. Other contracts read the record instead of
                        re-checking the signature.
                      </span>
                    </span>
                  </li>
                </ul>
              )}
              <p className="note" style={{ marginTop: 10 }}>
                Contract <code>{short(RECEIPT_VERIFIER.address, 8)}</code> (<Ext href={`${REPO}/blob/main/contracts/src/SettlementReceiptVerifier.sol`}>source</Ext>), no owner,
                fixed to {ROLLUP} and its creator. EVM code cannot read the rollup module, so it cannot tell whether a batch is final; that comes from
                the checks above.
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
