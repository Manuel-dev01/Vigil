/**
 * Keel's ledger snapshot against recorded chain data (no network): the state
 * rebuilt from vigil-1's 29 published batches must survive a save and reload
 * with the chain's own final root, and a tampered snapshot must be refused.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@qorechain/rdk";
import { checkBatches, type ReplayVector } from "../../../scripts/lib/replay.ts";
import { emptyState, snapshotOf, stateFrom, type LedgerSnapshot } from "../src/snapshot.ts";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../test/vectors/replay-vigil-1.json"), "utf8"),
) as ReplayVector;
const env = { chainId: vector.chainId, rollupId: vector.rollupId };
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();

describe("ledger snapshot", () => {
  const { ledger } = checkBatches(vector);
  const last = [...vector.batches].sort((a, b) => a.batchIndex - b.batchIndex).at(-1)!;
  const state = { ledger, batchIndex: last.batchIndex, inboxEnd: last.inboxEnd };
  const fresh = (): LedgerSnapshot => JSON.parse(JSON.stringify(snapshotOf(env, state, "2026-11-19T00:00:00Z"))) as LedgerSnapshot;

  it("reloads to the chain's root after the last recorded batch", () => {
    const back = stateFrom(fresh(), env);
    expect(hex(back.ledger.root())).toBe(last.stateRoot.toLowerCase());
    expect(back.batchIndex).toBe(last.batchIndex);
    expect(back.inboxEnd).toBe(last.inboxEnd);
    expect(back.ledger.accounts().length).toBe(ledger.accounts().length);
  });

  it("refuses a snapshot whose accounts were changed", () => {
    const snap = fresh();
    const first = snap.accounts[0]!;
    first.balance = (BigInt(first.balance) + 1n).toString();
    expect(() => stateFrom(snap, env)).toThrow(/hash to/);
  });

  it("refuses a snapshot saved for another rollup", () => {
    expect(() => stateFrom(fresh(), { ...env, rollupId: "vigil-pay-1" })).toThrow(/snapshot is for/);
  });

  it("starts from the empty-ledger root the chain uses for batch 0", () => {
    const s = emptyState();
    expect(s.batchIndex).toBe(-1);
    expect(hex(s.ledger.root())).toBe("ff51bb4bc870040363b3db566d324c5b4aba906fd0c0511ba6131b4f2a3b4536");
    expect(hex(stateFrom(snapshotOf(env, s, "t"), env).ledger.root())).toBe(hex(s.ledger.root()));
  });
});
