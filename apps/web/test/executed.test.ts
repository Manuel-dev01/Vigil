/** An exit is matched to its L1 payment on the batch and index and also the root, recipient and amount. */
import { describe, expect, it } from "vitest";
import { matchExecuted } from "../src/executed.ts";

const exitAddr = "qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy";
const paid = { batchIndex: 15, withdrawalIndex: 3, recipient: exitAddr, amount: 100_000n, height: 10_631_836 };
const batch = { status: "finalized", sameRoot: true, submittedHeight: 10_629_840 };

describe("matchExecuted", () => {
  it("matches the real batch-15 payment", () => {
    expect(matchExecuted([paid], { batchIndex: 15, withdrawalIndex: 3, recipientQor1: exitAddr, amountUqor: 100_000n, batch })).toBe(paid);
  });

  it("does not match on the index alone", () => {
    const x = { batchIndex: 15, withdrawalIndex: 3, recipientQor1: exitAddr, amountUqor: 100_000n, batch };
    expect(matchExecuted([{ ...paid, recipient: "qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k" }], x)).toBeUndefined();
    expect(matchExecuted([{ ...paid, amount: 1n }], x)).toBeUndefined();
  });

  it("does not match a reused index: another root, or a payment before the batch was submitted", () => {
    const x = { batchIndex: 15, withdrawalIndex: 3, recipientQor1: exitAddr, amountUqor: 100_000n };
    expect(matchExecuted([paid], { ...x, batch: { ...batch, sameRoot: false } })).toBeUndefined();
    expect(matchExecuted([paid], { ...x, batch: { ...batch, status: "replaced" } })).toBeUndefined();
    expect(matchExecuted([paid], { ...x, batch: { ...batch, submittedHeight: paid.height + 1 } })).toBeUndefined();
  });
});
