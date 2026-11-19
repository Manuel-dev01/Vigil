/**
 * Bring the local ledger up to the chain's latest batch, re-executing every
 * batch it has not seen and checking each published root. On a based rollup
 * any bonded submitter may post a batch, so Keel never assumes the latest
 * batch is its own.
 */
import {
  EMPTY_INBOX_ACC,
  bytesToHex,
  executeQledger,
  fetchQledgerEntries,
  isRestNotFound,
  type BatchView,
  type QledgerLedger,
  type QledgerResult,
  type RestClient,
} from "@qorechain/rdk";
import type { LedgerState } from "./snapshot.ts";

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const norm = (h: string): string => h.replace(/^0x/, "").toLowerCase();

export async function latestBatch(rest: RestClient, rollupId: string): Promise<BatchView | undefined> {
  try {
    return await rest.getLatestBatch(rollupId);
  } catch (err) {
    if (isRestNotFound(err)) return undefined;
    throw err;
  }
}

/**
 * Returns the state after the chain's latest batch. Throws, and so stops the
 * sequencer, when a published batch cannot be reproduced: that is a fraud
 * case for the watchtower, not something to build on.
 */
export async function syncLedger(
  rest: RestClient,
  env: { chainId: string; rollupId: string },
  state: LedgerState,
  onBatch?: (b: BatchView, result: QledgerResult) => void,
): Promise<{ state: LedgerState; replayed: number }> {
  const latest = await latestBatch(rest, env.rollupId);
  if (!latest) {
    if (state.batchIndex !== -1) {
      throw new Error(`the chain serves no batch for ${env.rollupId}, but the local state follows batch ${state.batchIndex}`);
    }
    return { state, replayed: 0 };
  }
  if (latest.batchIndex < state.batchIndex) {
    throw new Error(`the chain's latest batch is ${latest.batchIndex}, behind the local state (batch ${state.batchIndex}): was a batch rejected?`);
  }

  const ledger = state.ledger.clone();
  let { batchIndex, inboxEnd } = state;
  let replayed = 0;
  for (let i = state.batchIndex + 1; i <= latest.batchIndex; i++) {
    const b = i === latest.batchIndex ? latest : await rest.getBatch(env.rollupId, i);
    if (b.status === "rejected") throw new Error(`batch ${i} was rejected; the state needs a manual look`);
    if (norm(b.prevStateRoot) !== hex(ledger.root())) {
      throw new Error(`batch ${i} builds on ${norm(b.prevStateRoot)}, but the local state after batch ${batchIndex} is ${hex(ledger.root())}`);
    }
    if (b.inboxStart !== inboxEnd) {
      throw new Error(`batch ${i} starts after inbox entry ${b.inboxStart}, but the previous batch ended at ${inboxEnd}`);
    }
    const accFrom = b.inboxStart === 0 ? EMPTY_INBOX_ACC : (await rest.getPostedData(env.rollupId, b.inboxStart)).inboxAcc;
    const entries = await fetchQledgerEntries(rest, { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom });
    const result = executeQledger(env, ledger, entries);
    if (hex(result.stateRoot) !== norm(b.stateRoot) || hex(result.withdrawalsRoot) !== norm(b.withdrawalsRoot)) {
      throw new Error(
        `batch ${i} does not reproduce: chain state ${norm(b.stateRoot)} withdrawals ${norm(b.withdrawalsRoot)}, ` +
          `re-executed state ${hex(result.stateRoot)} withdrawals ${hex(result.withdrawalsRoot)}`,
      );
    }
    batchIndex = b.batchIndex;
    inboxEnd = b.inboxEnd;
    replayed++;
    onBatch?.(b, result);
  }
  if (hex(ledger.root()) !== norm(latest.stateRoot)) {
    throw new Error(`the local state ${hex(ledger.root())} does not match the latest batch root ${norm(latest.stateRoot)}`);
  }
  return { state: { ledger, batchIndex, inboxEnd }, replayed };
}

/**
 * The ledger as it will be once the inbox entries not yet batched are applied:
 * what a new L2 transaction has to build on (its nonce and balance).
 */
export async function withPending(
  rest: RestClient,
  env: { chainId: string; rollupId: string },
  batched: LedgerState,
): Promise<{ ledger: QledgerLedger; pendingEntries: number; head: number }> {
  const inbox = await rest.getInbox(env.rollupId);
  const ledger = batched.ledger.clone();
  if (inbox.headSequence <= inbox.consumedSequence) return { ledger, pendingEntries: 0, head: inbox.headSequence };
  if (inbox.consumedSequence !== batched.inboxEnd) {
    throw new Error(`the inbox was consumed to ${inbox.consumedSequence} but the local state ends at ${batched.inboxEnd}; sync first`);
  }
  const entries = await fetchQledgerEntries(rest, {
    ...env,
    from: inbox.consumedSequence,
    to: inbox.headSequence,
    accFrom: inbox.consumedAcc,
  });
  executeQledger(env, ledger, entries);
  return { ledger, pendingEntries: entries.length, head: inbox.headSequence };
}
