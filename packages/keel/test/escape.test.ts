/**
 * Leaving without Vigil: which withdrawals the chain executed, and what is left to do for an address.
 * The executed events are shaped as the node returned them for EVIDENCE 106 (batch 18, withdrawal 4,
 * read 27 Nov 2026); the batches are vigil-pay-1's real withdrawals to the exit address of rows 93 and 106,
 * plus made-up ones for the states the chain has not shown.
 */
import { describe, expect, it } from "vitest";
import { executedWithdrawals, nextStep, unlistedBatches, withdrawalsTo, type BatchWithdrawals } from "../src/escape.ts";

const EXIT = "qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy";
const OTHER = "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s";

const executedTx = (batch: string, index: string, rollup = "vigil-pay-1", code = 0) => ({
  height: "10688902",
  code,
  events: [
    { type: "message", attributes: [{ key: "action", value: "/qorechain.rdk.v1.MsgExecuteWithdrawal" }] },
    {
      type: "rdk_withdrawal_executed",
      attributes: [
        { key: "rollup_id", value: rollup },
        { key: "batch_index", value: batch },
        { key: "withdrawal_index", value: index },
        { key: "recipient", value: EXIT },
        { key: "amount", value: "100000uqor" },
        { key: "msg_index", value: "0" },
      ],
    },
  ],
});

const batches: BatchWithdrawals[] = [
  { batchIndex: 2, status: "finalized", submittedTime: 0, withdrawals: [{ index: 0n, recipient: OTHER, amount: 250_000n }] },
  { batchIndex: 15, status: "finalized", submittedTime: 0, withdrawals: [{ index: 3n, recipient: EXIT, amount: 100_000n }] },
  { batchIndex: 18, status: "finalized", submittedTime: 1_795_518_000, withdrawals: [{ index: 4n, recipient: EXIT, amount: 100_000n }] },
  // Made up: one final but not executed, one in its window, one rejected.
  { batchIndex: 30, status: "finalized", submittedTime: 1_795_788_000, withdrawals: [{ index: 9n, recipient: EXIT, amount: 5_000n }] },
  { batchIndex: 31, status: "submitted", submittedTime: 1_795_791_600, withdrawals: [{ index: 10n, recipient: EXIT, amount: 7_000n }] },
  { batchIndex: 32, status: "rejected", submittedTime: 1_795_791_700, withdrawals: [{ index: 11n, recipient: EXIT, amount: 1n }] },
];

describe("executedWithdrawals", () => {
  it("reads batch and withdrawal from the chain's executed events", () => {
    const s = executedWithdrawals([executedTx("15", "3"), executedTx("18", "4")], "vigil-pay-1");
    expect([...s].sort()).toEqual(["15:3", "18:4"]);
  });

  it("ignores failed transactions, other rollups and malformed events", () => {
    const s = executedWithdrawals(
      [executedTx("15", "3", "vigil-pay-1", 5), executedTx("15", "3", "vigil-1"), executedTx("x", "3"), { events: [{ type: "rdk_withdrawal_executed" }] }, null],
      "vigil-pay-1",
    );
    expect(s.size).toBe(0);
  });
});

describe("withdrawalsTo", () => {
  const executed = executedWithdrawals([executedTx("15", "3"), executedTx("18", "4")], "vigil-pay-1");
  const rows = withdrawalsTo(EXIT, batches, executed, 3600);

  it("lists only the address's withdrawals", () => {
    expect(rows.map((r) => `${r.batchIndex}:${r.index}`)).toEqual(["15:3", "18:4", "30:9", "31:10", "32:11"]);
    expect(withdrawalsTo(OTHER, batches, executed, 3600).map((r) => r.state)).toEqual(["claimable"]);
  });

  it("says which are paid, which anyone can execute now, which wait, and which went with a rejected batch", () => {
    expect(rows.map((r) => r.state)).toEqual(["paid", "paid", "claimable", "waiting", "rejected"]);
    expect(rows[3]?.finalFrom).toBe(1_795_795_200);
  });

  it("gives the next step in words, with the claim command for a final one", () => {
    expect(nextStep(rows[0]!, "vigil-pay-1")).toBe("paid on L1; nothing to do");
    expect(nextStep(rows[2]!, "vigil-pay-1")).toBe("final: anyone can execute it now (claim.ts --batch 30)");
    expect(nextStep(rows[2]!, "vigil-1")).toBe("final: anyone can execute it now (claim.ts --batch 30 --rollup vigil-1)");
    expect(nextStep(rows[3]!, "vigil-pay-1")).toBe("waiting for its batch to be final (its challenge window ends 2026-11-27T16:00:00Z)");
    expect(nextStep(rows[4]!, "vigil-pay-1")).toContain("rejected by a fraud proof");
  });
});

describe("unlistedBatches", () => {
  it("lists nothing for a full replay from the first batch", () => {
    expect(unlistedBatches({})).toEqual([]);
    expect(unlistedBatches({ snapshotBatch: 0 })).toEqual([]);
  });

  it("says which batches the chain pruned, so a short list is not read as complete", () => {
    expect(unlistedBatches({ pruned: { fromBatchIndex: 1, toBatchIndex: 12 } })).toEqual([
      "withdrawals in batches 1 to 12 are not listed: the chain no longer holds those batch records",
    ]);
    expect(unlistedBatches({ pruned: { fromBatchIndex: 4, toBatchIndex: 4 } })).toEqual(["withdrawals in batch 4 are not listed: the chain no longer holds that batch record"]);
  });

  it("names a snapshot and a pruned range together", () => {
    const lines = unlistedBatches({ snapshotBatch: 10, pruned: { fromBatchIndex: 11, toBatchIndex: 14 } });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("up to 10 are in the snapshot");
    expect(lines[1]).toContain("batches 11 to 14 are not listed");
  });
});
