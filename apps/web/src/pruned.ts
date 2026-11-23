/**
 * Receipts for batches the chain no longer keeps.
 *
 * QoreChain deletes a finalized batch's record after
 * `finalized_batch_retention_blocks` (432,000 blocks, about 7 days on testnet).
 * From then on the RDK's `verifySettlementReceipt` stops at "batch N not found
 * on chain", even though the anchor that carries the batch's state root and the
 * creator's ML-DSA-87 signature stays on chain.
 *
 * This module re-runs, against live chain state, every check that does not need
 * the batch record: the rollup's layer, the anchor and each of its fields, the
 * creator's key from the PQ registry, the chain binding and the signature over
 * the anchor message the chain verified. It runs only once it has shown the
 * record was pruned: the batch is missing, later batches exist, and the anchor
 * is older than the retention window. It also looks for an upheld fraud proof
 * against the creator's batch at that index.
 */
import {
  anchorSignBytesVersionFor,
  receiptSchemaError,
  verifySettlementReceipt,
  type AnchorView,
  type RdkClient,
  type ReceiptVerification,
  type SettlementReceipt,
} from "@qorechain/rdk";

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

export interface PrunedVerification extends ReceiptVerification {
  pruned: Pruning;
  /** Blocks between the anchor and the head, once the anchor was matched. */
  ageBlocks?: number;
  /** An upheld fraud proof against the creator's batch at this index, if the chain's tx index holds one. */
  fraud?: { tx: string; height: number };
  /** False if the fraud search could not run. */
  fraudSearched: boolean;
}

/**
 * Whether batch `i` of `rollupId` is gone from chain state while later batches
 * remain. Undefined if the batch still exists, if `i` is past the newest batch,
 * or if the chain could not be asked (any error other than a 404).
 */
export async function prunedBatch(rdk: RdkClient, rollupId: string, i: number): Promise<Pruning | undefined> {
  const rest = rdk.rest;
  try {
    await rest.getBatch(rollupId, i);
    return undefined;
  } catch (e) {
    // The RDK's RestError carries the HTTP status (checked by shape, not instanceof, so a second copy of the RDK cannot break it).
    if ((e as { status?: unknown }).status !== 404) return undefined;
  }
  const [latest, headHeight, retentionBlocks] = await Promise.all([
    rest.getLatestBatch(rollupId),
    rest.getLatestHeight(),
    rest
      .getParams()
      .then((p) => p.finalizedBatchRetentionBlocks ?? DEFAULT_RETENTION_BLOCKS)
      .catch(() => DEFAULT_RETENTION_BLOCKS),
  ]);
  if (i >= latest.batchIndex) return undefined;
  return { retentionBlocks, latestBatch: latest.batchIndex, headHeight };
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

/**
 * Verify `r` for a batch whose record the chain has pruned. `valid` means every
 * check that can still run passed; `checks.batchStateRoot` stays false because
 * no batch record is left to read.
 */
export async function verifyPrunedReceipt(rdk: RdkClient, r: SettlementReceipt, pruned: Pruning): Promise<PrunedVerification> {
  const rest = rdk.rest;
  const checks = NO_CHECKS();
  let fraudSearched = false;
  let fraud: { tx: string; height: number } | undefined;
  let ageBlocks: number | undefined;
  const done = (reason?: string, anchor?: AnchorView, signBytesVersion?: ReceiptVerification["signBytesVersion"]): PrunedVerification => ({
    valid: reason === undefined,
    mode: "chain",
    checks,
    pruned,
    fraudSearched,
    ...(fraud ? { fraud } : {}),
    ...(ageBlocks !== undefined ? { ageBlocks } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(anchor ? { anchor } : {}),
    ...(signBytesVersion ? { signBytesVersion } : {}),
  });

  const schema = receiptSchemaError(r);
  if (schema) return done(schema);
  // With no batch record left, the receipt's two roots must at least agree with each other.
  if (r.batchStateRoot !== r.stateRoot) return done("the receipt's stateRoot and batchStateRoot differ");

  const rollup = await rest.getRollup(r.rollupId);
  checks.rollupLayerBinding = !!rollup.layerId && rollup.layerId === r.layerId;
  if (!checks.rollupLayerBinding) return done(`rollup "${r.rollupId}" is anchored to layer "${rollup.layerId || "(none)"}", not "${r.layerId}"`);

  const anchors = await rest.getAnchors(r.layerId);
  const matched = anchors.find((a) => a.stateRoot === r.stateRoot && a.layerHeight === r.layerHeight && a.pqcSignature === r.pqcSignature);
  if (!matched) return done("no anchor on chain matches this receipt: it is fabricated or superseded");
  const mismatch = anchorMismatch(r, matched);
  if (mismatch) return done(mismatch, matched);
  checks.anchorOnChain = true;
  // With the record gone, only the anchor's layer height ties the receipt to its batch number.
  if (matched.layerHeight !== r.batchIndex) {
    return done(`the receipt carries the anchor of layer height ${matched.layerHeight}; with batch ${r.batchIndex}'s record pruned, only its own anchor (layer height ${r.batchIndex}) can stand in for it`, matched);
  }

  // A pruned record must be older than the retention window; a younger missing batch is not explained by pruning.
  ageBlocks = pruned.headHeight - matched.mainChainHeight;
  if (ageBlocks < pruned.retentionBlocks) {
    return done(`batch ${r.batchIndex}'s record is missing, but its anchor is only ${ageBlocks.toLocaleString()} blocks old, younger than the ${pruned.retentionBlocks.toLocaleString()}-block retention window`, matched);
  }

  if (r.creator !== rollup.creator) return done(`receipt names creator "${r.creator}" but the chain says the rollup's creator is "${rollup.creator}"`, matched);
  const key = (await rest.getPqcAccount(rollup.creator)).publicKey;
  checks.creatorAuthority = key !== "";
  if (!checks.creatorAuthority) return done(`no post-quantum key is registered for creator ${rollup.creator}`, matched);

  const chainId = rdk.network.chainId;
  if (r.chainId && r.chainId !== chainId) return done(`receipt is for chain "${r.chainId}" but this page reads "${chainId}"`, matched);
  checks.chainBinding = true;

  // The RDK's signature-only mode, fed the chain's own anchor fields and the
  // key read from the chain's registry. The anchor message form is the one in
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
    return done(`the ML-DSA-87 anchor signature did not verify against the creator's registered key (checked as ${version}, for an anchor at height ${matched.mainChainHeight})`, matched, version);
  }

  const f = await upheldFraud(rdk, r.rollupId, r.batchIndex, rollup.creator);
  fraudSearched = f.searched;
  fraud = f.found;
  if (fraud) return done(`a fraud proof against the creator's batch ${r.batchIndex} was upheld at block ${fraud.height}`, matched, version);
  return done(undefined, matched, version);
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
