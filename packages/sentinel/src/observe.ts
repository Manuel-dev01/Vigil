/**
 * One look at the chain: balances, EVM windows, the rollup's inbox and batches, the instant-exit vault
 * and the web app. Read-only (REST GETs, eth_call, an HTTP GET); the sentinel holds no key.
 */
import { createRdkClient } from "@qorechain/rdk";
import { TESTNET, restGet } from "@vigil/core";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import type { Account, Observation } from "./rules.ts";

const VAULT_ABI = parseAbi(["function totalOwed() view returns (uint256)"]);

export interface ObserverConfig {
  rollupId: string;
  vault: Hex;
  webUrl: string;
  accounts: Account[];
}

/** State carried between looks, so "for how long" questions can be answered. */
export interface Memory {
  windowSince: Map<string, number>;
  owedSince?: number;
}

export function observer(cfg: ObserverConfig) {
  const rdk = createRdkClient({ network: "testnet" });
  const evm = createPublicClient({ transport: http(TESTNET.evmRpc, { timeout: 30_000, retryCount: 2 }) });
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
    };
  };
}
