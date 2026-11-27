/**
 * The "Every instant exit" ledger: rows and summary from recorded chain times (vigil-pay-1's two fronted
 * exits, batches 15 and 18, as scripts/exit/metrics.ts read them on 27 Nov 2026), outcomes, and the
 * committed snapshot docs/exits-metrics.json checked against its own rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExitView } from "../src/exits.ts";
import { OVERDUE_SEC, ledgerRows, ledgerSummary, median, type LedgerExit } from "../src/ledger.ts";
import { ledgerExitOf } from "../src/ledger-exit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const t = (iso: string): number => Date.parse(iso) / 1000;
const QOR = 10n ** 18n;

// Read from the chain (docs/exits-metrics.json; EVIDENCE 86 to 96 and 99 to 109).
const b15: LedgerExit = {
  id: "0xe0c96ab9e41df01a59b61c2a120f2d0958bcfa3810a6c9d040616b34478602be",
  batchIndex: 15,
  withdrawalIndex: 3,
  amountUqor: 100_000n,
  postedAt: t("2026-11-23T21:05:37Z"),
  batchAt: t("2026-11-23T21:05:48Z"),
  finalFrom: t("2026-11-23T22:05:48Z"),
  paidAt: t("2026-11-23T21:08:43Z"),
  repaidAt: t("2026-11-23T22:20:43Z"),
  paidWei: (QOR * 995n) / 10_000n,
  feeWei: (QOR * 5n) / 10_000n,
  frontGas: 472_141n,
  frontTx: "0x9705770b52cdb3448277915a778f1e0e6ba4c8ffddcb2ae4ae6d574416637933",
  batchStatus: "finalized",
};
const b18: LedgerExit = {
  ...b15,
  id: "0x73f5a6e66fff40bcfa053fe15cea24e6ccb3600ef86da829132e8580fa78ccfc",
  batchIndex: 18,
  withdrawalIndex: 4,
  postedAt: t("2026-11-24T20:04:37Z"),
  batchAt: t("2026-11-24T20:04:45Z"),
  finalFrom: t("2026-11-24T21:04:45Z"),
  paidAt: t("2026-11-24T20:05:00Z"),
  repaidAt: t("2026-11-24T21:05:03Z"),
  frontGas: 472_177n,
  frontTx: "0x6542b5f393cd4b37f349ef3b2e9edfe103d81b2f675d4ee48c0bd2f2de627c8f",
};
const NOW = t("2026-11-27T17:10:49Z");

describe("the instant-exit ledger", () => {
  it("measures vigil-pay-1's two fronted exits, newest first", () => {
    const rows = ledgerRows([b15, b18], NOW);
    expect(rows.map((r) => r.batchIndex)).toEqual([18, 15]);
    expect(rows.map((r) => [r.postToPaidSec, r.batchToPaidSec, r.aheadOfFinalitySec, r.repaidAfterSec, r.repaidAfterFinalSec])).toEqual([
      [23, 15, 3585, 3603, 18],
      [186, 175, 3425, 4320, 895],
    ]);
    expect(rows.every((r) => r.outcome === "repaid")).toBe(true);
  });

  it("summarises them: medians, worst cases, repaid 2 of 2, no losses, fees", () => {
    const s = ledgerSummary(ledgerRows([b15, b18], NOW));
    expect(s.n).toBe(2);
    expect(s.postToPaid).toEqual({ median: 104.5, max: 186, min: 23, n: 2 });
    expect(s.batchToPaid).toEqual({ median: 95, max: 175, min: 15, n: 2 });
    expect(s.aheadOfFinality).toMatchObject({ median: 3505, min: 3425 });
    expect(s.frontGas).toMatchObject({ median: 472_159, n: 2 });
    expect([s.repaid, s.pending, s.overdue, s.owed]).toEqual([2, 0, 0, 0]);
    expect(s.feesWei).toBe(QOR / 1000n);
    expect(s.paidWei).toBe((QOR * 199n) / 1000n);
    expect(s.latestPaidAt).toBe(b18.paidAt);
  });

  it("calls an unrepaid exit pending until two hours after its batch could be final, then overdue", () => {
    const open = { ...b18, repaidAt: undefined };
    expect(ledgerRows([open], b18.finalFrom! + OVERDUE_SEC)[0]!.outcome).toBe("pending");
    expect(ledgerRows([open], b18.finalFrom! + OVERDUE_SEC + 1)[0]!.outcome).toBe("overdue");
    const s = ledgerSummary(ledgerRows([open, b15], b18.finalFrom! + OVERDUE_SEC + 1));
    expect([s.repaid, s.overdue]).toEqual([1, 1]);
    // Its fee is not earned until the vault is repaid.
    expect(s.feesWei).toBe(b15.feeWei);
    expect(ledgerSummary(ledgerRows([open], b18.paidAt! + 60)).feesWei).toBe(0n);
  });

  it("counts a front against a rejected or replaced batch as owed by its exit address, and not as fees", () => {
    const rows = ledgerRows([{ ...b18, batchStatus: "rejected", repaidAt: undefined }, { ...b15, batchStatus: "replaced", repaidAt: undefined }, { ...b18, id: "0xok" }], NOW);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["owed", "owed", "repaid"]);
    const s = ledgerSummary(rows);
    expect(s.owed).toBe(2);
    expect(s.owedWei).toBe(2n * (QOR / 10n));
    expect(s.feesWei).toBe((QOR * 5n) / 10_000n);
  });

  it("leaves a figure out when a time was not read, and says paid-after-finality as a negative lead", () => {
    const rows = ledgerRows([{ ...b18, postedAt: undefined, frontGas: undefined }, { ...b15, paidAt: b15.finalFrom! + 60 }], NOW);
    expect(rows.find((r) => r.batchIndex === 18)!.postToPaidSec).toBeUndefined();
    expect(rows.find((r) => r.batchIndex === 15)!.aheadOfFinalitySec).toBe(-60);
    const s = ledgerSummary(rows);
    expect(s.postToPaid).toMatchObject({ n: 1 });
    expect(s.frontGas).toMatchObject({ n: 1, median: 472_141 });
    expect(ledgerSummary([]).postToPaid).toBeUndefined();
  });

  it("takes the median of odd, even and empty lists", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });

  it("maps a fronted exit card, and skips one that was not fronted or could not be read", () => {
    const view = {
      id: b18.id,
      batchIndex: 18,
      withdrawalIndex: 4,
      claim: undefined,
      withdrawal: { entry: { time: b18.postedAt } },
      batch: { submittedTime: b18.batchAt, finalFrom: b18.finalFrom, status: "finalized" },
      fronted: { time: b18.paidAt, paid: b18.paidWei, fee: b18.feeWei, gasUsed: 472_177n, tx: b18.frontTx },
      repayment: { completedBy: { time: 0 } },
    } as unknown as ExitView;
    expect(ledgerExitOf(view)).toMatchObject({ amountUqor: 100_000n, postedAt: b18.postedAt, paidAt: b18.paidAt, frontGas: 472_177n, repaidAt: undefined });
    expect(ledgerExitOf({ ...view, fronted: undefined } as ExitView)).toBeUndefined();
    expect(ledgerExitOf({ ...view, error: "timeout" } as ExitView)).toBeUndefined();
  });

  it("agrees with the committed snapshot docs/exits-metrics.json", () => {
    const doc = JSON.parse(readFileSync(join(here, "../../../docs/exits-metrics.json"), "utf8")) as {
      readAt: string;
      chain: { challengeWindowSec: number };
      summary: Record<string, unknown>;
      exits: Record<string, string | number | null>[];
    };
    const sec = (v: string | number | null | undefined) => (typeof v === "string" ? t(v) : undefined);
    const wei = (q: string | number | null | undefined): bigint => {
      const [w, f = ""] = String(q).split(".");
      return BigInt(w!) * QOR + BigInt(f.padEnd(18, "0"));
    };
    const exits: LedgerExit[] = doc.exits.map((e) => ({
      id: String(e["exitId"]),
      batchIndex: Number(e["batchIndex"]),
      withdrawalIndex: Number(e["withdrawalIndex"]),
      amountUqor: wei(e["amountQor"]) / 1_000_000_000_000n,
      postedAt: sec(e["postedAt"]),
      batchAt: sec(e["batchAt"]),
      finalFrom: sec(e["couldBeFinalAt"]),
      paidAt: sec(e["paidAt"]),
      repaidAt: sec(e["repaidAt"]),
      paidWei: wei(e["paidQor"]),
      feeWei: wei(e["feeQor"]),
      frontGas: e["frontGas"] === null ? undefined : BigInt(e["frontGas"]!),
      frontTx: String(e["frontTx"]),
      batchStatus: String(e["batchStatus"]),
    }));
    for (const e of exits) expect(e.finalFrom! - e.batchAt!).toBe(doc.chain.challengeWindowSec);
    const s = ledgerSummary(ledgerRows(exits, t(doc.readAt)));
    const spread = (x: typeof s.postToPaid) => (x ? { n: x.n, median: x.median, min: x.min, max: x.max } : null);
    expect(doc.summary).toMatchObject({
      fronted: s.n,
      postToPaidSec: spread(s.postToPaid),
      batchToPaidSec: spread(s.batchToPaid),
      aheadOfFinalitySec: spread(s.aheadOfFinality),
      repaidAfterSec: spread(s.repaidAfter),
      frontGas: spread(s.frontGas),
      repaid: s.repaid,
      overdue: s.overdue,
      frontedOnRejectedBatch: s.owed,
    });
    expect(ledgerRows(exits, t(doc.readAt)).map((r) => r.postToPaidSec)).toEqual(doc.exits.map((e) => e["postToPaidSec"]));
  });
});
