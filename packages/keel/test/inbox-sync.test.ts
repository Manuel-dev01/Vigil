/**
 * Keel over the inbox reader, against vigil-pay-1 as the chain served it on
 * 24 Nov 2026 (22 batches, 24 entries; no network): replay, restart from the
 * archive after the chain has pruned the entries, batch records the chain has
 * pruned, the pending entries, and planning each recorded batch again.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RestError, bytesToHex, type BatchView, type InboxView, type ParamsView, type PostedDataView, type RestClient, type RollupView } from "@qorechain/rdk";
import { EMPTY_ACC, InboxReader, openInboxReader, readArchiveFile } from "@vigil/core/inbox";
import { fixtureSource, loadFixture } from "../../core/test/fixture-source.ts";
import { planBatch, type PlanRest } from "../src/plan.ts";
import { emptyState, type LedgerState } from "../src/snapshot.ts";
import { syncFrom, withPending, type ChainView } from "../src/sync.ts";

const fx = loadFixture("vigil-pay-1");
const env = { chainId: fx.chainId, rollupId: fx.rollupId };
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
const batches = [...fx.batches].sort((a, b) => a.batchIndex - b.batchIndex);
const last = batches.at(-1)!;
const accAt = (s: number) => (s === 0 ? EMPTY_ACC : fx.postedData[String(s)]!.inboxAcc);

/** The chain's batch records (all, or those `keep` allows: the rest read as pruned), entries through `reader`. */
function view(reader: InboxReader, keep: (b: BatchView) => boolean = () => true, edit: (b: BatchView) => BatchView = (b) => b): ChainView {
  const held = batches.filter(keep).map(edit);
  const byIndex = new Map(held.map((b) => [b.batchIndex, b]));
  return {
    latestBatch: async () => held.at(-1),
    batch: async (i) => byIndex.get(i),
    entries: (from, to, rangeHash) => reader.entries(from, to, rangeHash ? { rangeHash } : {}),
    firstBatchFrom: async (i) => held.find((b) => b.batchIndex >= i),
  };
}
const stateAfter = async (i: number): Promise<LedgerState> =>
  (await syncFrom(view(new InboxReader(env, fixtureSource(fx)), (b) => b.batchIndex <= i), env, emptyState())).state;

describe("keel sync over the inbox reader", () => {
  it("replays every vigil-pay-1 batch from recorded chain data", async () => {
    const src = fixtureSource(fx);
    const r = await syncFrom(view(new InboxReader(env, src)), env, emptyState());
    expect(r.replayed).toBe(batches.length);
    expect(r.blocked).toBeUndefined();
    expect(hex(r.state.ledger.root())).toBe(last.stateRoot);
    expect(r.state.inboxEnd).toBe(fx.inbox.headSequence);
    // Each entry read once: one commitment each, one block per height, one event read per deposit.
    expect(src.calls).toMatchObject({ postedData: fx.inbox.headSequence, block: Object.keys(fx.blocks).length, deposits: 2 });
  });

  it("matches the committed archive, and rebuilds from it after the chain has pruned the entries", async () => {
    const committed = readArchiveFile(resolve(import.meta.dirname, "../../../data/inbox/vigil-pay-1.jsonl"));
    expect(committed.problem).toBeUndefined();
    expect(committed.rows.length).toBeGreaterThanOrEqual(fx.inbox.headSequence);
    for (let s = 1; s <= fx.inbox.headSequence; s++) expect(committed.rows[s - 1]!.acc).toBe(accAt(s));

    // A fresh volume, later: the chain holds only the newest commitment and no old block.
    const dir = mkdtempSync(join(tmpdir(), "keel-"));
    const seed = join(dir, "seed.jsonl");
    writeFileSync(seed, committed.rows.slice(0, fx.inbox.headSequence).map((r) => JSON.stringify(r) + "\n").join(""));
    const pruned = fixtureSource(fx, { prune: (s) => s < fx.inbox.headSequence, blocksGone: true });
    const reader = openInboxReader(env, { archivePath: join(dir, "keel", "inbox.jsonl"), seeds: [seed], source: pruned });
    const r = await syncFrom(view(reader), env, emptyState());
    expect(hex(r.state.ledger.root())).toBe(last.stateRoot);
    expect(r.replayed).toBe(batches.length);
    expect(pruned.calls).toMatchObject({ postedData: 1, block: 0, deposits: 0 });
    // The volume's own archive now holds everything, confirmed.
    expect(readArchiveFile(join(dir, "keel", "inbox.jsonl")).rows).toHaveLength(fx.inbox.headSequence);
  });

  it("cannot rebuild once the chain has pruned the entries and there is no archive", async () => {
    const pruned = fixtureSource(fx, { prune: (s) => s < fx.inbox.headSequence, blocksGone: true });
    await expect(syncFrom(view(new InboxReader(env, pruned)), env, emptyState())).rejects.toThrow(/no longer held by the chain/);
  });

  it("passes over batch records the chain has pruned, checked against the first one it still holds", async () => {
    const seen: number[] = [];
    const r = await syncFrom(view(new InboxReader(env, fixtureSource(fx)), (b) => b.batchIndex >= 10), env, emptyState(), (b) => seen.push(b.batchIndex));
    expect(r.pruned).toEqual({ fromBatchIndex: 0, toBatchIndex: 9 });
    expect(seen).toEqual(batches.filter((b) => b.batchIndex >= 10).map((b) => b.batchIndex));
    expect(hex(r.state.ledger.root())).toBe(last.stateRoot);
  });

  it("refuses to pass over pruned records when the entries do not lead to the next record's parent", async () => {
    const wrong = (b: BatchView) => (b.batchIndex === 10 ? { ...b, prevStateRoot: "ab".repeat(32) } : b);
    await expect(syncFrom(view(new InboxReader(env, fixtureSource(fx)), (b) => b.batchIndex >= 10, wrong), env, emptyState())).rejects.toThrow(
      /batches 0..9 are pruned and the inbox entries 1..10 do not lead to batch 10's parent state/,
    );
  });

  it("keeps a snapshot whose own batch record the chain has pruned", async () => {
    const at12 = await stateAfter(12);
    const r = await syncFrom(view(new InboxReader(env, fixtureSource(fx)), (b) => b.batchIndex >= 13), env, at12);
    expect(r.rolledBack).toBeUndefined();
    expect(r.replayed).toBe(batches.length - 13);
    expect(hex(r.state.ledger.root())).toBe(last.stateRoot);
  });

  it("applies the entries not yet batched on top of the batched state", async () => {
    const at20 = await stateAfter(20);
    const b21 = batches[21]!;
    const rest = { getInbox: async () => ({ headSequence: b21.inboxEnd, consumedSequence: b21.inboxStart, consumedAcc: accAt(b21.inboxStart) }) } as unknown as RestClient;
    const p = await withPending(rest, new InboxReader(env, fixtureSource(fx)), env, at20);
    expect(p.pendingEntries).toBe(b21.inboxEnd - b21.inboxStart);
    expect(hex(p.ledger.root())).toBe(b21.stateRoot);
  });
});

/** The chain as it stood just before batch `b` was submitted. */
function planRestBefore(b: BatchView): PlanRest {
  const prev = batches.find((x) => x.batchIndex === b.batchIndex - 1);
  const inbox = (end?: number | bigint): InboxView => ({
    rollupId: env.rollupId,
    sequencing: "based",
    headSequence: b.inboxEnd,
    headAcc: accAt(b.inboxEnd),
    consumedSequence: b.inboxStart,
    consumedAcc: accAt(b.inboxStart),
    rangeEnd: Number(end ?? b.inboxEnd),
    rangeDataHash: Number(end ?? b.inboxEnd) === b.inboxEnd ? b.dataHash : "",
  });
  return {
    getRollup: async () => ({ rollupId: env.rollupId, executionVm: "qledger-v1" }) as RollupView,
    getParams: async () => ({ minSubmitterBond: "1000000000" }) as ParamsView,
    getSubmitterBond: async () => ({ amount: "1000000000", lastSubmitTime: 0, unbondAfter: 0, pending: 0 }),
    getInbox: async (_r: string, end?: number | bigint) => inbox(end),
    getPostedData: async (_r: string, s: number | bigint) => fx.postedData[String(s)] as unknown as PostedDataView,
    getLatestHeight: async () => fx.postedData[String(b.inboxEnd)]!.height + 1,
    getLatestBatch: async () => {
      if (!prev) throw new RestError("not found", 404);
      return prev;
    },
  };
}

describe("keel planner over the inbox reader", () => {
  it("plans every recorded vigil-pay-1 batch exactly as it was submitted", async () => {
    const reader = new InboxReader(env, fixtureSource(fx));
    let state = emptyState();
    for (const b of batches) {
      const plan = await planBatch(planRestBefore(b), reader, { ...env, submitter: "qor1submitter", ledger: state.ledger });
      expect(Number(plan.input.batchIndex)).toBe(b.batchIndex);
      expect(hex(plan.input.prevStateRoot)).toBe(b.prevStateRoot);
      expect(hex(plan.input.stateRoot)).toBe(b.stateRoot);
      expect(hex(plan.input.dataHash)).toBe(b.dataHash);
      expect(hex(plan.input.withdrawalsRoot)).toBe(b.withdrawalsRoot);
      expect(Number(plan.input.txCount)).toBe(b.txCount);
      expect(Number(plan.input.inboxEnd)).toBe(b.inboxEnd);
      state = { ledger: plan.ledger, batchIndex: b.batchIndex, inboxEnd: b.inboxEnd };
    }
  });

  it("refuses entries that do not hash to the chain's inbox range commitment", async () => {
    const b = batches[5]!;
    const rest = planRestBefore(b);
    const lying: PlanRest = { ...rest, getInbox: async (r: string, end?: number | bigint) => ({ ...(await rest.getInbox(r, end)), rangeDataHash: "cd".repeat(32) }) };
    const at4 = await stateAfter(4);
    await expect(planBatch(lying, new InboxReader(env, fixtureSource(fx)), { ...env, submitter: "qor1submitter", ledger: at4.ledger })).rejects.toThrow(/inbox range commitment/);
  });
});
