/**
 * Which fronted exit each repayment paid back.
 *
 * The vault records what it is owed per payout, not per exit: `owed[payout]` grows by each front and
 * shrinks by each `Settled(payout, repaid, stillOwed)`. When one payout has several fronted exits, a
 * sweep repays them together. The page attributes each repayment to that payout's fronted exits
 * first in, first out, and to each exit only up to what it owed (its amount, paid plus fee), counting
 * only fronts made before the repayment.
 */

export interface FrontLike {
  /** The exit's id. */
  id: string;
  payout: string;
  block: number;
  logIndex: number;
  /** What the front made the payout owe for this exit (paid + fee), in wei. */
  owed: bigint;
}

export interface SettleLike {
  payout: string;
  block: number;
  logIndex: number;
  repaid: bigint;
}

export interface Repayment<S extends SettleLike> {
  owed: bigint;
  /** Repaid so far, at most `owed`. */
  repaid: bigint;
  /** The repayments that paid this exit, with the part of each that went to it. */
  shares: { settle: S; amount: bigint }[];
  /** The repayment that brought this exit to zero, if any has. */
  completedBy: S | undefined;
}

const before = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }): boolean =>
  a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex);
const order = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }): number => a.block - b.block || a.logIndex - b.logIndex;

/** Attribute every repayment to fronted exits, FIFO per payout. Keyed by exit id. */
export function attributeRepayments<F extends FrontLike, S extends SettleLike>(fronts: readonly F[], settles: readonly S[]): Map<string, Repayment<S>> {
  const out = new Map<string, Repayment<S>>();
  for (const f of fronts) out.set(f.id, { owed: f.owed, repaid: 0n, shares: [], completedBy: undefined });
  const key = (p: string) => p.toLowerCase();
  const frontsBy = new Map<string, F[]>();
  for (const f of [...fronts].sort(order)) {
    const k = key(f.payout);
    frontsBy.set(k, [...(frontsBy.get(k) ?? []), f]);
  }
  for (const s of [...settles].sort(order)) {
    let left = s.repaid;
    for (const f of frontsBy.get(key(s.payout)) ?? []) {
      if (left <= 0n) break;
      if (!before(f, s)) break; // later fronts cannot be repaid by an earlier sweep
      const r = out.get(f.id)!;
      const due = r.owed - r.repaid;
      if (due <= 0n) continue;
      const take = left < due ? left : due;
      r.repaid += take;
      r.shares.push({ settle: s, amount: take });
      if (r.repaid === r.owed) r.completedBy = s;
      left -= take;
    }
  }
  return out;
}
