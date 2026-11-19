/**
 * Keel's sync against recorded chain data (vigil-1's 29 batches, no network),
 * served through a fake `ChainView` that can be edited into the states an
 * upheld fraud challenge leaves behind: batches dropped, an index reused,
 * rejected records, and a batch that does not reproduce.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, executeQledger, type BatchView } from "@qorechain/rdk";
import { toEntry, type BatchFacts, type ReplayVector } from "../../../scripts/lib/replay.ts";
import { emptyState, type LedgerState } from "../src/snapshot.ts";
import { syncFrom, type ChainView } from "../src/sync.ts";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../test/vectors/replay-vigil-1.json"), "utf8"),
) as ReplayVector;
const env = { chainId: vector.chainId, rollupId: vector.rollupId };
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
const recorded = [...vector.batches].sort((a, b) => a.batchIndex - b.batchIndex);
const last = recorded.at(-1)!;
const bySeq = new Map(vector.entries.map((e) => [e.sequence, e]));
const entries = (from: number, to: number) => {
  const out = [];
  for (let s = from + 1; s <= to; s++) out.push(toEntry(bySeq.get(s)!));
  return out;
};

/** A chain holding exactly `batches` (by index); `latest` is the highest unless set. */
function chain(batches: BatchFacts[], latestIndex?: number): ChainView {
  const byIndex = new Map(batches.map((b) => [b.batchIndex, b as unknown as BatchView]));
  const top = latestIndex ?? Math.max(-1, ...batches.map((b) => b.batchIndex));
  return {
    latestBatch: async () => byIndex.get(top),
    batch: async (i) => byIndex.get(i),
    entries: async (from, to) => entries(from, to),
  };
}
const upTo = (i: number) => recorded.filter((b) => b.batchIndex <= i);
const tamper = (b: BatchFacts, status = b.status): BatchFacts => ({ ...b, status, stateRoot: "ab".repeat(32) });
const stateAfter = async (i: number): Promise<LedgerState> => (await syncFrom(chain(upTo(i)), env, emptyState())).state;

describe("keel sync", () => {
  it("replays every recorded batch from an empty ledger", async () => {
    const r = await syncFrom(chain(recorded), env, emptyState());
    expect(r.replayed).toBe(29);
    expect(r.state.batchIndex).toBe(28);
    expect(r.state.inboxEnd).toBe(last.inboxEnd);
    expect(hex(r.state.ledger.root())).toBe(last.stateRoot.toLowerCase());
    expect(r.rolledBack).toBeUndefined();
    expect(r.blocked).toBeUndefined();
  });

  it("picks up from a saved state and replays only what it missed", async () => {
    const r = await syncFrom(chain(recorded), env, await stateAfter(10));
    expect(r.replayed).toBe(18);
    expect(hex(r.state.ledger.root())).toBe(last.stateRoot.toLowerCase());
  });

  it("stops before a batch that does not reproduce, and never builds on it", async () => {
    const seen: number[] = [];
    // A fraudulent batch 15, and a batch 16 built on top of it.
    const bad = tamper(recorded[15]!);
    const on = { ...recorded[16]!, prevStateRoot: bad.stateRoot };
    const r = await syncFrom(chain([...upTo(14), bad, on]), env, emptyState(), (b) => seen.push(b.batchIndex));
    expect(r.blocked?.batchIndex).toBe(15);
    expect(r.blocked?.reason).toMatch(/does not reproduce/);
    expect(r.state.batchIndex).toBe(14);
    expect(hex(r.state.ledger.root())).toBe(recorded[14]!.stateRoot.toLowerCase());
    expect(seen.at(-1)).toBe(14);
  });

  it("reports a fraudulent batch that already finalized", async () => {
    const r = await syncFrom(chain([...upTo(14), tamper(recorded[15]!, "finalized")]), env, emptyState());
    expect(r.blocked).toMatchObject({ batchIndex: 15, status: "finalized" });
  });

  it("rolls back when the batches it followed were dropped by a challenge", async () => {
    const r = await syncFrom(chain(upTo(20)), env, await stateAfter(28));
    expect(r.rolledBack?.fromBatchIndex).toBe(28);
    expect(r.rolledBack?.reason).toMatch(/no longer has batch 28/);
    expect(r.state.batchIndex).toBe(20);
    expect(hex(r.state.ledger.root())).toBe(recorded[20]!.stateRoot.toLowerCase());
    expect(r.blocked).toBeUndefined();
  });

  it("rolls back and follows a different batch that reused its index", async () => {
    // After a rollback, the next submitter batches only 2 of batch 28's 3 entries.
    const parent = await stateAfter(27);
    const ledger = parent.ledger.clone();
    const end = last.inboxStart + 2;
    const res = executeQledger(env, ledger, entries(last.inboxStart, end));
    const reused: BatchFacts = { ...last, inboxEnd: end, txCount: 2, stateRoot: hex(res.stateRoot), withdrawalsRoot: hex(res.withdrawalsRoot) };
    const r = await syncFrom(chain([...upTo(27), reused]), env, await stateAfter(28));
    expect(r.rolledBack?.reason).toMatch(/not the one the local state followed/);
    expect(r.blocked).toBeUndefined();
    expect(r.state.batchIndex).toBe(28);
    expect(r.state.inboxEnd).toBe(end);
    expect(hex(r.state.ledger.root())).toBe(hex(res.stateRoot));
  });

  it("skips rejected records left at the top of the chain", async () => {
    const rejected = [recorded[27]!, recorded[28]!].map((b) => ({ ...tamper(b), status: "rejected" }));
    const fromEmpty = await syncFrom(chain([...upTo(26), ...rejected]), env, emptyState());
    expect(fromEmpty.state.batchIndex).toBe(26);
    expect(fromEmpty.blocked).toBeUndefined();
    const fromLast = await syncFrom(chain([...upTo(26), ...rejected]), env, await stateAfter(28));
    expect(fromLast.rolledBack?.reason).toMatch(/batch 28 was rejected/);
    expect(fromLast.state.batchIndex).toBe(26);
  });

  it("does nothing when the local state is already the chain's latest", async () => {
    const r = await syncFrom(chain(recorded), env, await stateAfter(28));
    expect(r).toMatchObject({ replayed: 0 });
    expect(r.rolledBack).toBeUndefined();
    expect(r.state.batchIndex).toBe(28);
  });
});
