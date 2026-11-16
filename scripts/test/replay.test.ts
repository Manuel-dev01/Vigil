/**
 * Offline replay of recorded chain data (test/vectors/replay-*.json). Each
 * vector was read from qorechain-diana by `spike-a-replay.ts --record`; this
 * test re-executes it with no network and asserts every published root.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { qledgerEmptyRoot, bytesToHex } from "@qorechain/rdk";
import { allOk, checkBatches, type ReplayVector } from "../lib/replay.ts";

const VECTORS = resolve(import.meta.dirname, "../../test/vectors");
const files = readdirSync(VECTORS).filter((f) => f.startsWith("replay-") && f.endsWith(".json"));
const load = (f: string): ReplayVector => JSON.parse(readFileSync(resolve(VECTORS, f), "utf8")) as ReplayVector;

describe("qledger-v1 replay against recorded chain data", () => {
  it("has at least one recorded vector", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("the empty-ledger root is the one the chain uses for batch 0", () => {
    expect(bytesToHex(qledgerEmptyRoot()).toLowerCase()).toBe(
      "ff51bb4bc870040363b3db566d324c5b4aba906fd0c0511ba6131b4f2a3b4536",
    );
  });

  for (const f of files) {
    const v = load(f);
    describe(v.rollupId, () => {
      const { checks } = checkBatches(v);

      for (const c of checks) {
        it(`batch ${c.batchIndex}: state, withdrawals, data_hash and accumulator match the chain`, () => {
          expect(c).toMatchObject({
            prevStateRootOk: true,
            stateRootOk: true,
            withdrawalsRootOk: true,
            dataHashOk: true,
            accOk: true,
          });
          expect(allOk(c)).toBe(true);
        });
      }

      it("detects a tampered state root (one flipped nibble)", () => {
        const b0 = v.batches[0];
        if (!b0) throw new Error("vector has no batch");
        const flipped = (b0.stateRoot[0] === "0" ? "1" : "0") + b0.stateRoot.slice(1);
        const tampered: ReplayVector = { ...v, batches: [{ ...b0, stateRoot: flipped }] };
        const [c] = checkBatches(tampered).checks;
        expect(c?.stateRootOk).toBe(false);
        expect(c && allOk(c)).toBe(false);
      });

      it("detects a tampered inbox payload (the accumulator no longer matches)", () => {
        const e0 = v.entries[0];
        const b0 = v.batches[0];
        if (!e0 || !b0) throw new Error("vector is empty");
        const last = e0.payloadHex.slice(-2) === "00" ? "01" : "00";
        const bad = { ...e0, payloadHex: e0.payloadHex.slice(0, -2) + last };
        const tampered: ReplayVector = { ...v, entries: [bad, ...v.entries.slice(1)], batches: [b0] };
        const [c] = checkBatches(tampered).checks;
        expect(c?.accOk).toBe(false);
      });
    });
  }
});
