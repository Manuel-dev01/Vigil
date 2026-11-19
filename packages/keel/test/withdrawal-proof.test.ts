/**
 * The withdrawal proofs `claim.ts` sends, checked offline against recorded
 * chain data: for every withdrawal vigil-1 committed, the leaf folded up its
 * sibling path must give the withdrawals root that batch published.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, qledgerWithdrawalLeaf, qledgerWithdrawalProof, qorehash } from "@qorechain/rdk";
import type { ReplayVector } from "../../../scripts/lib/replay.ts";
import { withdrawalsByBatch } from "../../../scripts/lib/withdrawals.ts";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../test/vectors/replay-vigil-1.json"), "utf8"),
) as ReplayVector;
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();

describe("qledger withdrawal proofs (vigil-1, recorded)", () => {
  const byBatch = withdrawalsByBatch(vector);

  it("the recording commits withdrawals to prove", () => {
    expect(byBatch.reduce((n, b) => n + b.withdrawals.length, 0)).toBeGreaterThan(0);
  });

  for (const { batchIndex, withdrawals } of byBatch) {
    const published = vector.batches.find((b) => b.batchIndex === batchIndex)!.withdrawalsRoot.toLowerCase();
    it(`batch ${batchIndex}: every proof folds to the published root`, () => {
      let width = 1;
      while (width < withdrawals.length) width *= 2;
      withdrawals.forEach((w, i) => {
        const path = qledgerWithdrawalProof(vector.chainId, vector.rollupId, withdrawals, i);
        let node = qledgerWithdrawalLeaf(vector.chainId, vector.rollupId, w.index, w.recipient, w.amount);
        let pos = Number(w.index % BigInt(width));
        for (const sibling of path) {
          node = pos % 2 === 0 ? qorehash(node, sibling) : qorehash(sibling, node);
          pos >>= 1;
        }
        expect(hex(node)).toBe(published);
      });
    });
  }
});
