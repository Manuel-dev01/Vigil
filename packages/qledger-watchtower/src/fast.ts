/**
 * Read a batch straight from the transaction that submitted it, so the
 * watchtower can judge it the moment its block commits (pushed over the
 * websocket, see follow.ts) instead of waiting for its next REST poll.
 *
 * The published roots come from the tx's own `MsgSubmitBatch`, decoded with the
 * RDK's registry. The start of the inbox range comes from the chain's
 * `rdk_inbox_consumed` event in the same tx. What is decoded here is only used
 * to decide whether to challenge: the challenge is still checked with
 * `checkQledgerFraud`, and the regular pass re-reads every batch from REST.
 */
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { base64ToBytes, bytesToHex, createRdkRegistry } from "@qorechain/rdk";
import type { LiveBatch } from "./tracker.ts";

const registry = createRdkRegistry();
const SUBMIT_BATCH = "/qorechain.rdk.v1.MsgSubmitBatch";

/** CometBFT's flattened tx events: `"<type>.<key>"` → values, one per occurrence. */
export type TxEventMap = Record<string, string[]>;

interface SubmitBatch {
  rollupId: string;
  batchIndex: bigint | number | string;
  prevStateRoot: Uint8Array;
  stateRoot: Uint8Array;
  withdrawalsRoot: Uint8Array;
  dataHash: Uint8Array;
  inboxEnd: bigint | number | string;
}

const hex = (b: Uint8Array | undefined): string => (b && b.length ? bytesToHex(b).toLowerCase() : "");

/**
 * Every batch `rollupId` received in this tx, as published. A batch whose
 * inbox start the events do not give is left out (the regular pass reads it).
 */
export function batchesFromTx(txBase64: string, events: TxEventMap, rollupId: string): LiveBatch[] {
  const starts = new Map<number, number>();
  const ids = events["rdk_inbox_consumed.rollup_id"] ?? [];
  const idx = events["rdk_inbox_consumed.batch_index"] ?? [];
  const from = events["rdk_inbox_consumed.inbox_start"] ?? [];
  ids.forEach((id, i) => {
    if (id === rollupId && idx[i] !== undefined && from[i] !== undefined) starts.set(Number(idx[i]), Number(from[i]));
  });

  const tx = decodeTxRaw(base64ToBytes(txBase64));
  const out: LiveBatch[] = [];
  for (const any of tx.body.messages) {
    if (any.typeUrl !== SUBMIT_BATCH) continue;
    const m = registry.decode(any) as SubmitBatch;
    if (m.rollupId !== rollupId) continue;
    const batchIndex = Number(m.batchIndex);
    const inboxStart = starts.get(batchIndex);
    if (inboxStart === undefined) continue;
    out.push({
      batchIndex,
      inboxStart,
      inboxEnd: Number(m.inboxEnd),
      prevStateRoot: hex(m.prevStateRoot),
      stateRoot: hex(m.stateRoot),
      withdrawalsRoot: hex(m.withdrawalsRoot),
      dataHash: hex(m.dataHash),
      status: "submitted",
      submittedAt: 0,
    });
  }
  return out;
}

/** The inbox sequences this tx posted to `rollupId` (from its `rdk_data_posted` events). */
export function postsFromEvents(events: TxEventMap, rollupId: string): number[] {
  const ids = events["rdk_data_posted.rollup_id"] ?? [];
  const seqs = events["rdk_data_posted.sequence"] ?? [];
  return ids.flatMap((id, i) => (id === rollupId && seqs[i] !== undefined ? [Number(seqs[i])] : []));
}
