/**
 * The pure core of the watchtower: re-execute one qledger-v1 batch from its
 * parent state and the inbox entries it consumed, compare every field it
 * published, and build a fraud proof the chain will accept when they differ.
 *
 * Every hash, tree and proof format comes from @qorechain/rdk; nothing here is
 * hand-rolled. No network access.
 */
import {
  QledgerLedger,
  buildQledgerFraudProof,
  bytesToHex,
  checkQledgerFraud,
  executeQledger,
  inboxRangeHash,
  qledgerAccumulate,
  type QledgerEntry,
  type QledgerResult,
} from "@qorechain/rdk";

export interface RollupEnv {
  chainId: string;
  rollupId: string;
}

/** What a batch published (hex, any case, no 0x needed). */
export interface PublishedBatch {
  batchIndex: number;
  inboxStart: number;
  inboxEnd: number;
  prevStateRoot: string;
  stateRoot: string;
  withdrawalsRoot: string;
  dataHash: string;
}

export type Field = "prevStateRoot" | "stateRoot" | "withdrawalsRoot" | "dataHash" | "inboxAccumulator";

export interface BatchVerdict {
  batchIndex: number;
  valid: boolean;
  /** Fields where the published value differs from re-execution. */
  mismatches: Field[];
  /** What an honest batch over the same inputs would have published. */
  honest: { stateRoot: string; withdrawalsRoot: string; dataHash: string; withdrawals: number; paid: QledgerResult["withdrawals"] };
  /** The state after the honest execution: the parent of the next honest batch. */
  next: QledgerLedger;
}

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const norm = (s: string): string => s.toLowerCase().replace(/^0x/, "");

/**
 * Re-execute `entries` (inbox positions inboxStart+1 .. inboxEnd) on a copy of
 * `parent` and compare with what the batch published. `accFrom`/`accTo` are the
 * chain's inbox accumulators at inboxStart and inboxEnd.
 */
export function checkBatch(
  env: RollupEnv,
  parent: QledgerLedger,
  accFrom: string,
  accTo: string,
  entries: QledgerEntry[],
  batch: PublishedBatch,
): BatchVerdict {
  if (entries.length !== batch.inboxEnd - batch.inboxStart) {
    throw new Error(`batch ${batch.batchIndex}: have ${entries.length} entries for range ${batch.inboxStart}..${batch.inboxEnd}`);
  }
  const mismatches: Field[] = [];
  if (hex(parent.root()) !== norm(batch.prevStateRoot)) mismatches.push("prevStateRoot");

  const acc = qledgerAccumulate({ ...env, from: batch.inboxStart, accFrom, entries });
  if (hex(acc) !== norm(accTo)) mismatches.push("inboxAccumulator");

  const dataHash = hex(inboxRangeHash({ ...env, from: batch.inboxStart, to: batch.inboxEnd, accFrom, accTo }));
  if (dataHash !== norm(batch.dataHash)) mismatches.push("dataHash");

  const next = parent.clone();
  const r: QledgerResult = executeQledger(env, next, entries);
  if (hex(r.stateRoot) !== norm(batch.stateRoot)) mismatches.push("stateRoot");
  if (hex(r.withdrawalsRoot) !== norm(batch.withdrawalsRoot)) mismatches.push("withdrawalsRoot");

  return {
    batchIndex: batch.batchIndex,
    valid: mismatches.length === 0,
    mismatches,
    honest: { stateRoot: hex(r.stateRoot), withdrawalsRoot: hex(r.withdrawalsRoot), dataHash, withdrawals: r.withdrawals.length, paid: r.withdrawals },
    next,
  };
}

export interface Challenge {
  batchIndex: number;
  proof: Uint8Array;
  /** The chain's own decision rule, run locally: true means the challenge wins. */
  wins: boolean;
}

/**
 * Build the fraud proof for a batch and decide it exactly as the chain would
 * (`checkQledgerFraud`). Never send a challenge whose `wins` is false: the chain
 * would answer error 51 and the fee would be wasted.
 */
export function buildChallenge(
  env: RollupEnv,
  parent: QledgerLedger,
  accFrom: string,
  entries: QledgerEntry[],
  batch: PublishedBatch,
): Challenge {
  const { proof } = buildQledgerFraudProof(env, parent, accFrom, entries);
  const wins = checkQledgerFraud(
    env,
    {
      inboxStart: batch.inboxStart,
      inboxEnd: batch.inboxEnd,
      dataHash: norm(batch.dataHash),
      prevStateRoot: norm(batch.prevStateRoot),
      stateRoot: norm(batch.stateRoot),
      withdrawalsRoot: norm(batch.withdrawalsRoot),
    },
    proof,
  );
  return { batchIndex: batch.batchIndex, proof, wins };
}
