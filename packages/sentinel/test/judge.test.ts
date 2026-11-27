/**
 * The sentinel's re-execution and its exit watch, offline, on vigil-pay-1 as the chain served it on 24 Nov
 * 2026 (test/vectors/inbox-vigil-pay-1.json: 22 batches, inbox entries 1 to 24, including the automatic
 * relayer's first exit in batch 18, EVIDENCE 99 to 109).
 */
import { describe, expect, it } from "vitest";
import { hexToBech32, type BatchView } from "@qorechain/rdk";
import { openInboxReader } from "@vigil/core/inbox";
import { fixtureSource, loadFixture } from "../../core/test/fixture-source.ts";
import { encodePayoutNotice } from "../../qledger-watchtower/src/exits.ts";
import { DEFAULT_EXIT_RULES, exitIdOf, exitsToWatch, payoutsIn } from "../src/exits.ts";
import { BatchJudge, readerSource, type ChainBatch, type Verdict } from "../src/judge.ts";

const fx = loadFixture("vigil-pay-1");
const env = { chainId: fx.chainId, rollupId: fx.rollupId };
const VAULT = "0x3a897802b62b052a102f55e021bc4668539c29b5";
/** OoJae's QoreX, the payout of both fronted exits, and its exit address (EVIDENCE 86, 99). */
const PAYOUT = "0x7baaa4638c10dfb64d6ae593c2f019782e7773e3";
const EXIT_ADDRESS = "qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy";

const batches = (): ChainBatch[] => (fx.batches as BatchView[]).map((b) => ({ ...b }));
const judgeOf = () => {
  const source = fixtureSource(fx);
  return { judge: new BatchJudge(env, readerSource(openInboxReader(env, { source, seeds: [] }))), source };
};
const flip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);

describe("the sentinel's re-execution (the watchtower's check.ts)", () => {
  it("finds all 22 recorded batches valid, with batch 15's and 18's withdrawals to the exit address", async () => {
    const v = await judgeOf().judge.sync(batches());
    expect(v).toHaveLength(22);
    expect(v.every((x) => x.kind === "valid")).toBe(true);
    const w = (i: number) => v.find((x) => x.batchIndex === i)!.withdrawals.map((x) => [Number(x.index), x.recipient, x.amount]);
    expect(w(15)).toEqual([[3, EXIT_ADDRESS, 100_000n]]);
    expect(w(18)).toEqual([[4, EXIT_ADDRESS, 100_000n]]);
  });

  it("reads each inbox entry once: a second look judges nothing again", async () => {
    const { judge, source } = judgeOf();
    await judge.sync(batches());
    const calls = { ...source.calls };
    const again = await judge.sync(batches().map((b) => (b.batchIndex === 21 ? { ...b, status: "finalized" } : b)));
    expect(source.calls).toEqual(calls);
    expect(again.at(-1)).toMatchObject({ batchIndex: 21, status: "finalized", kind: "valid" });
  });

  for (const field of ["stateRoot", "withdrawalsRoot", "dataHash"] as const) {
    it(`flags a batch whose ${field} differs, and the batch built on it`, async () => {
      const list = batches().map((b) => (b.batchIndex === 18 ? { ...b, [field]: flip(b[field] || "00".repeat(32)) } : b));
      // A batch built on a wrong state root names it as its parent.
      if (field === "stateRoot") list[19] = { ...list[19]!, prevStateRoot: list[18]!.stateRoot };
      const v = await judgeOf().judge.sync(list);
      const by = (i: number) => v.find((x) => x.batchIndex === i)!;
      expect(by(17).kind).toBe("valid");
      expect(by(18).kind).toBe("invalid");
      expect(by(18).mismatches).toContain(field);
      expect(by(18).withdrawals).toEqual([]);
      if (field === "stateRoot") expect(by(19)).toMatchObject({ kind: "invalid", mismatches: expect.arrayContaining(["prevStateRoot"]) });
    });
  }

  it("judges again from the first change: the bad batch rejected, its index reused by the honest one", async () => {
    const { judge } = judgeOf();
    const honest = batches();
    const bad = honest.map((b) => (b.batchIndex === 21 ? { ...b, stateRoot: flip(b.stateRoot) } : b));
    expect((await judge.sync(bad)).at(-1)!.kind).toBe("invalid");
    const rolledBack = [...honest.slice(0, 21), { ...bad[21]!, status: "rejected" }];
    expect((await judge.sync(rolledBack)).map((x) => x.batchIndex).at(-1)).toBe(20);
    expect((await judge.sync(honest)).at(-1)).toMatchObject({ batchIndex: 21, kind: "valid" });
  });

  it("starts from the first batch the chain still lists when older records are pruned", async () => {
    const v = await judgeOf().judge.sync(batches().filter((b) => b.batchIndex >= 10));
    expect(v.map((x) => x.kind)).toEqual(Array(12).fill("valid"));
  });

  it("judges nothing when the entries before the first listed batch do not reach its parent root", async () => {
    const list = batches().filter((b) => b.batchIndex >= 10);
    list[0] = { ...list[0]!, prevStateRoot: flip(list[0]!.prevStateRoot) };
    const v = await judgeOf().judge.sync(list);
    expect(v.every((x) => x.kind === "unjudged")).toBe(true);
    expect(v[0]!.reason).toMatch(/do not reproduce its parent root/);
  });
});

describe("the sentinel's exit watch", () => {
  const exitToPayout = new Map([[EXIT_ADDRESS, PAYOUT]]);
  const at18 = async (): Promise<Verdict[]> => {
    // Batch 18 as it was in the minutes after it was submitted.
    const list = batches().map((b) => (b.batchIndex === 18 ? { ...b, status: "submitted" } : b));
    return judgeOf().judge.sync(list);
  };

  it("watches batch 18's withdrawal to the payout's exit address, with the vault's own exit id", async () => {
    const w = exitsToWatch(await at18(), exitToPayout);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ batchIndex: 18, withdrawalIndex: 4, amountUqor: 100_000n, recipient: EXIT_ADDRESS, payout: PAYOUT, batchAt: 1_795_550_685 });
    expect(w[0]!.exempt).toBeUndefined();
    // The id the vault emitted in Fronted for this exit (docs/exits-metrics.json, EVIDENCE 104).
    expect(w[0]!.exitId).toBe("0x73f5a6e66fff40bcfa053fe15cea24e6ccb3600ef86da829132e8580fa78ccfc");
  });

  it("ignores final batches, unknown payouts, and invalid batches", async () => {
    expect(exitsToWatch(await judgeOf().judge.sync(batches()), exitToPayout)).toEqual([]);
    expect(exitsToWatch(await at18(), new Map())).toEqual([]);
    const v = (await at18()).map((x) => (x.batchIndex === 18 ? { ...x, kind: "invalid" as const } : x));
    expect(exitsToWatch(v, exitToPayout)).toEqual([]);
  });

  it("marks exits the relayer is not meant to front: below its minimum, or in a batch over the watchtowers' cap", async () => {
    expect(exitsToWatch(await at18(), exitToPayout, { ...DEFAULT_EXIT_RULES, minExitUqor: 100_001n })[0]!.exempt).toMatch(/below the relayer's minimum/);
    expect(exitsToWatch(await at18(), exitToPayout, { ...DEFAULT_EXIT_RULES, maxClaimsPerBatch: 0 })[0]!.exempt).toMatch(/over the watchtowers' cap/);
  });

  it("learns payouts from the inbox the way the relayer does: posters, and notices for this vault only", () => {
    const entries = [1, 20, 21, 22, 24].map((s) => ({ poster: fx.postedData[String(s)]!.poster, payload: new Uint8Array() }));
    const notice = { poster: "deposit:x", payload: encodePayoutNotice(VAULT, PAYOUT) };
    const elsewhere = { poster: "deposit:x", payload: encodePayoutNotice("0x" + "11".repeat(20), "0x" + "22".repeat(20)) };
    const p = payoutsIn([...entries, notice, elsewhere], VAULT);
    expect(p).toContain(PAYOUT);
    expect(p).not.toContain("0x" + "22".repeat(20));
    // the keep-alive (entry 20) and both watchtowers (21, 22) posted; a deposit (entry 1) names no poster
    expect(p.map((x) => hexToBech32(x, "qor"))).toEqual(
      expect.arrayContaining(["qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l", "qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33", "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd"]),
    );
    expect(p).toHaveLength(5);
  });

  it("computes the vault's exit id (keccak256 of the ABI-encoded batch, root and index)", () => {
    expect(exitIdOf(15, "44b479debbe1f1b3cd451c099fda93e316cfa70acfd82f5448d70c0a4df427b1", 3)).toBe("0xe0c96ab9e41df01a59b61c2a120f2d0958bcfa3810a6c9d040616b34478602be");
  });
});
