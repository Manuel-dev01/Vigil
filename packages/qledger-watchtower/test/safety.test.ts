/**
 * Safety of the watchtower's judgements, challenges and attestations (24 Nov 2026 review):
 * - a verdict belongs to every published field of a batch, not just (index, state root);
 * - exits are attested only when every unfinalized ancestor is valid too;
 * - a torn last archive line is repaired, damage elsewhere is refused;
 * - a batch is given up only on what the chain shows;
 * - a hung broadcast cannot block the send lane.
 */
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Challenger,
  InboxArchive,
  OUT_OF_GAS,
  RollupTracker,
  attestableBatches,
  backoffMs,
  batchKey,
  challengeResultDecision,
  currentBatchDecision,
  type ArchivedEntry,
  type BatchSource,
  type ChallengeTransport,
  type Judgement,
  type LiveBatch,
} from "../src/index.ts";

interface Vector {
  chainId: string;
  rollupId: string;
  inboxAcc: Record<string, string>;
  entries: { sequence: number; height: number; poster: string; payloadHex: string }[];
  batches: (Omit<LiveBatch, "submittedAt"> & { txCount: number })[];
}

const VECTORS = resolve(import.meta.dirname, "../../../test/vectors");
const vectors: Vector[] = readdirSync(VECTORS)
  .filter((f) => f.startsWith("replay-") && f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(VECTORS, f), "utf8")) as Vector);

const entriesOf = (v: Vector) => async (from: number, to: number): Promise<ArchivedEntry[]> =>
  v.entries.filter((e) => e.sequence > from && e.sequence <= to).map((e) => ({ ...e, acc: v.inboxAcc[String(e.sequence)]! }));

/** A source whose batch list can change between syncs, as the chain's does across a rollback. */
function liveSource(v: Vector) {
  let list: LiveBatch[] = v.batches.map((b) => ({ ...b, submittedAt: 0 }));
  const src: BatchSource = { listBatches: async () => list, fetchEntries: entriesOf(v) };
  return { src, set: (b: LiveBatch[]) => (list = b) };
}

const flip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);
const env = (v: Vector) => ({ chainId: v.chainId, rollupId: v.rollupId });

/** A recorded batch with withdrawals that has a child after it. */
function parentWithChild(): { v: Vector; i: number } {
  for (const v of vectors) {
    const i = v.batches.findIndex((b, k) => b.withdrawalsRoot !== "" && k + 1 < v.batches.length);
    if (i >= 0) return { v, i };
  }
  throw new Error("no recorded batch with withdrawals and a child");
}

describe("verdicts", () => {
  it("are per published batch: a repeated honest state root with a forged withdrawals root gets its own", async () => {
    const { v, i } = parentWithChild();
    const live = liveSource(v);
    const t = new RollupTracker(env(v), live.src, new InboxArchive(env(v)));
    const first = await t.sync();
    expect(first[i]!.judgement.kind).toBe("valid");
    // After a rollback the index is reused: same index, same (honest) state root, forged withdrawals root.
    const forged = { ...first[i]!.batch, withdrawalsRoot: flip(first[i]!.batch.withdrawalsRoot) };
    live.set(first.map((x, k) => (k === i ? forged : x.batch)));
    const second = await t.sync();
    expect(batchKey(forged)).not.toBe(batchKey(first[i]!.batch));
    expect(second[i]!.judgement.kind).toBe("invalid");
    expect(t.challenge(forged).wins).toBe(true);
  });
});

describe("attestable batches", () => {
  it("exclude a valid child of a batch whose only fault is its withdrawals root", async () => {
    const { v, i } = parentWithChild();
    const statuses = (b: LiveBatch, k: number) => ({ ...b, status: k < i ? "finalized" : "submitted" });
    const honest = v.batches.map((b, k) => statuses({ ...b, submittedAt: 0 }, k));
    const forged = honest.map((b, k) => (k === i ? { ...b, withdrawalsRoot: flip(b.withdrawalsRoot) } : b));

    const ok = await new RollupTracker(env(v), { listBatches: async () => honest, fetchEntries: entriesOf(v) }, new InboxArchive(env(v))).sync();
    expect(attestableBatches(ok).has(batchKey(honest[i + 1]!))).toBe(true);

    const bad = await new RollupTracker(env(v), { listBatches: async () => forged, fetchEntries: entriesOf(v) }, new InboxArchive(env(v))).sync();
    expect(bad[i]!.judgement.kind).toBe("invalid");
    // The child re-executes correctly from the honest state, so it is judged valid...
    expect(bad[i + 1]!.judgement.kind).toBe("valid");
    // ...but an upheld challenge on its parent would remove it, so its exits must not be signed.
    const attestable = attestableBatches(bad);
    expect(attestable.has(batchKey(forged[i + 1]!))).toBe(false);
    expect(attestable.has(batchKey(forged[i]!))).toBe(false);
  });

  it("exclude everything after a challenged batch, and ignore finalized ones", () => {
    const mk = (batchIndex: number, status: string, kind: "valid" | "invalid" = "valid") => ({
      batch: { batchIndex, inboxStart: batchIndex, inboxEnd: batchIndex + 1, prevStateRoot: `${batchIndex}`, stateRoot: `${batchIndex + 1}`, withdrawalsRoot: "", dataHash: "", status, submittedAt: 0 },
      judgement: (kind === "valid" ? { kind: "valid" } : { kind: "invalid", mismatches: [], honestStateRoot: "", honestWithdrawalsRoot: "" }) as Judgement,
    });
    const tracked = [mk(0, "finalized", "invalid"), mk(1, "submitted"), mk(2, "challenged"), mk(3, "submitted")];
    const a = attestableBatches(tracked);
    expect([...a]).toEqual([batchKey(tracked[1]!.batch)]);
  });
});

describe("the inbox archive", () => {
  it("drops a torn last line and refuses damage anywhere else", async () => {
    const v = vectors.find((x) => x.rollupId === "vigil-pay-1")!;
    const dir = mkdtempSync(join(tmpdir(), "vigil-arch-"));
    const path = join(dir, "inbox.jsonl");
    const a = new InboxArchive(env(v), path);
    a.append(await entriesOf(v)(0, v.entries.length));
    appendFileSync(path, '{"sequence": 99, "hei');
    const reloaded = new InboxArchive(env(v), path);
    expect(reloaded.repaired).toBe(true);
    expect(reloaded.head).toBe(v.entries.length);
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);

    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines.splice(1, 0, '{"sequence": 2, "torn');
    writeFileSync(path, lines.join("\n") + "\n");
    expect(() => new InboxArchive(env(v), path)).toThrow(/not valid JSON/);
  });
});

describe("challenge policy", () => {
  const batch = { batchIndex: 7, inboxStart: 1, inboxEnd: 2, prevStateRoot: "aa", stateRoot: "bb", withdrawalsRoot: "cc", dataHash: "dd" };
  it("settles only on what the chain shows", () => {
    expect(currentBatchDecision(batch, undefined)).toEqual({ action: "settle", reason: "batch gone" });
    expect(currentBatchDecision(batch, { status: "rejected", stateRoot: "bb", withdrawalsRoot: "cc" }).action).toBe("settle");
    expect(currentBatchDecision(batch, { status: "finalized", stateRoot: "bb", withdrawalsRoot: "cc" }).action).toBe("settle");
    expect(currentBatchDecision(batch, { status: "submitted", stateRoot: "BB", withdrawalsRoot: "0xcc" })).toEqual({ action: "proceed" });
    expect(currentBatchDecision(batch, { status: "submitted", stateRoot: "bb", withdrawalsRoot: "ce" })).toEqual({ action: "settle", reason: "batch replaced" });
  });
  it("treats unknown failures as transient", () => {
    expect(challengeResultDecision({ code: 0, rawLog: "" })).toBe("upheld");
    expect(challengeResultDecision({ code: OUT_OF_GAS, rawLog: "out of gas" })).toBe("out-of-gas");
    expect(challengeResultDecision({ code: 9, rawLog: "batch 6 is rejected: batch already finalized" })).toBe("lost");
    expect(challengeResultDecision({ code: 5, rawLog: "insufficient funds" })).toBe("retry");
    expect([1, 2, 3, 6, 10].map(backoffMs)).toEqual([2_000, 4_000, 8_000, 60_000, 60_000]);
  });
});

describe("the send lane", () => {
  afterEach(() => vi.useRealTimers());
  it("abandons a broadcast that hangs, so later sends are not blocked", async () => {
    vi.useFakeTimers();
    const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    let broadcasts = 0;
    const transport: ChallengeTransport = {
      account: async () => ({ accountNumber: 0n, sequence: 0n }),
      broadcastSync: () => {
        broadcasts++;
        return broadcasts === 1 ? new Promise<string>(() => {}) : Promise.resolve("HASH2");
      },
      result: async () => undefined,
    };
    const ch = new Challenger(await deriveUnifiedAccount(TEST_MNEMONIC, 0), "qorechain-diana", transport, { signBytesVersion: "v2" });
    const first = ch.post("vigil-pay-1", new Uint8Array(10), "a");
    const firstDone = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_001);
    await firstDone;
    await expect(ch.post("vigil-pay-1", new Uint8Array(10), "b")).resolves.toMatchObject({ hash: "HASH2" });
  });
});
