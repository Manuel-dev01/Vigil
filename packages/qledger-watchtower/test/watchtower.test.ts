/**
 * Offline tests of the qledger watchtower against recorded chain data
 * (test/vectors/replay-*.json, recorded from qorechain-diana). The fraud tests
 * decide each proof with `checkQledgerFraud`, the RDK's mirror of the chain's
 * own rule, so "wins" here means the chain would uphold the challenge.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { InboxArchive, RollupTracker, type ArchivedEntry, type BatchSource, type LiveBatch } from "../src/index.ts";

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

function source(v: Vector, batches = v.batches): BatchSource {
  return {
    listBatches: async () => batches.map((b) => ({ ...b, submittedAt: 0 })),
    fetchEntries: async (from, to): Promise<ArchivedEntry[]> =>
      v.entries
        .filter((e) => e.sequence > from && e.sequence <= to)
        .map((e) => ({ ...e, acc: v.inboxAcc[String(e.sequence)]! })),
  };
}

const tracker = (v: Vector, batches = v.batches, archivePath?: string) => {
  const env = { chainId: v.chainId, rollupId: v.rollupId };
  return new RollupTracker(env, source(v, batches), new InboxArchive(env, archivePath));
};

const flip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);

describe("qledger watchtower on recorded chain data", () => {
  it("has the recorded rollups", () => {
    expect(vectors.map((v) => v.rollupId).sort()).toEqual(expect.arrayContaining(["vigil-pay-1"]));
    expect(vectors.reduce((n, v) => n + v.batches.length, 0)).toBeGreaterThanOrEqual(40);
  });

  for (const v of vectors) {
    describe(v.rollupId, () => {
      it(`judges all ${v.batches.length} live batches valid`, async () => {
        const tracked = await tracker(v).sync();
        expect(tracked.map((t) => t.judgement.kind)).toEqual(v.batches.map(() => "valid"));
      });

      it("never wins a challenge against an honest batch", async () => {
        const t = tracker(v);
        await t.sync();
        const last = [...v.batches].sort((a, b) => b.batchIndex - a.batchIndex)[0]!;
        expect(t.challenge(last).wins).toBe(false);
      });

      it("flags a wrong state root, and the chain's rule upholds the fraud proof", async () => {
        const sorted = [...v.batches].sort((a, b) => a.batchIndex - b.batchIndex);
        const target = sorted[Math.floor(sorted.length / 2)]!;
        const bad = { ...target, stateRoot: flip(target.stateRoot) };
        const batches = sorted.map((b) => (b.batchIndex === target.batchIndex ? bad : b));
        const t = tracker(v, batches);
        const tracked = await t.sync();
        const j = tracked.find((x) => x.batch.batchIndex === target.batchIndex)!.judgement;
        expect(j.kind).toBe("invalid");
        if (j.kind === "invalid") expect(j.mismatches).toContain("stateRoot");
        const c = t.challenge(bad);
        expect(c.wins).toBe(true);
        expect(c.proof.length).toBeGreaterThan(0);
      });

      it("treats a batch built on a fraudulent root as invalid too", async () => {
        const sorted = [...v.batches].sort((a, b) => a.batchIndex - b.batchIndex);
        if (sorted.length < 2) return;
        const a = sorted[sorted.length - 2]!;
        const b = sorted[sorted.length - 1]!;
        const badRoot = flip(a.stateRoot);
        const batches = sorted.map((x) =>
          x.batchIndex === a.batchIndex ? { ...x, stateRoot: badRoot } : x.batchIndex === b.batchIndex ? { ...x, prevStateRoot: badRoot } : x,
        );
        const tracked = await tracker(v, batches).sync();
        expect(tracked.at(-1)!.judgement.kind).toBe("descends-from-invalid");
      });
    });
  }

  it("flags a wrong withdrawals root, and the proof wins", async () => {
    const v = vectors.find((x) => x.batches.some((b) => b.withdrawalsRoot !== ""))!;
    const target = v.batches.find((b) => b.withdrawalsRoot !== "")!;
    const bad = { ...target, withdrawalsRoot: flip(target.withdrawalsRoot) };
    const t = tracker(v, v.batches.map((b) => (b.batchIndex === target.batchIndex ? bad : b)));
    const tracked = await t.sync();
    const j = tracked.find((x) => x.batch.batchIndex === target.batchIndex)!.judgement;
    expect(j.kind).toBe("invalid");
    if (j.kind === "invalid") expect(j.mismatches).toEqual(["withdrawalsRoot"]);
    expect(t.challenge(bad).wins).toBe(true);
  });

  it("ignores a rejected batch and judges the honest resubmission at the same index", async () => {
    const v = vectors.find((x) => x.rollupId === "vigil-pay-1")!;
    const target = v.batches[v.batches.length - 1]!;
    const rejected = { ...target, stateRoot: flip(target.stateRoot), status: "rejected" };
    const tracked = await tracker(v, [...v.batches.slice(0, -1), rejected, target]).sync();
    expect(tracked.every((x) => x.judgement.kind === "valid")).toBe(true);
    expect(tracked).toHaveLength(v.batches.length);
  });

  it("archives the inbox to disk, reloads it, and refuses a corrupted archive", async () => {
    const v = vectors.find((x) => x.rollupId === "vigil-pay-1")!;
    const dir = mkdtempSync(join(tmpdir(), "vigil-wt-"));
    const path = join(dir, "inbox.jsonl");
    await tracker(v, v.batches, path).sync();
    const env = { chainId: v.chainId, rollupId: v.rollupId };
    const reloaded = new InboxArchive(env, path);
    expect(reloaded.head).toBe(v.entries.length);
    // A restarted watchtower judges everything from the archive alone.
    const offline: BatchSource = { listBatches: source(v).listBatches, fetchEntries: async () => { throw new Error("network not needed"); } };
    const tracked = await new RollupTracker(env, offline, reloaded).sync();
    expect(tracked.every((x) => x.judgement.kind === "valid")).toBe(true);
    // Flip one payload byte: the accumulator check must refuse the file.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const first = JSON.parse(lines[0]!) as ArchivedEntry;
    first.payloadHex = first.payloadHex.slice(0, -2) + (first.payloadHex.endsWith("00") ? "01" : "00");
    lines[0] = JSON.stringify(first);
    writeFileSync(path, lines.join("\n") + "\n");
    expect(() => new InboxArchive(env, path)).toThrow(/accumulator/);
  });
});
