/**
 * Receipts for batches the chain no longer keeps.
 *
 * QoreChain may delete a finalized batch's record after
 * `finalized_batch_retention_blocks` (432,000 blocks on testnet). From then on
 * the RDK's `verifySettlementReceipt` stops at "batch N not found on chain",
 * even though the anchor that carries the batch's state root and the creator's
 * ML-DSA-87 signature stays on chain.
 *
 * This module re-runs, against live chain state, every check that does not need
 * the batch record: the rollup's layer, the anchor and each of its fields, the
 * creator's key as the node reports it, the chain binding and the signature over
 * the anchor message the chain verified. It runs only once it has shown the
 * record was pruned: the batch is missing, later batches exist, and the anchor
 * is older than the retention window. It also looks for an upheld fraud proof
 * against the creator's batch at that index. A missing record that fails any of
 * those tests is not treated as pruned (and so never as final).
 */
import {
  anchorSignBytesVersionFor,
  verifySettlementReceipt,
  type AnchorView,
  type RdkClient,
  type ReceiptVerification,
  type SettlementReceipt,
} from "@qorechain/rdk";
import { isNotFound } from "./config.ts";
import { receiptProblem } from "./receipt.ts";

/** QoreChain's testnet value, used only if the params query fails. */
const DEFAULT_RETENTION_BLOCKS = 432_000;

export interface Pruning {
  /** Blocks the chain keeps a finalized batch for. */
  retentionBlocks: number;
  /** The newest batch index the chain still reports. */
  latestBatch: number;
  /** The chain's height when checked. */
  headHeight: number;
}

/** A check the Verify page lists, by key. */
export type CheckKey = keyof ReceiptVerification["checks"] | "ownAnchor" | "final";

export interface PrunedVerification extends ReceiptVerification {
  pruned: Pruning;
  /** The check that failed, when `valid` is false. */
  failed?: CheckKey;
  /** Blocks between the anchor and the head, once the anchor was matched. */
  ageBlocks?: number;
  /** An upheld fraud proof against the creator's batch at this index, if the chain's tx index holds one. */
  fraud?: { tx: string; height: number };
  /** False if the fraud search could not run. */
  fraudSearched: boolean;
}

async function pruningContext(rdk: RdkClient, rollupId: string): Promise<Pruning> {
  const rest = rdk.rest;
  const [latest, headHeight, retentionBlocks] = await Promise.all([
    rest.getLatestBatch(rollupId),
    rest.getLatestHeight(),
    rest
      .getParams()
      .then((p) => p.finalizedBatchRetentionBlocks ?? DEFAULT_RETENTION_BLOCKS)
      .catch(() => DEFAULT_RETENTION_BLOCKS),
  ]);
  return { retentionBlocks, latestBatch: latest.batchIndex, headHeight };
}

/**
 * Whether batch `i` of `rollupId` is gone from chain state while later batches
 * remain. Undefined if the batch still exists, if `i` is past the newest batch,
 * or if the chain could not be asked (any error other than a 404).
 */
export async function prunedBatch(rdk: RdkClient, rollupId: string, i: number): Promise<Pruning | undefined> {
  try {
    await rdk.rest.getBatch(rollupId, i);
    return undefined;
  } catch (e) {
    if (!isNotFound(e)) return undefined;
  }
  const ctx = await pruningContext(rdk, rollupId);
  if (i >= ctx.latestBatch) return undefined;
  return ctx;
}

type FraudTx = { height?: string; txhash?: string; events?: { type: string; attributes?: { key: string; value: string }[] }[] };

/** An upheld fraud proof against `submitter`'s batch `i`, from the node's tx index. */
async function upheldFraud(rdk: RdkClient, rollupId: string, i: number, submitter: string): Promise<{ found?: { tx: string; height: number }; searched: boolean }> {
  try {
    const txs = (await rdk.rest.searchTxs(`rdk_fraud_upheld.rollup_id='${rollupId}'`)) as FraudTx[];
    for (const t of txs) {
      for (const ev of t.events ?? []) {
        if (ev.type !== "rdk_fraud_upheld") continue;
        const a = Object.fromEntries((ev.attributes ?? []).map((x) => [x.key, x.value]));
        if (a["rollup_id"] === rollupId && Number(a["batch_index"]) === i && a["submitter"] === submitter) {
          return { found: { tx: t.txhash ?? "", height: Number(t.height ?? 0) }, searched: true };
        }
      }
    }
    return { searched: true };
  } catch {
    return { searched: false };
  }
}

export interface MissingBatch {
  /** True only when pruning explains the missing record: later batches exist and its own anchor is past the retention window. */
  pruned: boolean;
  /** Pruned, and the node's index shows no upheld fraud proof against the creator's batch at this index. */
  final: boolean;
  /** In words, why (or why not). */
  reason: string;
  ageBlocks?: number;
  retentionBlocks: number;
  fraud?: { tx: string; height: number };
}

/**
 * What a missing batch record means, given the batch's own anchor (layer height `i`), if any: the
 * same age and fraud tests the pruned receipt check uses. Only finalized records are pruned, so a
 * record that is missing for any other reason is not final.
 */
export async function explainMissingBatch(rdk: RdkClient, rollupId: string, i: number, anchor: AnchorView | undefined, creator: string): Promise<MissingBatch> {
  const ctx = await pruningContext(rdk, rollupId);
  const base = { retentionBlocks: ctx.retentionBlocks };
  if (i >= ctx.latestBatch) return { ...base, pruned: false, final: false, reason: `the chain has no record of batch ${i}, and no later batch either` };
  if (!anchor) return { ...base, pruned: false, final: false, reason: `the chain has no record of batch ${i} and no anchor of its own, so pruning cannot explain it` };
  const ageBlocks = ctx.headHeight - anchor.mainChainHeight;
  if (ageBlocks < ctx.retentionBlocks) {
    return { ...base, ageBlocks, pruned: false, final: false, reason: `batch ${i}'s record is missing, but its anchor is only ${ageBlocks.toLocaleString()} blocks old, younger than the ${ctx.retentionBlocks.toLocaleString()}-block retention window` };
  }
  const f = await upheldFraud(rdk, rollupId, i, creator);
  if (f.found) return { ...base, ageBlocks, pruned: true, final: false, fraud: f.found, reason: `a fraud proof against the creator's batch ${i} was upheld at block ${f.found.height.toLocaleString()}` };
  if (!f.searched) return { ...base, ageBlocks, pruned: true, final: false, reason: "the node's transaction index could not be searched for fraud proofs, so finality cannot be confirmed" };
  return {
    ...base,
    ageBlocks,
    pruned: true,
    final: true,
    reason: `its record was pruned (its anchor is ${ageBlocks.toLocaleString()} blocks old, past the ${ctx.retentionBlocks.toLocaleString()}-block window), which the chain does only to finalized batches, and no fraud proof against it was upheld`,
  };
}

const NO_CHECKS = (): ReceiptVerification["checks"] => ({
  rollupLayerBinding: false,
  batchStateRoot: false,
  anchorOnChain: false,
  creatorAuthority: false,
  pqcSignature: false,
  chainBinding: false,
});

function anchorMismatch(r: SettlementReceipt, a: AnchorView): string | undefined {
  const fields: [string, unknown, unknown][] = [
    ["validatorSetHash", r.validatorSetHash, a.validatorSetHash],
    ["mainChainHeight", r.mainChainHeight, a.mainChainHeight],
    ["anchoredAt", r.anchoredAt, a.anchoredAt],
    ["transactionCount", r.transactionCount, a.transactionCount],
    ["compressedStateProof", (r.compressedStateProof ?? "").toLowerCase(), a.compressedStateProof.toLowerCase()],
  ];
  for (const [name, claimed, onChain] of fields) {
    if (claimed !== onChain) return `receipt's ${name} ${JSON.stringify(claimed)} does not match the chain's anchor (${JSON.stringify(onChain)})`;
  }
  return undefined;
}

/**
 * Verify `r` for a batch whose record the chain has pruned. `valid` means every
 * check that can still run passed; `checks.batchStateRoot` stays false because
 * no batch record is left to read. When `valid` is false, `failed` names the
 * check that failed.
 */
export async function verifyPrunedReceipt(rdk: RdkClient, r: SettlementReceipt, pruned: Pruning): Promise<PrunedVerification> {
  const rest = rdk.rest;
  const checks = NO_CHECKS();
  let fraudSearched = false;
  let fraud: { tx: string; height: number } | undefined;
  let ageBlocks: number | undefined;
  const done = (failed?: CheckKey, reason?: string, anchor?: AnchorView, signBytesVersion?: ReceiptVerification["signBytesVersion"]): PrunedVerification => ({
    valid: reason === undefined,
    mode: "chain",
    checks,
    pruned,
    fraudSearched,
    ...(failed ? { failed } : {}),
    ...(fraud ? { fraud } : {}),
    ...(ageBlocks !== undefined ? { ageBlocks } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(anchor ? { anchor } : {}),
    ...(signBytesVersion ? { signBytesVersion } : {}),
  });

  const schema = receiptProblem(r);
  if (schema) return done("rollupLayerBinding", schema);

  const rollup = await rest.getRollup(r.rollupId);
  checks.rollupLayerBinding = !!rollup.layerId && rollup.layerId === r.layerId;
  if (!checks.rollupLayerBinding) return done("rollupLayerBinding", `rollup "${r.rollupId}" is anchored to layer "${rollup.layerId || "(none)"}", not "${r.layerId}"`);

  const anchors = await rest.getAnchors(r.layerId);
  const matched = anchors.find((a) => a.stateRoot === r.stateRoot && a.layerHeight === r.layerHeight && a.pqcSignature === r.pqcSignature);
  if (!matched) return done("anchorOnChain", "no anchor on chain matches this receipt: it is fabricated or superseded");
  const mismatch = anchorMismatch(r, matched);
  if (mismatch) return done("anchorOnChain", mismatch, matched);
  checks.anchorOnChain = true;
  // With the record gone, only the anchor's layer height ties the receipt to its batch number.
  if (matched.layerHeight !== r.batchIndex) {
    return done("ownAnchor", `the receipt carries the anchor of layer height ${matched.layerHeight}; with batch ${r.batchIndex}'s record pruned, only its own anchor (layer height ${r.batchIndex}) can stand in for it`, matched);
  }
  // Its own anchor was written with the batch, over the batch's root: the receipt's batch root must be that root.
  if (r.batchStateRoot !== matched.stateRoot) return done("batchStateRoot", "the receipt's batchStateRoot is not the root its own anchor carries", matched);

  // A pruned record must be older than the retention window; a younger missing batch is not explained by pruning.
  ageBlocks = pruned.headHeight - matched.mainChainHeight;
  if (ageBlocks < pruned.retentionBlocks) {
    return done("batchStateRoot", `batch ${r.batchIndex}'s record is missing, but its anchor is only ${ageBlocks.toLocaleString()} blocks old, younger than the ${pruned.retentionBlocks.toLocaleString()}-block retention window`, matched);
  }

  if (r.creator !== rollup.creator) return done("creatorAuthority", `receipt names creator "${r.creator}" but the chain says the rollup's creator is "${rollup.creator}"`, matched);
  const key = (await rest.getPqcAccount(rollup.creator)).publicKey;
  checks.creatorAuthority = key !== "";
  if (!checks.creatorAuthority) return done("creatorAuthority", `no post-quantum key is registered for creator ${rollup.creator}`, matched);

  const chainId = rdk.network.chainId;
  if (r.chainId && r.chainId !== chainId) return done("chainBinding", `receipt is for chain "${r.chainId}" but this page reads "${chainId}"`, matched);
  checks.chainBinding = true;

  // The RDK's signature-only mode, fed the chain's own anchor fields and the
  // key the node reports for the creator. The anchor message form is the one in
  // force at the anchor's height, as in the full check.
  const version = anchorSignBytesVersionFor(matched.mainChainHeight, rdk.network.anchorSignV2Height);
  const fromChain: SettlementReceipt = {
    ...r,
    chainId,
    layerId: matched.layerId,
    layerHeight: matched.layerHeight,
    stateRoot: matched.stateRoot,
    validatorSetHash: matched.validatorSetHash,
    mainChainHeight: matched.mainChainHeight,
    anchoredAt: matched.anchoredAt,
    pqcSignature: matched.pqcSignature,
    transactionCount: matched.transactionCount,
    compressedStateProof: matched.compressedStateProof,
  };
  const sig = await verifySettlementReceipt(fromChain, { creatorPublicKey: key });
  checks.pqcSignature = sig.checks.pqcSignature && sig.signBytesVersion === version;
  if (!checks.pqcSignature) {
    return done("pqcSignature", `the ML-DSA-87 anchor signature did not verify against the creator's registered key (checked as ${version}, for an anchor at height ${matched.mainChainHeight})`, matched, version);
  }

  const f = await upheldFraud(rdk, r.rollupId, r.batchIndex, rollup.creator);
  fraudSearched = f.searched;
  fraud = f.found;
  if (fraud) return done("final", `a fraud proof against the creator's batch ${r.batchIndex} was upheld at block ${fraud.height}`, matched, version);
  return done(undefined, undefined, matched, version);
}

/**
 * A receipt for a pruned batch, built from its own anchor (layer height equal
 * to the batch index). The chain writes that anchor in the same transaction as
 * the batch, over the batch's state root, so `batchStateRoot` is the anchor's
 * root. Throws if the batch was never anchored.
 */
export async function receiptFromOwnAnchor(rdk: RdkClient, rollupId: string, i: number): Promise<SettlementReceipt> {
  const rollup = await rdk.rest.getRollup(rollupId);
  const own = (await rdk.rest.getAnchors(rollup.layerId)).find((a) => a.layerHeight === i);
  if (!own) throw new Error(`the chain has pruned batch ${i}'s record and holds no anchor for it: it was never anchored, so it has no settlement receipt`);
  return {
    version: 2,
    chainId: rdk.network.chainId,
    rollupId,
    layerId: rollup.layerId,
    batchIndex: i,
    creator: rollup.creator,
    algorithm: "ML-DSA-87",
    stateRoot: own.stateRoot,
    layerHeight: own.layerHeight,
    validatorSetHash: own.validatorSetHash,
    mainChainHeight: own.mainChainHeight,
    anchoredAt: own.anchoredAt,
    pqcSignature: own.pqcSignature,
    batchStateRoot: own.stateRoot,
    transactionCount: own.transactionCount,
    compressedStateProof: own.compressedStateProof,
  };
}
