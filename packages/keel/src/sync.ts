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
 * - **Pruned records.** The chain drops a finalized batch's record after
 *   `finalized_batch_retention_blocks`. When records are missing below the
 *   first one the chain still holds, sync executes the inbox entries in between
 *   in one go (the state after an entry does not depend on how the entries were
 *   cut into batches) and checks the result against that batch's parent root.
 *
 * Inbox entries come from the `InboxReader` (@vigil/core/inbox): read by
 * sequence, checked against the chain's accumulator, from the service's archive
 * once the chain has pruned them.
 */
import {
  bytesToHex,
  executeQledger,
  isRestNotFound,
  type BatchView,
  type QledgerEntry,
  type QledgerLedger,
  type QledgerResult,
  type RestClient,
} from "@qorechain/rdk";
import type { InboxReader } from "@vigil/core/inbox";
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
  /**
   * The inbox entries after sequence `from` up to and including `to`, checked
   * against the chain's accumulator. `rangeHash` is the inbox commitment of a
   * batch covering exactly that range, when the caller has one.
   */
  entries(from: number, to: number, rangeHash?: string): Promise<QledgerEntry[]>;
  /** The first batch record at or after `index` that the chain still holds. Without it, pruned records are not skipped. */
  firstBatchFrom?(index: number): Promise<BatchView | undefined>;
}

export function chainView(rest: RestClient, env: Env, reader: InboxReader): ChainView {
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
    entries(from, to, rangeHash) {
      return reader.entries(from, to, rangeHash ? { rangeHash } : {});
    },
    async firstBatchFrom(index) {
      const page = await rest.listBatchesPage(env.rollupId, { startIndex: index, limit: 1 });
      const b = page.batches[0];
      return b && b.batchIndex >= index ? b : undefined;
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
  /** Batches whose records the chain had pruned, passed over by executing their entries in one go. */
  pruned?: { fromBatchIndex: number; toBatchIndex: number };
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

/**
 * The state after executing the inbox entries `state.inboxEnd+1 .. next.inboxStart` on `state`, if it is
 * `next`'s parent state; undefined if it is not.
 */
async function forwardTo(view: ChainView, env: Env, state: LedgerState, next: BatchView): Promise<LedgerState | undefined> {
  if (next.inboxStart < state.inboxEnd) return undefined;
  const ledger = state.ledger.clone();
  executeQledger(env, ledger, await view.entries(state.inboxEnd, next.inboxStart));
  if (hex(ledger.root()) !== norm(next.prevStateRoot)) return undefined;
  return { ledger, batchIndex: next.batchIndex - 1, inboxEnd: next.inboxStart };
}

/** Why the local state is no longer on the chain, or undefined if it still is. */
async function divergence(view: ChainView, env: Env, state: LedgerState): Promise<string | undefined> {
  if (state.batchIndex < 0) return undefined;
  const b = await view.batch(state.batchIndex);
  if (!b) {
    // A challenge drops a batch together with every batch after it; pruning drops old finalized
    // records only, so later ones remain. Then the local state must lead to the next one's parent.
    const next = await view.firstBatchFrom?.(state.batchIndex + 1);
    if (next && next.status !== "rejected" && (await forwardTo(view, env, state, next))) return undefined;
    return `the chain no longer has batch ${state.batchIndex}`;
  }
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
  const why = await divergence(view, env, state);
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
  let pruned: SyncResult["pruned"];
  for (let i = state.batchIndex + 1; i <= latest.batchIndex; i++) {
    let b = i === latest.batchIndex ? latest : await view.batch(i);
    if (!b && view.firstBatchFrom) {
      // Records the chain has pruned: pick up at the first one it still holds.
      const next = await view.firstBatchFrom(i);
      if (next && next.batchIndex > i && next.batchIndex <= latest.batchIndex && next.status !== "rejected") {
        const at = await forwardTo(view, env, { ledger, batchIndex, inboxEnd }, next);
        if (!at) {
          throw new Error(
            `batches ${i}..${next.batchIndex - 1} are pruned and the inbox entries ${inboxEnd + 1}..${next.inboxStart} do not lead to batch ${next.batchIndex}'s parent state`,
          );
        }
        ({ ledger, batchIndex, inboxEnd } = at);
        pruned = { fromBatchIndex: pruned?.fromBatchIndex ?? i, toBatchIndex: next.batchIndex - 1 };
        i = next.batchIndex;
        b = next;
      }
    }
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
    const result = executeQledger(env, trial, await view.entries(b.inboxStart, b.inboxEnd, b.dataHash));
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
  return { state: { ledger, batchIndex, inboxEnd }, replayed, ...(rolledBack && { rolledBack }), ...(blocked && { blocked }), ...(pruned && { pruned }) };
}

/**
 * Returns the state after the chain's latest batch that reproduces. A batch
 * that does not reproduce is reported in `blocked`: that is a fraud case for
 * the watchtower, never something to build on.
 */
export async function syncLedger(
  rest: RestClient,
  reader: InboxReader,
  env: Env,
  state: LedgerState,
  onBatch?: (b: BatchView, result: QledgerResult) => void,
): Promise<SyncResult> {
  return syncFrom(chainView(rest, env, reader), env, state, onBatch);
}

/**
 * The ledger as it will be once the inbox entries not yet batched are applied:
 * what a new L2 transaction has to build on (its nonce and balance).
 */
export async function withPending(
  rest: RestClient,
  reader: InboxReader,
  env: Env,
  batched: LedgerState,
): Promise<{ ledger: QledgerLedger; pendingEntries: number; head: number }> {
  const inbox = await rest.getInbox(env.rollupId);
  const ledger = batched.ledger.clone();
  if (inbox.headSequence <= inbox.consumedSequence) return { ledger, pendingEntries: 0, head: inbox.headSequence };
  if (inbox.consumedSequence !== batched.inboxEnd) {
    throw new Error(`the inbox was consumed to ${inbox.consumedSequence} but the local state ends at ${batched.inboxEnd}; sync first`);
  }
  const entries = await reader.entries(inbox.consumedSequence, inbox.headSequence);
  const acc = await reader.accAt(inbox.consumedSequence);
  if (acc !== undefined && acc !== norm(inbox.consumedAcc)) {
    throw new Error(`the inbox's consumed accumulator ${norm(inbox.consumedAcc).slice(0, 12)}… is not the one the entries were read from`);
  }
  executeQledger(env, ledger, entries);
  return { ledger, pendingEntries: entries.length, head: inbox.headSequence };
}
