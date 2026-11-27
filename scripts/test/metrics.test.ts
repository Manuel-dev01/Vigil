/**
 * Vigil in numbers (scripts/metrics/model.ts), offline. The inbox entries come from the committed
 * archive; the rest are the heights and amounts EVIDENCE.md records. The last block checks that the
 * committed snapshot, docs/METRICS.md and the README's numbers agree with each other.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { committedArchivePath, readArchiveFile } from "@vigil/core/inbox";
import { isSealedEnvelope } from "@vigil/sealed/payslip";
import {
  EMPLOYER,
  README_END,
  README_START,
  WEI_PER_UQOR,
  buildStrip,
  consumedTo,
  countBatches,
  daysBetween,
  exitRow,
  finalWithVerifiedAnchor,
  findWithdrawalPost,
  fraudNote,
  median,
  qor,
  renderMarkdown,
  renderReadmeStrip,
  repaidPercent,
  repaidWords,
  replaceBlock,
  sealedBy,
  spentBy,
  standbyRows,
  timeUtc,
  txLink,
  type BatchIn,
  type FraudRow,
  type Snapshot,
} from "../metrics/model.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const archive = readArchiveFile(committedArchivePath("vigil-pay-1")).rows;
const EXIT_ADDRESS = "qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy";
const snapshot = JSON.parse(readFileSync(resolve(ROOT, "docs/metrics.json"), "utf8")) as Snapshot;

const batch = (i: number, over: Partial<BatchIn> = {}): BatchIn => ({
  batchIndex: i,
  status: "finalized",
  stateRoot: `${i}`.padStart(64, "0"),
  submittedAt: 1_000 + i,
  submittedTime: 0,
  inboxStart: i,
  inboxEnd: i + 1,
  ...over,
});

describe("countBatches", () => {
  it("counts statuses, own anchors and final batches with no anchor", () => {
    const batches = [batch(0), batch(1), batch(2, { status: "submitted" }), batch(3, { status: "rejected" })];
    const anchors = [
      { layerHeight: 0, stateRoot: batches[0]!.stateRoot.toUpperCase() },
      { layerHeight: 2, stateRoot: batches[2]!.stateRoot },
      // An anchor at height 3 with a different root does not anchor the listed batch 3.
      { layerHeight: 3, stateRoot: "f".repeat(64) },
    ];
    expect(countBatches(batches, anchors)).toEqual({
      listed: 4,
      final: 2,
      pending: 1,
      rejectedListed: 1,
      latestIndex: 3,
      anchored: 2,
      unanchoredFinal: [1],
    });
  });

  it("counts final batches whose own verified anchor carries their root", () => {
    const batches = [batch(0), batch(1), batch(2, { status: "submitted" })];
    const anchors = batches.map((b) => ({ layerHeight: b.batchIndex, stateRoot: b.stateRoot }));
    expect(finalWithVerifiedAnchor(batches, anchors, new Set([0, 1, 2]))).toBe(2);
    expect(finalWithVerifiedAnchor(batches, anchors, new Set([1]))).toBe(1);
    expect(finalWithVerifiedAnchor(batches, [{ layerHeight: 0, stateRoot: "e".repeat(64) }], new Set([0]))).toBe(0);
  });
});

describe("standbyRows", () => {
  it("times keel-b's batch 11 from the post it consumed (EVIDENCE 68, 69)", () => {
    const b11 = batch(11, { submittedAt: 10_433_596, inboxStart: 12, inboxEnd: 13 });
    expect(standbyRows([b11], [11], archive)).toEqual([{ batchIndex: 11, firstEntry: 13, postHeight: 10_433_589, submittedHeight: 10_433_596, blocksAfterPost: 7 }]);
  });

  it("skips a batch whose entries are not in the archive", () => {
    expect(standbyRows([batch(40, { inboxStart: 90, inboxEnd: 91 })], [40], archive)).toEqual([]);
  });
});

describe("findWithdrawalPost", () => {
  // Batch 15 consumed entry 17, a 0.1 QOR withdrawal to OoJae's exit address (EVIDENCE 86, 87).
  // The range here also covers entries 18 and 19, the watchtowers' attestations, which are not withdrawals.
  const b15 = batch(15, { inboxStart: 16, inboxEnd: 19 });

  it("finds the withdrawal by its exit address and amount", () => {
    const post = findWithdrawalPost(b15, archive, EXIT_ADDRESS, 100_000n);
    expect(post?.sequence).toBe(17);
    expect(post?.height).toBe(10_629_836);
  });

  it("finds nothing for another amount, another address, or outside the batch's range", () => {
    expect(findWithdrawalPost(b15, archive, EXIT_ADDRESS, 99_500n)).toBeUndefined();
    expect(findWithdrawalPost(b15, archive, "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", 100_000n)).toBeUndefined();
    expect(findWithdrawalPost(batch(16, { inboxStart: 17, inboxEnd: 19 }), archive, EXIT_ADDRESS, 100_000n)).toBeUndefined();
  });
});

describe("exitRow", () => {
  // The automatic relayer's exit (EVIDENCE 99 to 104): posted at 10,686,369, batch 18 at 10,686,374, fronted at 10,686,385.
  const front = {
    batchIndex: 18,
    withdrawalIndex: 4,
    payout: "0x7BaAa4638c10dFB64D6ae593C2f019782E7773E3",
    paidWei: 99_500n * WEI_PER_UQOR,
    feeWei: 500n * WEI_PER_UQOR,
    tx: "0x6542b5f393cd4b37f349ef3b2e9edfe103d81b2f675d4ee48c0bd2f2de627c8f",
    height: 10_686_385,
  };
  const b18 = batch(18, { submittedAt: 10_686_374, submittedTime: 1_764_000_000, inboxStart: 19, inboxEnd: 20 });

  it("converts wei to uqor, counts blocks and seconds", () => {
    const post = archive.find((e) => e.sequence === 20)!;
    const row = exitRow({ front, batch: b18, frontTime: 1_764_000_017, post, postTime: 1_763_999_994, challengeWindowSeconds: 3_600 });
    expect(row).toMatchObject({
      amountUqor: "100000",
      paidUqor: "99500",
      feeUqor: "500",
      blocksAfterBatch: 11,
      postEntry: 20,
      postHeight: 10_686_369,
      postToPaidSeconds: 23,
      secondsBeforeFinal: 3_583,
      batchFinal: true,
      frontTime: "2025-11-24T16:00:17Z",
    });
  });

  it("leaves out what it cannot know", () => {
    const row = exitRow({ front, batch: { ...b18, submittedTime: 0 }, frontTime: 1_764_000_017 });
    expect(row.postToPaidSeconds).toBeUndefined();
    expect(row.secondsBeforeFinal).toBeUndefined();
    expect(row.postEntry).toBeUndefined();
    expect(exitRow({ front, batch: { ...b18, status: "submitted" }, frontTime: 1_764_000_017 }).batchFinal).toBe(false);
  });

  it("says what is still owed, and why", () => {
    const final = exitRow({ front, batch: b18, frontTime: 1_764_000_017 });
    const pending = exitRow({ front: { ...front, batchIndex: 29 }, batch: { ...b18, batchIndex: 29, status: "submitted" }, frontTime: 1_764_000_017 });
    expect(repaidWords({ rows: [final], owedUqor: "0", repaidPercent: 100 })).toBe("the vault is fully repaid");
    expect(repaidWords({ rows: [final, pending], owedUqor: "100000", repaidPercent: 50 })).toBe(
      "every exit whose batch is final is repaid; 0.1 QOR is owed on 1 exit whose batch is not final yet",
    );
    // Owed on a final batch: the plain share, with no excuse.
    expect(repaidWords({ rows: [final, pending], owedUqor: "200000", repaidPercent: 0 })).toBe("the vault is 0% repaid");
  });
});

describe("small helpers", () => {
  it("repaidPercent", () => {
    expect(repaidPercent(200_000n, 0n)).toBe(100);
    expect(repaidPercent(200_000n, 100_000n)).toBe(50);
    expect(repaidPercent(300_000n, 100_000n)).toBe(66.6);
    expect(repaidPercent(0n, 0n)).toBeNull();
  });

  it("median, days and QOR", () => {
    expect(median([])).toBeUndefined();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20])).toBe(15);
    expect(daysBetween(0, 86_400 * 8 + 86_399)).toBe(8);
    expect(qor(99_500n)).toBe("0.0995 QOR");
    expect(qor("1000000")).toBe("1 QOR");
    expect(qor(1_000_500n)).toBe("1.0005 QOR");
    expect(qor(1_000_000_000n)).toBe("1,000 QOR");
    expect(timeUtc("2026-11-27T09:05:00Z")).toBe("27 Nov 2026, 09:05 UTC");
  });

  it("spentBy sums one spender's coin_spent events in uqor", () => {
    const events = [
      { type: "coin_spent", attributes: [{ key: "spender", value: "qor1a" }, { key: "amount", value: "73480uqor" }] },
      { type: "coin_spent", attributes: [{ key: "spender", value: "qor1a" }, { key: "amount", value: "59050uqor,5erc20:0x9714" }] },
      { type: "coin_spent", attributes: [{ key: "spender", value: "qor1b" }, { key: "amount", value: "999uqor" }] },
      { type: "coin_received", attributes: [{ key: "receiver", value: "qor1a" }, { key: "amount", value: "1uqor" }] },
    ];
    expect(spentBy(events, "qor1a")).toBe(132_530n);
    expect(spentBy(events, "qor1c")).toBe(0n);
  });
});

describe("payslips and the archive", () => {
  const sealed = (hex: string): boolean => isSealedEnvelope(Buffer.from(hex, "hex"));

  it("counts employer-1's sealed envelopes in the archive, and nobody else's", () => {
    expect(sealedBy(archive, EMPLOYER, sealed)).toEqual([6, 24, 27]);
    // The same envelope from another poster is not a Vigil payslip.
    const env = archive.find((e) => e.sequence === 6)!;
    expect(sealedBy([{ ...env, poster: "qor1kgvdpmv87386eyp7k577r55ttx9tf5m77jwygk" }], EMPLOYER, sealed)).toEqual([]);
  });

  it("finds how far the chain's batches have consumed the inbox, ignoring rejected ones", () => {
    expect(consumedTo([batch(0, { inboxEnd: 3 }), batch(1, { inboxEnd: 28 }), batch(2, { status: "rejected", inboxEnd: 40 })])).toBe(28);
    expect(consumedTo([])).toBe(0);
  });
});

describe("words built from the rows", () => {
  const row = (over: Partial<FraudRow>): FraudRow => ({ batchIndex: 8, tx: "4963FCFD", height: 10_382_607, challenger: "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd", ours: true, evidence: [], ...over });

  it("names the drill, the watchtower and the bond from the row", () => {
    expect(fraudNote(row({ drill: "fraud drill 2", slashedUqor: "1000000000" }))).toBe("fraud drill 2: batch 8, our watchtower-2's challenge; 1,000 QOR bond slashed");
    expect(fraudNote(row({ batchIndex: 30, challenger: "qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33" }))).toBe("batch 30, our watchtower-3's challenge");
    expect(fraudNote(row({ challenger: "qor1unknown" }))).toBe("batch 8, our watchtower's challenge");
  });

  it("prints EVM hashes in full and links L1 hashes to the explorer", () => {
    const evm = "0x6542b5f393cd4b37f349ef3b2e9edfe103d81b2f675d4ee48c0bd2f2de627c8f";
    expect(txLink(evm)).toBe(`\`${evm}\``);
    expect(txLink("4963FCFD2D33188456572D27C16D96DD2CB03604767DCBEEF0EDFB54E0F5B915")).toBe(
      "[`4963FCFD…`](https://explore.qore.network/tx/4963FCFD2D33188456572D27C16D96DD2CB03604767DCBEEF0EDFB54E0F5B915)",
    );
  });

  it("explains the off-by-one for batch 11 and for no other standby batch", () => {
    const at = (batchIndex: number) => ({ ...snapshot, standby: [{ batchIndex, firstEntry: 40, postHeight: 1, submittedHeight: 31, blocksAfterPost: 30 }] });
    expect(renderMarkdown(at(11))).toMatch(/Batch 11 came sooner because of an off-by-one/);
    const other = renderMarkdown(at(40));
    expect(other).toMatch(/The standby waits 30 blocks/);
    expect(other).not.toMatch(/off-by-one/);
  });

  it("says when the chain has consumed entries the archive does not hold", () => {
    const { head } = snapshot.archive;
    expect(renderMarkdown({ ...snapshot, archive: { ...snapshot.archive, chainInboxEnd: head } })).not.toMatch(/not in the archive and not counted/);
    expect(renderMarkdown({ ...snapshot, archive: { ...snapshot.archive, chainInboxEnd: head + 1 } })).toMatch(new RegExp(`entry ${head + 1} is not in the archive and not counted here`));
    expect(renderMarkdown({ ...snapshot, archive: { ...snapshot.archive, chainInboxEnd: head + 3 } })).toMatch(new RegExp(`entries ${head + 1} to ${head + 3} are not in the archive`));
  });
});

describe("README markers", () => {
  it("replaces only the block between the markers", () => {
    const text = `a\n${README_START}\nold\n${README_END}\nb`;
    expect(replaceBlock(text, `${README_START}\nnew\n${README_END}`)).toBe(`a\n${README_START}\nnew\n${README_END}\nb`);
    expect(() => replaceBlock("no markers", "x")).toThrow(/markers/);
  });
});

// ------------------------------------------------------------------ the committed snapshot

/** Words the repo does not use about itself. "Read-only" and "signature-only" are not claims. */
const BANNED = /quantum-proof|quantum-safe|unbreakable|(?<![-\w])(only|first|unique)(?![-\w])/i;

describe("docs/metrics.json", () => {
  it("has six numbers, each with a source, and no banned words", () => {
    expect(snapshot.strip).toHaveLength(6);
    for (const i of snapshot.strip) {
      expect(i.value && i.label && i.note && i.source).toBeTruthy();
      expect(`${i.value} ${i.label} ${i.note}`).not.toMatch(BANNED);
    }
  });

  it("rebuilds its own strip", () => {
    const { strip, ...rest } = snapshot;
    expect(buildStrip(rest)).toEqual(strip);
  });

  it("labels the exits as a small sample", () => {
    const exits = snapshot.strip.find((i) => i.label === "paid before finality")!;
    if (snapshot.exits.rows.length > 0 && snapshot.exits.rows.length < 10) expect(exits.note).toMatch(/small sample/);
  });

  it("prints every EVM hash in METRICS.md in full", () => {
    // `cast receipt` needs the whole hash: none may be cut short with an ellipsis.
    expect(renderMarkdown(snapshot)).not.toMatch(/0x[0-9a-fA-F]+…/);
  });

  it("matches docs/METRICS.md and the README's numbers", () => {
    const md = renderMarkdown(snapshot);
    expect(readFileSync(resolve(ROOT, "docs/METRICS.md"), "utf8")).toBe(md);
    expect(md).not.toMatch(BANNED);
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    expect(readme).toContain(renderReadmeStrip(snapshot));
  });
});
