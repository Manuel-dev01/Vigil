/**
 * Bring the local ledger up to the chain's latest batch, re-executing every
 * batch it has not seen and checking each published root. On a based rollup
 * any bonded submitter may post a batch, so Keel never assumes the latest
 * batch is its own.
 *
 * What an upheld fraud challenge does on QoreChain (seen live on
 * wicketgate-pay batch 2 and rdk-v328-e2e-mwd5v89d batch 4): the bad batch and
 * every later unfinalized batch are dropped, the inbox rolls back to the end
 * of the last good batch (`rdk_inbox_rolled_back`), and the next batch reuses
 * the dropped index. So:
 *
 * - **Rollback.** If the batch the local state ended on is gone, rejected or
 *   replaced, the local state is discarded and rebuilt from the chain.
 * - **Blocked.** A batch that does not reproduce is never built on. Sync stops
 *   at the batch before it and reports it, so the sequencer waits for the
 *   watchtower's challenge instead of crashing.
 */
import {
  EMPTY_INBOX_ACC,
  bytesToHex,
  executeQledger,
  fetchQledgerEntries,
  isRestNotFound,
  type BatchView,
  type QledgerEntry,
  type QledgerLedger,
  type QledgerResult,
  type RestClient,
} from "@qorechain/rdk";
import { emptyState, type LedgerState } from "./snapshot.ts";

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const norm = (h: string): string => h.replace(/^0x/, "").toLowerCase();

type Env = { chainId: string; rollupId: string };

/** The chain reads sync needs. `chainView` serves them from REST; tests serve recorded data. */
export interface ChainView {
  /** The batch the chain reports as latest, or undefined before the first batch. */
  latestBatch(): Promise<BatchView | undefined>;
  /** The batch at an index, or undefined if the chain has none there. */
  batch(index: number): Promise<BatchView | undefined>;
  /** The inbox entries after sequence `from` up to and including `to`, checked against the chain's accumulator. */
  entries(from: number, to: number): Promise<QledgerEntry[]>;
}

export function chainView(rest: RestClient, env: Env): ChainView {
  return {
    async latestBatch() {
      try {
        return await rest.getLatestBatch(env.rollupId);
      } catch (err) {
        if (isRestNotFound(err)) return undefined;
        throw err;
      }
    },
    async batch(index) {
      try {
        return await rest.getBatch(env.rollupId, index);
      } catch (err) {
        if (isRestNotFound(err)) return undefined;
        throw err;
      }
    },
    async entries(from, to) {
      const accFrom = from === 0 ? EMPTY_INBOX_ACC : (await rest.getPostedData(env.rollupId, from)).inboxAcc;
      return fetchQledgerEntries(rest, { ...env, from, to, accFrom });
    },
  };
}

export interface SyncResult {
  /** The state after the last chain batch that reproduces. */
  state: LedgerState;
  /** Batches re-executed in this call. */
  replayed: number;
  /** Set when the local state no longer matched the chain and was rebuilt from the first batch. */
  rolledBack?: { fromBatchIndex: number; reason: string };
  /** The first chain batch that does not reproduce. Nothing after it is applied. */
  blocked?: { batchIndex: number; status: string; reason: string };
}

/**
 * The latest batch that counts. Rejected records are skipped from the top,
 * in case the chain keeps one visible before its index is reused.
 */
async function canonicalLatest(view: ChainView): Promise<BatchView | undefined> {
  let b = await view.latestBatch();
  while (b && b.status === "rejected") {
    if (b.batchIndex === 0) return undefined;
    b = await view.batch(b.batchIndex - 1);
  }
  return b;
}

/** Why the local state is no longer on the chain, or undefined if it still is. */
async function divergence(view: ChainView, state: LedgerState): Promise<string | undefined> {
  if (state.batchIndex < 0) return undefined;
  const b = await view.batch(state.batchIndex);
  if (!b) return `the chain no longer has batch ${state.batchIndex}`;
  if (b.status === "rejected") return `batch ${state.batchIndex} was rejected`;
  if (norm(b.stateRoot) !== hex(state.ledger.root()) || b.inboxEnd !== state.inboxEnd) {
    return `batch ${state.batchIndex} on chain (state ${norm(b.stateRoot).slice(0, 12)}…, inbox end ${b.inboxEnd}) is not the one the local state followed`;
  }
  return undefined;
}

/** The sync logic over any `ChainView`. */
export async function syncFrom(
  view: ChainView,
  env: Env,
  start: LedgerState,
  onBatch?: (b: BatchView, result: QledgerResult) => void,
): Promise<SyncResult> {
  let state = start;
  let rolledBack: SyncResult["rolledBack"];
  const why = await divergence(view, state);
  if (why) {
    rolledBack = { fromBatchIndex: state.batchIndex, reason: why };
    state = emptyState();
  }

  const latest = await canonicalLatest(view);
  if (!latest) return { state, replayed: 0, ...(rolledBack && { rolledBack }) };
  if (latest.batchIndex < state.batchIndex) {
    // divergence() found our batch on chain, so this can only be a read racing a rollback; retry later.
    throw new Error(`the chain's latest batch is ${latest.batchIndex}, behind the local state (batch ${state.batchIndex}); retry`);
  }

  let ledger = state.ledger.clone();
  let { batchIndex, inboxEnd } = state;
  let replayed = 0;
  let blocked: SyncResult["blocked"];
  for (let i = state.batchIndex + 1; i <= latest.batchIndex; i++) {
    const b = i === latest.batchIndex ? latest : await view.batch(i);
    if (!b) throw new Error(`the chain has no batch ${i} below its latest (${latest.batchIndex}); retry`);
    if (b.status === "rejected") throw new Error(`batch ${i} is rejected but batch ${latest.batchIndex} after it is not; retry`);
    if (norm(b.prevStateRoot) !== hex(ledger.root()) || b.inboxStart !== inboxEnd) {
      blocked = {
        batchIndex: i,
        status: b.status,
        reason: `batch ${i} builds on state ${norm(b.prevStateRoot).slice(0, 12)}… from inbox ${b.inboxStart}, but batch ${batchIndex} ended at state ${hex(ledger.root()).slice(0, 12)}… and inbox ${inboxEnd}`,
      };
      break;
    }
    const trial = ledger.clone();
    const result = executeQledger(env, trial, await view.entries(b.inboxStart, b.inboxEnd));
    if (hex(result.stateRoot) !== norm(b.stateRoot) || hex(result.withdrawalsRoot) !== norm(b.withdrawalsRoot)) {
      blocked = {
        batchIndex: i,
        status: b.status,
        reason:
          `batch ${i} does not reproduce: chain state ${norm(b.stateRoot)} withdrawals ${norm(b.withdrawalsRoot)}, ` +
          `re-executed state ${hex(result.stateRoot)} withdrawals ${hex(result.withdrawalsRoot)}`,
      };
      break;
    }
    ledger = trial;
    batchIndex = b.batchIndex;
    inboxEnd = b.inboxEnd;
    replayed++;
    onBatch?.(b, result);
  }
  if (!blocked && hex(ledger.root()) !== norm(latest.stateRoot)) {
    throw new Error(`the local state ${hex(ledger.root())} does not match the latest batch root ${norm(latest.stateRoot)}`);
  }
  return { state: { ledger, batchIndex, inboxEnd }, replayed, ...(rolledBack && { rolledBack }), ...(blocked && { blocked }) };
}

/**
 * Returns the state after the chain's latest batch that reproduces. A batch
 * that does not reproduce is reported in `blocked`: that is a fraud case for
 * the watchtower, never something to build on.
 */
export async function syncLedger(
  rest: RestClient,
  env: Env,
  state: LedgerState,
  onBatch?: (b: BatchView, result: QledgerResult) => void,
): Promise<SyncResult> {
  return syncFrom(chainView(rest, env), env, state, onBatch);
}

/**
 * The ledger as it will be once the inbox entries not yet batched are applied:
 * what a new L2 transaction has to build on (its nonce and balance).
 */
export async function withPending(
  rest: RestClient,
  env: Env,
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
