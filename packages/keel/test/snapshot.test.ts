/**
 * Keel's ledger snapshot against recorded chain data (no network): the state
 * rebuilt from vigil-1's 29 published batches must survive a save and reload
 * with the chain's own final root, and a tampered snapshot must be refused.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex } from "@qorechain/rdk";
import { checkBatches, type ReplayVector } from "../../../scripts/lib/replay.ts";
import { emptyState, newestSnapshot, saveSnapshot, snapshotOf, stateFrom, type LedgerSnapshot } from "../src/snapshot.ts";

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

  it("picks the newest usable snapshot among several, skipping broken and foreign ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snap-"));
    const at = (name: string) => join(dir, name, "ledger.json");
    saveSnapshot(at("old"), snapshotOf(env, emptyState(), "2026-11-19T00:00:00Z"));
    saveSnapshot(at("new"), fresh());
    const tampered = fresh();
    tampered.batchIndex = 99;
    tampered.accounts[0]!.balance = "1";
    saveSnapshot(at("tampered"), tampered);
    saveSnapshot(at("foreign"), { ...fresh(), rollupId: "vigil-pay-1", batchIndex: 500 });
    saveSnapshot(at("torn"), fresh());
    writeFileSync(at("torn"), "{");
    const skipped: string[] = [];
    const paths = ["old", "new", "tampered", "foreign", "torn", "missing"].map(at);
    const best = newestSnapshot(paths, env, { onSkip: (p) => skipped.push(p) });
    expect(best?.path).toBe(at("new"));
    expect(best?.state.batchIndex).toBe(last.batchIndex);
    expect(skipped.sort()).toEqual([at("foreign"), at("tampered"), at("torn")].sort());
    // A tool that must re-execute batch N takes only a snapshot from before it.
    expect(newestSnapshot(paths, env, { belowBatch: last.batchIndex })?.path).toBe(at("old"));
  });
});
