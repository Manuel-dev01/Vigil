/**
 * When to stop challenging a batch, as pure functions so they are tested offline. The rule: give a
 * batch up only on what the chain shows (upheld, no longer `submitted`, replaced, or a proof the chain
 * would refuse). Anything else is transient and is retried while the batch can still be challenged.
 */
import { OUT_OF_GAS } from "./challenger.ts";
import type { PublishedBatch } from "./check.ts";

const norm = (s: string): string => s.toLowerCase().replace(/^0x/, "");

/** What the chain's current view of the batch means for a challenge against `batch`. */
export function currentBatchDecision(
  batch: PublishedBatch,
  now: { status: string; stateRoot: string; withdrawalsRoot: string } | undefined,
): { action: "proceed" } | { action: "settle"; reason: string } {
  if (!now) return { action: "settle", reason: "batch gone" };
  if (now.status !== "submitted") return { action: "settle", reason: `batch is ${now.status}` };
  if (norm(now.stateRoot) !== norm(batch.stateRoot) || norm(now.withdrawalsRoot) !== norm(batch.withdrawalsRoot)) {
    return { action: "settle", reason: "batch replaced" };
  }
  return { action: "proceed" };
}

/** What a delivered challenge's result means. */
export function challengeResultDecision(r: { code: number; rawLog: string }): "upheld" | "out-of-gas" | "lost" | "retry" {
  if (r.code === 0) return "upheld";
  if (r.code === OUT_OF_GAS) return "out-of-gas";
  // Someone else's challenge landed first, or the window closed.
  if (/rejected|finalized|not challengeable|already/i.test(r.rawLog)) return "lost";
  return "retry";
}

/** Milliseconds to wait before attempt `attempt + 1`: 2 s, 4 s, … capped at 60 s. */
export const backoffMs = (attempt: number): number => Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt, 1), 6));
