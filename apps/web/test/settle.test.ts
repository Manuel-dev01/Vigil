/** Repayments attributed to fronted exits, first in first out per payout. */
import { describe, expect, it } from "vitest";
import { attributeRepayments } from "../src/settle.ts";

const QOR = 10n ** 18n;
const tenth = QOR / 10n;
const payout = "0x7BaAA4638c10dFb64D6Ae593c2F019782E7773e3";

describe("attributeRepayments", () => {
  it("credits each sweep to one exit when one payout had two fronts (vigil-pay-1 batches 15 and 18)", () => {
    // What the vault logged: front (batch 15), sweep, front (batch 18), sweep, each 0.1 QOR.
    const fronts = [
      { id: "b15", payout, block: 10_629_908, logIndex: 0, owed: tenth },
      { id: "b18", payout, block: 10_686_385, logIndex: 0, owed: tenth },
    ];
    const settles = [
      { payout, block: 10_631_863, logIndex: 1, repaid: tenth, tx: "s1" },
      { payout: payout.toLowerCase(), block: 10_688_909, logIndex: 1, repaid: tenth, tx: "s2" },
    ];
    const r = attributeRepayments(fronts, settles);
    expect(r.get("b15")).toMatchObject({ owed: tenth, repaid: tenth });
    expect(r.get("b15")!.shares.map((s) => s.settle.tx)).toEqual(["s1"]);
    expect(r.get("b15")!.completedBy?.tx).toBe("s1");
    expect(r.get("b18")).toMatchObject({ owed: tenth, repaid: tenth });
    expect(r.get("b18")!.shares.map((s) => s.settle.tx)).toEqual(["s2"]);
  });

  it("splits one sweep across outstanding exits, oldest first, never past what each owed", () => {
    const fronts = [
      { id: "a", payout, block: 10, logIndex: 0, owed: 3n },
      { id: "b", payout, block: 11, logIndex: 0, owed: 5n },
    ];
    const r = attributeRepayments(fronts, [{ payout, block: 20, logIndex: 0, repaid: 6n }]);
    expect(r.get("a")).toMatchObject({ repaid: 3n });
    expect(r.get("a")!.completedBy).toBeDefined();
    expect(r.get("b")).toMatchObject({ repaid: 3n, completedBy: undefined });
  });

  it("does not credit a sweep to a front made after it, nor to another payout", () => {
    const other = "0x13f665a393a96c972606ACfAE757754443DCBa8f";
    const fronts = [
      { id: "late", payout, block: 30, logIndex: 0, owed: 5n },
      { id: "other", payout: other, block: 1, logIndex: 0, owed: 5n },
    ];
    const r = attributeRepayments(fronts, [{ payout, block: 20, logIndex: 0, repaid: 5n }]);
    expect(r.get("late")!.repaid).toBe(0n);
    expect(r.get("other")!.repaid).toBe(0n);
  });

  it("orders by log index within a block", () => {
    const fronts = [{ id: "x", payout, block: 5, logIndex: 3, owed: 1n }];
    expect(attributeRepayments(fronts, [{ payout, block: 5, logIndex: 2, repaid: 1n }]).get("x")!.repaid).toBe(0n);
    expect(attributeRepayments(fronts, [{ payout, block: 5, logIndex: 4, repaid: 1n }]).get("x")!.repaid).toBe(1n);
  });
});
