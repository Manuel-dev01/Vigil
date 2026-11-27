/**
 * Instant exits the relayer should front, found the way the relayer finds them (packages/exit-relayer):
 * a withdrawal in a valid, unfinalized batch whose recipient is the exit address of a payout it serves.
 * The relayer serves payouts announced with a payout notice, configured ones, and the inbox's own
 * posters; the sentinel watches the same set. Pure, so it is tested offline; observe.ts adds whether
 * the vault has fronted each one (its public `fronted(exitId)`).
 */
import { bech32ToHex, type QledgerEntry } from "@qorechain/rdk";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { decodePayoutNotice } from "../../qledger-watchtower/src/exits.ts";
import type { Verdict } from "./judge.ts";

/** One withdrawal the relayer should front. */
export interface ExitWatch {
  batchIndex: number;
  stateRoot: string;
  withdrawalIndex: number;
  amountUqor: bigint;
  /** The exit address the withdrawal pays (qor1). */
  recipient: string;
  /** The payout it belongs to, 0x + 40 hex. */
  payout: string;
  /** The batch's submission time (unix seconds). */
  batchAt: number;
  /** The vault's id for it: keccak256(abi.encode(batchIndex, stateRoot, withdrawalIndex)). */
  exitId: Hex;
  /** Set when the relayer is not expected to front it, and why. */
  exempt?: string;
  /** Whether the vault has fronted it (filled in by observe.ts). */
  fronted?: boolean;
}

export interface ExitRules {
  /** The relayer's minimum exit (EXIT_MIN_UQOR, default 10,000 uqor). */
  minExitUqor: bigint;
  /** The watchtowers' cap on claims per batch (WATCHTOWER_EXIT_MAX_CLAIMS, default 4): a batch with more is not attested. */
  maxClaimsPerBatch: number;
}

export const DEFAULT_EXIT_RULES: ExitRules = { minExitUqor: 10_000n, maxClaimsPerBatch: 4 };

const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

/** The vault's exit id, as InstantExitVault.exitId computes it. */
export const exitIdOf = (batchIndex: number, stateRoot: string, withdrawalIndex: number): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }, { type: "uint64" }], [BigInt(batchIndex), `0x${norm(stateRoot)}`, BigInt(withdrawalIndex)]));

/** A 20-byte address (40 hex, lower case) of a qor1 address, or undefined for anything else. */
function hex20(qor1: string): string | undefined {
  try {
    const h = norm(bech32ToHex(qor1));
    return h.length === 40 ? h : undefined;
  } catch {
    return undefined;
  }
}

/** Payouts the relayer would learn from these entries: payout notices for `vault`, and the posters. 0x + 40 hex, lower case. */
export function payoutsIn(entries: readonly Pick<QledgerEntry, "poster" | "payload">[], vault: string): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.poster && !e.poster.startsWith("deposit:")) {
      const p = hex20(e.poster);
      if (p) out.add(`0x${p}`);
    }
    const n = decodePayoutNotice(e.payload);
    if (n && norm(n.vault) === norm(vault)) out.add(`0x${norm(n.payout)}`);
  }
  return [...out];
}

/**
 * The withdrawals to watch: from valid batches still waiting for finality ("submitted"), each paying the
 * exit address of a known payout. `exitToPayout` maps an exit address (qor1) to its payout.
 */
export function exitsToWatch(verdicts: readonly Verdict[], exitToPayout: ReadonlyMap<string, string>, rules: ExitRules = DEFAULT_EXIT_RULES): ExitWatch[] {
  const out: ExitWatch[] = [];
  for (const v of verdicts) {
    if (v.kind !== "valid" || v.status !== "submitted" || v.withdrawals.length === 0) continue;
    // The watchtowers sign one claim per withdrawal to a 20-byte address, and none if there are more than the cap.
    const claims = v.withdrawals.filter((w) => hex20(w.recipient) !== undefined).length;
    for (const w of v.withdrawals) {
      const payout = exitToPayout.get(w.recipient);
      if (!payout) continue;
      const exempt =
        claims > rules.maxClaimsPerBatch
          ? `its batch has ${claims} exit-eligible withdrawals, over the watchtowers' cap of ${rules.maxClaimsPerBatch}, so it is paid at finality by design`
          : w.amount < rules.minExitUqor
            ? `it is below the relayer's minimum exit of ${rules.minExitUqor} uqor`
            : undefined;
      out.push({
        batchIndex: v.batchIndex,
        stateRoot: v.stateRoot,
        withdrawalIndex: Number(w.index),
        amountUqor: w.amount,
        recipient: w.recipient,
        payout,
        batchAt: v.submittedTime,
        exitId: exitIdOf(v.batchIndex, v.stateRoot, Number(w.index)),
        ...(exempt !== undefined && { exempt }),
      });
    }
  }
  return out;
}
