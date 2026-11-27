/**
 * One look at the chain: balances, EVM windows, the rollup's inbox and batches, the instant-exit vault
 * and the web app. Read-only (REST GETs, eth_call, an HTTP GET); the sentinel holds no key.
 *
 * It also re-executes every new batch with the watchtower's core (judge.ts), reading only the inbox
 * entries it has not read yet (the committed archive supplies pruned ones), and asks the vault whether
 * each withdrawal the exit relayer serves has been fronted (exits.ts).
 */
import { createRdkClient, hexToBech32 } from "@qorechain/rdk";
import { TESTNET, restGet } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { createPublicClient, getAddress, http, parseAbi, type Hex } from "viem";
import { DEFAULT_EXIT_RULES, exitsToWatch, payoutsIn, type ExitRules } from "./exits.ts";
import { BatchJudge, readerSource, type ChainBatch } from "./judge.ts";
import type { Account, Observation } from "./rules.ts";

const VAULT_ABI = parseAbi([
  "function totalOwed() view returns (uint256)",
  "function fronted(bytes32 exitId) view returns (bool)",
  "function exitAddressOf(address payout) view returns (address)",
]);

export interface ObserverConfig {
  rollupId: string;
  vault: Hex;
  webUrl: string;
  accounts: Account[];
  /** Payouts the exit relayer is configured with (EXIT_PAYOUTS), 0x; contracts are watched only if listed here. */
  payouts?: string[];
  exitRules?: ExitRules;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** State carried between looks, so "for how long" questions can be answered. */
export interface Memory {
  windowSince: Map<string, number>;
  owedSince?: number;
  /** Consecutive looks on which re-executing the batches failed. */
  judgeFailures?: { count: number; error: string };
}

export function observer(cfg: ObserverConfig) {
  const rdk = createRdkClient({ network: "testnet" });
  const evm = createPublicClient({ transport: http(TESTNET.evmRpc, { timeout: 30_000, retryCount: 2 }) });
  const env = { chainId: TESTNET.chainId, rollupId: cfg.rollupId };
  const log = cfg.log ?? (() => {});
  // The inbox, read once by sequence and kept in memory; the committed archive covers what the chain pruned.
  const reader = openInboxReader(env, { log: (event, fields) => log(`inbox-${event}`, fields) });
  const judge = new BatchJudge(env, readerSource(reader));
  const configured = new Set((cfg.payouts ?? []).map((p) => p.toLowerCase()));
  /** exit address (qor1) → payout (0x); payouts already looked up; the last `fronted` read for each exit id. */
  const exitToPayout = new Map<string, string>();
  const looked = new Set<string>();
  const frontedKnown = new Map<string, boolean>();
  let payoutsThrough = 0;
  let windowSec: number | undefined;

  /** Learn the payouts announced in batched entries the sentinel has not scanned yet. */
  async function learnPayouts(through: number): Promise<void> {
    if (through <= payoutsThrough) return;
    const entries = await reader.entries(payoutsThrough, through);
    for (const p of [...payoutsIn(entries, cfg.vault), ...configured]) {
      if (looked.has(p)) continue;
      const address = getAddress(p);
      // Like the relayer: a payout that is a contract is served only if configured.
      if (!configured.has(p)) {
        const code = await evm.getCode({ address });
        if (code && code !== "0x") {
          looked.add(p);
          continue;
        }
      }
      const ea = await evm.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "exitAddressOf", args: [address] });
      exitToPayout.set(hexToBech32(ea, "qor"), p);
      looked.add(p);
    }
    payoutsThrough = through;
  }
  const blockTime = new Map<number, number>();
  const timeOf = async (height: number): Promise<number> => {
    const hit = blockTime.get(height);
    if (hit !== undefined) return hit;
    const b = await restGet<{ block: { header: { time: string } } }>(`/cosmos/base/tendermint/v1beta1/blocks/${height}`);
    const t = Math.floor(Date.parse(b.block.header.time) / 1000);
    blockTime.set(height, t);
    return t;
  };

  return async function observe(mem: Memory): Promise<Observation> {
    const now = Math.floor(Date.now() / 1000);
    const balances: Observation["balances"] = {};
    const windows: Observation["windows"] = {};
    await Promise.all(
      cfg.accounts.map(async (a) => {
        const [b, w] = await Promise.all([
          restGet<{ balance?: { amount?: string } }>(`/cosmos/bank/v1beta1/balances/${a.qor1}/by_denom?denom=uqor`),
          restGet<{ found?: boolean }>(`/qorechain/pqc/v1/evm_window/${a.qor1}`),
        ]);
        balances[a.qor1] = BigInt(b.balance?.amount ?? "0");
        const found = w.found === true;
        if (found && !mem.windowSince.has(a.qor1)) mem.windowSince.set(a.qor1, now);
        if (!found) mem.windowSince.delete(a.qor1);
        windows[a.qor1] = { found, ...(found && { seenSince: mem.windowSince.get(a.qor1)! }) };
      }),
    );

    const inboxHead = Number((await rdk.rest.getInbox(cfg.rollupId)).headSequence);
    const batches = await rdk.rest.listBatches(cfg.rollupId);
    const live = batches.filter((b) => b.status !== "rejected");
    const newest = live.reduce((m, b) => (b.batchIndex > m.batchIndex ? b : m), live[0]!);
    const batchedThrough = Math.max(0, ...live.map((b) => b.inboxEnd));
    let oldestUnbatchedAt: number | undefined;
    if (inboxHead > batchedThrough) {
      const p = await rdk.rest.getPostedData(cfg.rollupId, batchedThrough + 1);
      oldestUnbatchedAt = await timeOf(p.height);
    }
    // Disputes from the last two days only: the fraud drills of 19 Nov left rejected batches for good.
    const disputed = batches
      .filter((b) => (b.status === "challenged" || b.status === "rejected") && (b.submittedTime ?? 0) > now - 2 * 86_400)
      .map((b) => `${b.batchIndex}:${b.status}`);

    // Re-execute every batch not judged yet; a failure here must not stop the other checks. When it fails,
    // `judged` or `exits` stay undefined and rules.ts `unseen` keeps their alerts active rather than resolved.
    windowSec ??= await rdk.rest.getRollup(cfg.rollupId).then(
      (r) => r.challengeWindowSec,
      () => undefined,
    );
    let judged: Observation["judged"];
    let exits: Observation["exits"];
    try {
      judged = await judge.sync(batches as ChainBatch[]);
      await learnPayouts(batchedThrough);
      exits = exitsToWatch(judged, exitToPayout, cfg.exitRules ?? DEFAULT_EXIT_RULES);
      for (const x of exits) {
        if (x.exempt) continue;
        let f = frontedKnown.get(x.exitId);
        if (f !== true) {
          // A failed read keeps the last value read (or none: then nothing is said either way).
          const read = await evm.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "fronted", args: [x.exitId] }).catch(() => undefined);
          if (read !== undefined) frontedKnown.set(x.exitId, (f = read));
        }
        if (f !== undefined) x.fronted = f;
      }
      delete mem.judgeFailures;
    } catch (e) {
      const error = (e as Error).message.slice(0, 200);
      mem.judgeFailures = { count: (mem.judgeFailures?.count ?? 0) + 1, error };
      log("judge-failed", { failures: mem.judgeFailures.count, error });
    }

    const [liquidityWei, totalOwedWei] = await Promise.all([
      evm.getBalance({ address: cfg.vault }),
      evm.readContract({ address: cfg.vault, abi: VAULT_ABI, functionName: "totalOwed" }),
    ]);
    if (totalOwedWei > 0n) mem.owedSince ??= now;
    else delete mem.owedSince;

    let web: Observation["web"];
    try {
      const r = await fetch(`${cfg.webUrl}/version.json`, { signal: AbortSignal.timeout(20_000) });
      const v = r.ok ? ((await r.json()) as { commit?: string }) : undefined;
      web = r.ok ? { ok: true, detail: `commit ${(v?.commit ?? "?").slice(0, 7)}` } : { ok: false, detail: `HTTP ${r.status}` };
    } catch (e) {
      web = { ok: false, detail: (e as Error).message.slice(0, 120) };
    }

    return {
      now,
      balances,
      windows,
      rollup: { inboxHead, batchedThrough, ...(oldestUnbatchedAt !== undefined && { oldestUnbatchedAt }), newestBatchAt: newest?.submittedTime ?? now, disputed },
      vault: { liquidityWei, totalOwedWei, ...(mem.owedSince !== undefined && { owedSince: mem.owedSince }) },
      web,
      ...(windowSec !== undefined && { challengeWindowSec: windowSec }),
      ...(judged && { judged }),
      ...(mem.judgeFailures && { judgeFailures: mem.judgeFailures }),
      ...(exits && { exits }),
    };
  };
}
