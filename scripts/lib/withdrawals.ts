/** Every withdrawal a qledger-v1 rollup committed, recomputed by replaying recorded chain data. */
import { QledgerLedger, executeQledger, type QledgerWithdrawal } from "@qorechain/rdk";
import { toEntry, type ReplayVector } from "./replay.ts";

export interface BatchWithdrawals {
  batchIndex: number;
  withdrawals: QledgerWithdrawal[];
}

export function withdrawalsByBatch(v: ReplayVector): BatchWithdrawals[] {
  const env = { chainId: v.chainId, rollupId: v.rollupId };
  const ledger = new QledgerLedger();
  const bySeq = new Map(v.entries.map((e) => [e.sequence, e]));
  const out: BatchWithdrawals[] = [];
  for (const b of [...v.batches].sort((x, y) => x.batchIndex - y.batchIndex)) {
    const entries = [];
    for (let s = b.inboxStart + 1; s <= b.inboxEnd; s++) {
      const e = bySeq.get(s);
      if (!e) throw new Error(`missing inbox entry ${s} for batch ${b.batchIndex}`);
      entries.push(toEntry(e));
    }
    const r = executeQledger(env, ledger, entries);
    if (r.withdrawals.length > 0) out.push({ batchIndex: b.batchIndex, withdrawals: r.withdrawals });
  }
  return out;
}
