/**
 * Leaving vigil-pay-1 without Vigil (docs/ESCAPE_HATCH.md): pure decisions, kept apart from the CLIs that
 * read the chain (balance.ts) so they can be tested on recorded data.
 *
 * - Which withdrawals the chain has already executed, from its `rdk_withdrawal_executed` events.
 * - For one L1 address, every withdrawal a replayed batch committed to it, and whether it is paid, can be
 *   executed now by anyone, is waiting for its batch to be final, or went with a rejected batch.
 * - Which batches that list cannot cover, and why.
 */
import type { QledgerWithdrawal } from "@qorechain/rdk";

export interface BatchWithdrawals {
  batchIndex: number;
  /** The batch's status as the chain reports it: submitted, finalized or rejected. */
  status: string;
  /** Unix seconds of the submission block (0 when the node does not serve it). */
  submittedTime: number;
  withdrawals: QledgerWithdrawal[];
}

export type WithdrawalState = "paid" | "claimable" | "waiting" | "rejected";

export interface WithdrawalRow {
  batchIndex: number;
  index: bigint;
  amount: bigint;
  recipient: string;
  state: WithdrawalState;
  /** When a waiting withdrawal's batch can be final (Unix seconds), if the batch's time is known. */
  finalFrom?: number;
}

const key = (batchIndex: number | bigint | string, index: number | bigint | string): string => `${String(batchIndex)}:${String(index)}`;

interface RawTx {
  code?: number;
  events?: { type?: string; attributes?: { key?: string; value?: string }[] }[];
}

/**
 * `batch:withdrawal` keys of every withdrawal of `rollupId` the chain executed, from transactions found by
 * the event query `rdk_withdrawal_executed.rollup_id='<rollup>'`. Failed transactions are ignored.
 */
export function executedWithdrawals(txs: readonly unknown[], rollupId: string): Set<string> {
  const out = new Set<string>();
  for (const t of txs as RawTx[]) {
    if (t?.code) continue;
    for (const e of t?.events ?? []) {
      if (e.type !== "rdk_withdrawal_executed") continue;
      const a = Object.fromEntries((e.attributes ?? []).map((x) => [x.key ?? "", x.value ?? ""]));
      if (a["rollup_id"] !== rollupId || !/^\d+$/.test(a["batch_index"] ?? "") || !/^\d+$/.test(a["withdrawal_index"] ?? "")) continue;
      out.add(key(a["batch_index"]!, a["withdrawal_index"]!));
    }
  }
  return out;
}

/** Every withdrawal to `recipient` in `batches`, with what can be done about it. */
export function withdrawalsTo(recipient: string, batches: readonly BatchWithdrawals[], executed: ReadonlySet<string>, windowSec: number): WithdrawalRow[] {
  const rows: WithdrawalRow[] = [];
  for (const b of batches) {
    for (const w of b.withdrawals) {
      if (w.recipient !== recipient) continue;
      const row: WithdrawalRow = { batchIndex: b.batchIndex, index: w.index, amount: w.amount, recipient: w.recipient, state: "waiting" };
      if (executed.has(key(b.batchIndex, w.index))) row.state = "paid";
      else if (b.status === "rejected") row.state = "rejected";
      else if (b.status === "finalized") row.state = "claimable";
      else if (b.submittedTime > 0) row.finalFrom = b.submittedTime + windowSec;
      rows.push(row);
    }
  }
  return rows;
}

/** What to do next for a row, in one line. */
export function nextStep(r: WithdrawalRow, rollupId: string): string {
  switch (r.state) {
    case "paid":
      return "paid on L1; nothing to do";
    case "rejected":
      return "its batch was rejected by a fraud proof; the withdrawal comes back in the honest batch that replaces it";
    case "claimable":
      return `final: anyone can execute it now (claim.ts --batch ${r.batchIndex}${rollupId === "vigil-pay-1" ? "" : ` --rollup ${rollupId}`})`;
    case "waiting":
      return r.finalFrom !== undefined
        ? `waiting for its batch to be final (its challenge window ends ${new Date(r.finalFrom * 1000).toISOString().replace(".000Z", "Z")})`
        : "waiting for its batch to be final";
  }
}

/**
 * The batches whose withdrawals a replay could not list, one line each: those taken from a local snapshot,
 * and those whose records the chain has pruned (the replay applies their entries in one go, without the
 * batch-by-batch results that carry withdrawals).
 */
export function unlistedBatches(o: { snapshotBatch?: number | undefined; pruned?: { fromBatchIndex: number; toBatchIndex: number } | undefined }): string[] {
  const out: string[] = [];
  if (o.snapshotBatch !== undefined && o.snapshotBatch > 0) {
    out.push(`withdrawals in batches up to ${o.snapshotBatch} are in the snapshot, not listed; pass --data <empty dir> to replay from the first batch`);
  }
  if (o.pruned) {
    const { fromBatchIndex: a, toBatchIndex: b } = o.pruned;
    out.push(`withdrawals in batch${a === b ? ` ${a} are` : `es ${a} to ${b} are`} not listed: the chain no longer holds ${a === b ? "that batch record" : "those batch records"}`);
  }
  return out;
}
