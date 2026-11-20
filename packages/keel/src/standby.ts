/**
 * Standby: a second Keel, with its own bonded key, that batches only when the
 * primary has not.
 *
 * vigil-pay-1 is a based rollup: any account that bonds `min_submitter_bond`
 * may submit batches, so the creator's sequencer is not a single point of
 * failure. The standby watches the inbox. While the primary batches every entry
 * within a few blocks it does nothing. Once the oldest entry not yet batched has
 * waited `standbyBlocks` blocks, the primary is taken to be down and the standby
 * batches it.
 *
 * A standby that is not the rollup's creator cannot anchor (the chain accepts
 * anchors only under the creator's ML-DSA-87 key), so its batches settle
 * unanchored: they are re-executable and challengeable like any other, and their
 * withdrawals are paid once final, but they carry no settlement receipt.
 *
 * If both sequencers try the same batch index, the chain accepts the first and
 * refuses the second in delivery (the loser pays a fee). The block margin keeps
 * that rare.
 */

export interface StandbyInput {
  /** Latest block height. */
  tipHeight: number;
  /** Height at which the oldest inbox entry not yet batched was posted, or undefined when nothing waits. */
  oldestWaitingHeight: number | undefined;
  /** How many blocks an entry may wait before the standby acts. */
  standbyBlocks: number;
}

export interface StandbyDecision {
  due: boolean;
  /** Blocks the oldest waiting entry has waited (0 when nothing waits). */
  waited: number;
}

export function standbyDecision({ tipHeight, oldestWaitingHeight, standbyBlocks }: StandbyInput): StandbyDecision {
  if (!Number.isInteger(standbyBlocks) || standbyBlocks < 1) throw new Error(`standbyBlocks must be a positive integer, got ${standbyBlocks}`);
  if (oldestWaitingHeight === undefined) return { due: false, waited: 0 };
  const waited = Math.max(0, tipHeight - oldestWaitingHeight);
  return { due: waited >= standbyBlocks, waited };
}

/** Parse KEEL_STANDBY_BLOCKS / --standby-blocks: undefined (primary), or a positive whole number of blocks. */
export function parseStandbyBlocks(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "" || raw === "0") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new Error(`standby blocks must be a whole number from 1 to 100000, got "${raw}"`);
  return n;
}
