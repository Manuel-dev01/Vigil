/**
 * The "Every instant exit" ledger: one row per fronted exit, and a summary row, from times the page (or
 * scripts/exit/metrics.ts) has already read from the chain. Pure, with no imports, so the web app and the
 * metrics script compute the same numbers and both are tested offline.
 *
 * Every time is a block time in unix seconds, as the node reports it: the L2 withdrawal's post (QoreChain
 * block), the batch's submission (QoreChain block), the front() and the repaying sweep() (EVM blocks of
 * the same chain). Nothing here is measured on a wall clock.
 */

/** What is known about one fronted exit. Undefined means "not read". */
export interface LedgerExit {
  /** The vault's exit id, 0x + 64 hex. */
  id: string;
  batchIndex: number;
  withdrawalIndex: number;
  amountUqor: bigint | undefined;
  /** When the L2 withdrawal was posted into the inbox. */
  postedAt: number | undefined;
  /** When its batch was submitted. */
  batchAt: number | undefined;
  /** The earliest time its batch could be final: submitted plus the challenge window. */
  finalFrom: number | undefined;
  /** When front() paid it. */
  paidAt: number | undefined;
  /** When a sweep() finished repaying the vault for it. */
  repaidAt: number | undefined;
  /** What front() paid the payout, and the fee the vault kept (wei). */
  paidWei: bigint | undefined;
  feeWei: bigint | undefined;
  /** Gas the front() transaction used, from its receipt. */
  frontGas: bigint | undefined;
  frontTx: string | undefined;
  /** The chain's status for the batch ("submitted", "finalized", "pruned", "rejected", "replaced", …). */
  batchStatus: string | undefined;
}

/**
 * repaid: a sweep() repaid the vault. pending: waiting for finality and the sweep. overdue: not repaid
 * OVERDUE_SEC after the batch could be final. owed: fronted against a batch that was then rejected or
 * replaced, so its exit address owes the vault, and that address's later withdrawals repay it first
 * (THREAT_MODEL §14, "Bad claim, user debt"): not a certain loss to the LP.
 */
export type Outcome = "repaid" | "pending" | "overdue" | "owed";

export interface LedgerRow extends LedgerExit {
  postToPaidSec: number | undefined;
  batchToPaidSec: number | undefined;
  /** finalFrom − paidAt: how long before its batch could be final it was paid (negative: after). */
  aheadOfFinalitySec: number | undefined;
  /** repaidAt − paidAt: how long the LP's money was out. */
  repaidAfterSec: number | undefined;
  /** repaidAt − finalFrom: how long after the batch could be final the vault was repaid. */
  repaidAfterFinalSec: number | undefined;
  outcome: Outcome;
}

export interface Spread {
  median: number;
  max: number;
  min: number;
  /** How many rows had this figure. */
  n: number;
}

export interface LedgerSummary {
  /** Fronted exits in the ledger. */
  n: number;
  postToPaid: Spread | undefined;
  batchToPaid: Spread | undefined;
  aheadOfFinality: Spread | undefined;
  repaidAfter: Spread | undefined;
  frontGas: Spread | undefined;
  repaid: number;
  pending: number;
  /** Not repaid OVERDUE_SEC after the batch could be final: the relayer should have executed and swept. */
  overdue: number;
  /** Fronted against a batch that was then rejected or replaced: owed to the vault by its exit address. */
  owed: number;
  owedWei: bigint;
  /** Fees on exits the vault has been repaid for. */
  feesWei: bigint;
  paidWei: bigint;
  /** The newest front(), unix seconds. */
  latestPaidAt: number | undefined;
}

/**
 * How long after its batch could be final a fronted exit may stay unrepaid before it counts as overdue:
 * the same two hours the sentinel allows (packages/sentinel, `owedSec`).
 */
export const OVERDUE_SEC = 2 * 3600;

const diff = (a: number | undefined, b: number | undefined): number | undefined => (a !== undefined && b !== undefined && a > 0 && b > 0 ? a - b : undefined);

/** The median of a list of numbers (the mean of the middle two for an even count). */
export function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function spread(xs: (number | undefined)[]): Spread | undefined {
  const v = xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
  if (v.length === 0) return undefined;
  return { median: median(v)!, max: Math.max(...v), min: Math.min(...v), n: v.length };
}

export function outcomeOf(e: LedgerExit, nowSec: number): Outcome {
  if (e.batchStatus === "rejected" || e.batchStatus === "replaced") return "owed";
  if (e.repaidAt !== undefined) return "repaid";
  if (e.finalFrom !== undefined && nowSec > e.finalFrom + OVERDUE_SEC) return "overdue";
  return "pending";
}

export function ledgerRow(e: LedgerExit, nowSec: number): LedgerRow {
  return {
    ...e,
    postToPaidSec: diff(e.paidAt, e.postedAt),
    batchToPaidSec: diff(e.paidAt, e.batchAt),
    aheadOfFinalitySec: diff(e.finalFrom, e.paidAt),
    repaidAfterSec: diff(e.repaidAt, e.paidAt),
    repaidAfterFinalSec: diff(e.repaidAt, e.finalFrom),
    outcome: outcomeOf(e, nowSec),
  };
}

/** Rows, newest front first (ties: higher batch, then higher withdrawal index). */
export function ledgerRows(exits: readonly LedgerExit[], nowSec: number): LedgerRow[] {
  return exits
    .map((e) => ledgerRow(e, nowSec))
    .sort((x, y) => (y.paidAt ?? 0) - (x.paidAt ?? 0) || y.batchIndex - x.batchIndex || y.withdrawalIndex - x.withdrawalIndex);
}

export function ledgerSummary(rows: readonly LedgerRow[]): LedgerSummary {
  const owed = rows.filter((r) => r.outcome === "owed");
  const sum = (xs: (bigint | undefined)[]): bigint => xs.reduce<bigint>((n, x) => n + (x ?? 0n), 0n);
  const paid = rows.map((r) => r.paidAt).filter((t): t is number => t !== undefined && t > 0);
  return {
    n: rows.length,
    postToPaid: spread(rows.map((r) => r.postToPaidSec)),
    batchToPaid: spread(rows.map((r) => r.batchToPaidSec)),
    aheadOfFinality: spread(rows.map((r) => r.aheadOfFinalitySec)),
    repaidAfter: spread(rows.map((r) => r.repaidAfterSec)),
    frontGas: spread(rows.map((r) => (r.frontGas === undefined ? undefined : Number(r.frontGas)))),
    repaid: rows.filter((r) => r.outcome === "repaid").length,
    pending: rows.filter((r) => r.outcome === "pending").length,
    overdue: rows.filter((r) => r.outcome === "overdue").length,
    owed: owed.length,
    owedWei: sum(owed.map((r) => (r.paidWei === undefined ? undefined : r.paidWei + (r.feeWei ?? 0n)))),
    feesWei: sum(rows.filter((r) => r.outcome === "repaid").map((r) => r.feeWei)),
    paidWei: sum(rows.map((r) => r.paidWei)),
    latestPaidAt: paid.length ? Math.max(...paid) : undefined,
  };
}

/** Below this many rows the page and the metrics file call the sample small. */
export const SMALL_SAMPLE = 20;
