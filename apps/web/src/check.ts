/**
 * The Verify page's checks on one receipt, without the page: the RDK's `verifySettlementReceipt` against
 * the chain, the pruned-record path when pruning explains a missing batch record (pruned.ts), and the
 * batch's status. Kept apart from the view so tests run exactly what the page runs.
 */
import { verifySettlementReceipt, type RdkClient, type ReceiptVerification, type SettlementReceipt } from "@qorechain/rdk";
import { prunedBatch, verifyPrunedReceipt, type PrunedVerification } from "./pruned.ts";

export type Verification = ReceiptVerification & Partial<Omit<PrunedVerification, keyof ReceiptVerification>>;

export interface Finality {
  final: boolean;
  status: string;
  /** Unix seconds until which the batch can still be challenged, when known. */
  until?: number;
}

/** The RDK's checks in the order it runs them, so the first one that is false is the one that failed. */
export const RDK_ORDER: readonly (keyof ReceiptVerification["checks"])[] = [
  "rollupLayerBinding",
  "batchStateRoot",
  "anchorOnChain",
  "creatorAuthority",
  "chainBinding",
  "pqcSignature",
];

/**
 * Run every receipt check on `r` against the chain `rdk` reads. `ms` is how long the receipt checks took
 * (the status read after them is not counted). A receipt naming a rollup the chain does not know fails its
 * first check; it does not throw.
 */
export async function checkReceipt(rdk: RdkClient, r: SettlementReceipt): Promise<{ v: Verification; finality: Finality; ms: number }> {
  const t0 = performance.now();
  let v: Verification = await verifySettlementReceipt(r, { client: rdk });
  // The chain may prune finalized batch records after a retention window. If
  // that is why the batch read failed, re-run every check that does not
  // need the record (pruned.ts) instead of stopping there.
  const pruned = !v.valid && v.checks.rollupLayerBinding && !v.checks.batchStateRoot ? await prunedBatch(rdk, r.rollupId, r.batchIndex) : undefined;
  if (pruned) v = await verifyPrunedReceipt(rdk, r, pruned);
  else if (!v.valid) v = { ...v, failed: RDK_ORDER.find((k) => !v.checks[k]) ?? "rollupLayerBinding" };
  const ms = Math.round(performance.now() - t0);
  if (pruned) {
    const p = v as PrunedVerification;
    return { v, ms, finality: { final: p.valid && p.fraudSearched, status: "pruned" } };
  }
  // A receipt's anchor exists from the moment the batch is submitted. The
  // batch is settled only once its challenge window has closed.
  const [batch, rollup] = await Promise.all([rdk.rest.getBatch(r.rollupId, r.batchIndex).catch(() => undefined), rdk.rest.getRollup(r.rollupId).catch(() => undefined)]);
  const finality: Finality = batch
    ? {
        final: batch.status === "finalized",
        status: batch.status,
        ...(batch.submittedTime && rollup?.challengeWindowSec ? { until: batch.submittedTime + rollup.challengeWindowSec } : {}),
      }
    : { final: false, status: "not found" };
  return { v, ms, finality };
}
