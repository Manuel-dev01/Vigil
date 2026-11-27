/**
 * What the sentinel alerts on, as pure functions of one observation of the chain, so every rule is
 * tested offline. `evaluate` turns an observation into the set of conditions that hold now; `diff`
 * compares it with the previous set so a condition is announced once when it starts and once when it
 * clears, never on every check.
 */

import type { ExitWatch } from "./exits.ts";
import type { Verdict } from "./judge.ts";

export type Severity = "critical" | "warning";

export interface Condition {
  /** Stable id: the same problem keeps the same id while it lasts. */
  id: string;
  severity: Severity;
  text: string;
  /** Say it again this often (seconds) while it lasts; by default it is said once. */
  repeatSec?: number;
  /** What to say when it clears, instead of the first sentence of `text`. */
  cleared?: string;
}

export interface Account {
  name: string;
  qor1: string;
  /** Never allowed to have an EVM window (the creator, watchtowers, sequencers, keep-alive). */
  windowForbidden: boolean;
  /** Warn below this balance (uqor). */
  minUqor?: bigint;
  /** For keys that may open windows: warn if one stays open this long (seconds). */
  maxWindowSec?: number;
}

export interface Observation {
  /** Unix seconds of the observation. */
  now: number;
  balances: Record<string, bigint>;
  /** qor1 → whether a window exists, and since when (unix seconds) it has been seen. */
  windows: Record<string, { found: boolean; seenSince?: number }>;
  rollup: {
    /** Highest inbox sequence. */
    inboxHead: number;
    /** Inbox end of the newest batch. */
    batchedThrough: number;
    /** Unix seconds when the oldest unbatched entry was posted (undefined if none waiting). */
    oldestUnbatchedAt?: number;
    /** Unix seconds of the newest batch. */
    newestBatchAt: number;
    /** Batches whose status is challenged or rejected, as "index:status". */
    disputed: string[];
  };
  vault: {
    liquidityWei: bigint;
    totalOwedWei: bigint;
    /** Unix seconds since which totalOwed has been above zero (undefined if zero). */
    owedSince?: number;
  };
  /** Whether the web app answered, and with which commit. */
  web: { ok: boolean; detail: string };
  /** The rollup's challenge window (seconds), as the chain reports it. */
  challengeWindowSec?: number;
  /** Every live batch re-executed by the sentinel with the watchtower's core (judge.ts). */
  judged?: Verdict[];
  /** Consecutive checks on which that re-execution failed, and the last error. */
  judgeFailures?: { count: number; error: string };
  /** Withdrawals the exit relayer should front (exits.ts), with whether the vault has. */
  exits?: ExitWatch[];
}

export interface Thresholds {
  unbatchedSec: number;
  keepAliveSec: number;
  owedSec: number;
  minLiquidityWei: bigint;
  /** An exit the relayer serves should be fronted this soon after its batch. */
  frontSec: number;
  /** Re-execution failing this many checks in a row is reported. */
  judgeFailures: number;
  /** How often an unchallenged bad batch is announced again while it lasts. */
  badBatchRepeatSec: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  unbatchedSec: 10 * 60,
  keepAliveSec: 3 * 24 * 3600,
  // An exit is repaid after its batch is final (one hour) plus the relayer's pass; allow two hours.
  owedSec: 2 * 3600,
  minLiquidityWei: 300_000_000_000_000_000n,
  // The relayer's first automatic front came 11 blocks (15 s) after its batch (EVIDENCE 104).
  frontSec: 5 * 60,
  judgeFailures: 5,
  badBatchRepeatSec: 10 * 60,
};

/** The rollup's challenge window when the chain does not say (3,600 s on testnet). */
const DEFAULT_WINDOW_SEC = 3600;

const qor = (uqor: bigint): string => `${(Number(uqor) / 1e6).toFixed(3)} QOR`;
const mins = (s: number): string => (s >= 7200 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);

export function evaluate(o: Observation, accounts: Account[], t: Thresholds = DEFAULT_THRESHOLDS): Condition[] {
  const out: Condition[] = [];
  for (const a of accounts) {
    const w = o.windows[a.qor1];
    if (w?.found && a.windowForbidden) {
      out.push({ id: `window-forbidden:${a.qor1}`, severity: "critical", text: `${a.name} (${a.qor1}) has an EVM window open. This key must never open one: its ECDSA half could move funds. Close it and find out why.` });
    } else if (w?.found && a.maxWindowSec !== undefined && w.seenSince !== undefined && o.now - w.seenSince > a.maxWindowSec) {
      out.push({ id: `window-lingers:${a.qor1}`, severity: "warning", text: `${a.name}'s EVM window has been open for ${mins(o.now - w.seenSince)}; it should close right after its calls.` });
    }
    const bal = o.balances[a.qor1];
    if (a.minUqor !== undefined && bal !== undefined && bal < a.minUqor) {
      out.push({ id: `balance:${a.qor1}`, severity: "warning", text: `${a.name} holds ${qor(bal)}, below its floor of ${qor(a.minUqor)}.` });
    }
  }
  const r = o.rollup;
  if (r.oldestUnbatchedAt !== undefined && o.now - r.oldestUnbatchedAt > t.unbatchedSec) {
    out.push({ id: "sequencer-stuck", severity: "warning", text: `${r.inboxHead - r.batchedThrough} inbox entr${r.inboxHead - r.batchedThrough === 1 ? "y has" : "ies have"} waited ${mins(o.now - r.oldestUnbatchedAt)} without a batch. Keel (and keel-b after 30 blocks) should have batched them.` });
  }
  if (o.now - r.newestBatchAt > t.keepAliveSec) {
    out.push({ id: "keepalive-quiet", severity: "warning", text: `No new batch for ${mins(o.now - r.newestBatchAt)}. The keep-alive should post every 2 days.` });
  }
  for (const d of r.disputed) {
    out.push({ id: `disputed:${d}`, severity: "critical", text: `vigil-pay-1 batch ${d.replace(":", " is ")}. A challenge was made against the rollup; check the watchtowers' logs and EVIDENCE.` });
  }
  if (o.vault.liquidityWei < t.minLiquidityWei) {
    out.push({ id: "vault-liquidity", severity: "warning", text: `InstantExitVault liquidity is ${qor(o.vault.liquidityWei / 1_000_000_000_000n)}; exits larger than that cannot be paid early.` });
  }
  if (o.vault.owedSince !== undefined && o.now - o.vault.owedSince > t.owedSec) {
    out.push({ id: "vault-owed", severity: "warning", text: `The vault has been owed ${qor(o.vault.totalOwedWei / 1_000_000_000_000n)} for ${mins(o.now - o.vault.owedSince)}. The relayer should have executed and swept after finality.` });
  }
  if (!o.web.ok) out.push({ id: "web-down", severity: "warning", text: `The web app did not answer: ${o.web.detail}` });

  // Unchallenged bad batch: a batch that does not re-execute, with no challenge upheld (it would be
  // "rejected") once half its challenge window has passed. Watchtowers challenge within seconds, so by
  // then something is wrong with both of them; the rest of the window is the time left to act.
  const window = o.challengeWindowSec ?? DEFAULT_WINDOW_SEC;
  for (const v of o.judged ?? []) {
    if (v.kind !== "invalid" || v.status === "rejected") continue;
    const age = o.now - v.submittedTime;
    if (!(v.submittedTime > 0) || age < window / 2) continue;
    const left = v.submittedTime + window - o.now;
    out.push({
      id: `bad-batch:${v.batchIndex}:${v.stateRoot.slice(0, 16)}`,
      severity: "critical",
      repeatSec: t.badBatchRepeatSec,
      text:
        `UNCHALLENGED BAD BATCH: vigil-pay-1 batch ${v.batchIndex} does not re-execute (${v.mismatches.join(", ")} differ${v.mismatches.length === 1 ? "s" : ""}) and no challenge has been upheld ${mins(age)} after it was submitted. ` +
        (v.status === "finalized" ? "It is already final. " : left > 0 ? `Its challenge window closes in ${mins(left)}. ` : "Its challenge window has closed. ") +
        "Check both watchtowers now; anyone can challenge it with packages/qledger-watchtower.",
      cleared: `vigil-pay-1 batch ${v.batchIndex} is no longer an unchallenged bad batch (a challenge was upheld, or the chain no longer lists it).`,
    });
  }
  const jf = o.judgeFailures;
  if (jf && jf.count >= t.judgeFailures) {
    out.push({ id: "judge-failed", severity: "warning", text: `The sentinel could not re-execute vigil-pay-1's batches on ${jf.count} checks in a row, so the bad-batch check is blind: ${jf.error.slice(0, 160)}` });
  }
  for (const v of o.judged ?? []) {
    if (v.kind === "unjudged") {
      out.push({ id: "judge-unjudged", severity: "warning", text: `The sentinel cannot re-execute vigil-pay-1 from the batches the chain still lists: ${v.reason ?? "no honest starting state"}. The bad-batch check is blind until it can.` });
      break;
    }
  }

  // Instant exits: a withdrawal the relayer serves should be fronted within minutes of its batch.
  for (const x of o.exits ?? []) {
    if (x.fronted !== false || x.exempt) continue;
    const age = o.now - x.batchAt;
    if (!(x.batchAt > 0) || age <= t.frontSec) continue;
    out.push({
      id: `exit-not-fronted:${x.batchIndex}:${x.stateRoot.slice(0, 16)}:${x.withdrawalIndex}`,
      severity: "warning",
      text:
        `Batch ${x.batchIndex}'s withdrawal ${x.withdrawalIndex} to an exit address was not fronted within ${mins(t.frontSec)} of its batch (${mins(age)} so far). ` +
        `It pays ${qor(x.amountUqor)} to ${x.recipient}, the exit address of ${x.payout}. ` +
        "Check the watchtowers' attestations (daily budget, balance reserve), the vault's liquidity and the exit relayer. If nobody fronts it, it is paid in full after finality.",
      cleared: `batch ${x.batchIndex}'s withdrawal ${x.withdrawalIndex} is no longer waiting for a front (fronted late, or its batch is final and pays it in full).`,
    });
  }
  return out;
}

/** Active conditions due to be said again: those with `repeatSec` last said at least that long ago. */
export function repeats(active: Iterable<Condition>, lastSaid: ReadonlyMap<string, number>, now: number): Condition[] {
  return [...active].filter((c) => c.repeatSec !== undefined && now - (lastSaid.get(c.id) ?? 0) >= c.repeatSec);
}

/** What changed since the last check: conditions that started, and ones that cleared. */
export function diff(before: Map<string, Condition>, now: Condition[]): { started: Condition[]; cleared: Condition[] } {
  const ids = new Set(now.map((c) => c.id));
  return {
    started: now.filter((c) => !before.has(c.id)),
    cleared: [...before.values()].filter((c) => !ids.has(c.id)),
  };
}

export function formatAlert(c: Condition): string {
  return `${c.severity === "critical" ? "🚨 CRITICAL" : "⚠️ Warning"}: ${c.text}`;
}

export const formatCleared = (c: Condition): string => (c.cleared ? `✅ Resolved: ${c.cleared}` : `✅ Resolved: ${c.text.split(".")[0]}.`);
