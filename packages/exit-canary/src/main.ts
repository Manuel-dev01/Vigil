#!/usr/bin/env tsx
/**
 * vigil-exit-canary: one small instant exit, run on a schedule, so the whole exit path (watchtowers'
 * attestations, the relayer's front, execution and sweep after finality) is exercised every day and its
 * timings land in the vault's public history. See src/canary.ts for what one run posts.
 *
 *   tsx src/main.ts                                  # dry run, no key: reads the vault and the rollup
 *   tsx src/main.ts --key <canary key file>          # dry run: plans the exit and simulates the post
 *   tsx src/main.ts --key <canary key file> --broadcast [--amount 0.02] [--wait 900]
 *
 * It sends only with BOTH --broadcast and --key. The key file is the canary's own (written 0600, never
 * committed) and holds two keys:
 *   EXIT_CANARY_MNEMONIC   its L1 account (a unified hybrid account with its ML-DSA-87 key registered),
 *                          which posts and is the payout;
 *   QLEDGER_SEED_HEX       its L2 (ML-DSA-44) account, which withdraws.
 * It refuses, by address, every team key listed in the README (the creator, keel-b, the watchtowers, the
 * keep-alive, the relayer, the deployers, employer-1), and the rollup's creator and the vault's quorum and
 * LP as the chain reports them. It never opens an EVM window.
 *
 * Each run refuses to post when: the amount is outside 0.01 to 0.05 QOR; the canary already posted twice
 * in the last 24 hours; a batch awaits a challenge; entries are waiting for the sequencer; the vault's
 * liquidity cannot cover it; the poster's ML-DSA-87 key is not its registered key, or it has an EVM window.
 *
 * Exit status: 0 done (dry run planned, or posted and fronted); 1 failed or refused; 2 skipped (budget,
 * a batch awaiting a challenge, the sequencer not batching); 3 posted, but not fronted within --wait.
 *
 * Options: --amount <QOR> (EXIT_CANARY_AMOUNT, default 0.02), --wait <s> (default 900), --data <dir> (a
 * ledger snapshot to start the replay from, as for Keel's tools).
 */
import "@vigil/core/net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, createRdkClient, hexToBech32, postRollupDataMsg, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { TESTNET, restGet } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
// The relayer's vault client, by path: the relayer package is a service with a bin, not a library.
import { Vault } from "../../exit-relayer/src/vault.ts";
import { argValue, loadOperatorFrom, readEnvFile } from "@vigil/keel/account";
import { HybridSender } from "@vigil/keel/chain";
import { emptyState, newestSnapshot, snapshotPaths } from "@vigil/keel/snapshot";
import { syncLedger, withPending } from "@vigil/keel/sync";
import { getAddress, parseAbiItem, type Hex } from "viem";
import { DEFAULT_UQOR, parseAmount, planCanary, refusal, tooSoon } from "./canary.ts";

const EXIT = { ok: 0, failed: 1, skipped: 2, notFronted: 3 } as const;
const argv = process.argv.slice(2);
const broadcast = argv.includes("--broadcast");
const keyPath = argValue(argv, "--key");
const waitSec = Number(argValue(argv, "--wait") ?? "900");
const amount = argValue(argv, "--amount") ?? process.env["EXIT_CANARY_AMOUNT"];
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

function deployedVault(): Hex {
  for (const p of [resolve(repoRoot, "deployments/diana.json"), resolve(process.cwd(), "deployments/diana.json")]) {
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, "utf8")) as { InstantExitVault?: { address: Hex } };
      if (d.InstantExitVault) return getAddress(d.InstantExitVault.address);
    }
  }
  throw new Error("no InstantExitVault in deployments/diana.json");
}

const FRONTED = parseAbiItem("event Fronted(bytes32 indexed exitId, address indexed payout, uint64 batchIndex, uint64 withdrawalIndex, uint256 paid, uint256 fee)");

async function main(): Promise<number> {
  if (broadcast && !keyPath) throw new Error("--broadcast needs --key <the canary's own key file>");
  if (!(Number.isInteger(waitSec) && waitSec >= 60 && waitSec <= 3600)) throw new Error("--wait must be 60 to 3600 seconds");
  const amountUqor = amount ? parseAmount(amount) : DEFAULT_UQOR;

  // ---------------------------------------------------------------- the vault and the rollup, from chain
  const vault = new Vault(deployedVault(), TESTNET.evmRpc, TESTNET.evmChainId);
  const [vaultChain, rollupId, quorum, lp, feeBps, available] = await Promise.all([
    vault.read<string>("chainId"),
    vault.read<string>("rollupId"),
    vault.read<Hex[]>("quorum"),
    vault.read<Hex>("lp"),
    vault.read<number>("feeBps"),
    vault.read<bigint>("available"),
  ]);
  if (vaultChain !== TESTNET.chainId) throw new Error(`the vault serves ${vaultChain}, not ${TESTNET.chainId}`);
  const env = { chainId: TESTNET.chainId, rollupId };
  const rest = createRdkClient({ network: "testnet" }).rest;
  const rollup = await rest.getRollup(rollupId);
  const pay = (amountUqor * 1_000_000_000_000n * BigInt(10_000 - Number(feeBps))) / 10_000n;
  log("info", "canary_vault", { vault: vault.address, rollupId, quorum, lp, feeBps, availableWei: available, amountUqor, payWei: pay });
  if (available < pay) {
    log("error", "canary_refused", { reason: "the vault's liquidity cannot front this exit (it would be paid at finality instead)", availableWei: available, payWei: pay });
    return EXIT.failed;
  }
  if (!keyPath) {
    log("info", "canary_dry_run", { note: "no --key: nothing planned. Give the canary's own key file to plan and simulate; add --broadcast to send." });
    return EXIT.ok;
  }

  // ---------------------------------------------------------------- the canary's keys
  const vars = readEnvFile(keyPath);
  const seed = vars["QLEDGER_SEED_HEX"];
  if (!seed || !/^[0-9a-f]{64}$/i.test(seed)) throw new Error(`${keyPath} needs QLEDGER_SEED_HEX (64 hex characters) for the canary's L2 account`);
  const account = await loadOperatorFrom(Object.fromEntries(Object.entries(vars).filter(([k]) => k !== "QLEDGER_SEED_HEX")));
  const why = refusal({ cosmos: account.cosmos, evm: account.evm }, { creator: rollup.creator, quorum, lp });
  if (why) throw new Error(`refusing this key: ${why}`);
  const l2 = qledgerKeypairFromSeed(seed);
  const poster = new HybridSender(account);
  const payout = getAddress(account.evm);
  const exitAddress = hexToBech32(await vault.read<Hex>("exitAddressOf", [payout]), "qor");

  // ---------------------------------------------------------------- the rollup's state
  const snap = newestSnapshot(snapshotPaths(rollupId, repoRoot, [argValue(argv, "--data")]), env, {
    onSkip: (path, reason) => log("warn", "canary_snapshot_skipped", { path, reason }),
  });
  const reader = openInboxReader(env, { log: (event, fields) => log(event === "inbox_archive_rejected" ? "warn" : "info", event, fields) });
  const synced = await syncLedger(rest, reader, env, snap?.state ?? emptyState());
  if (synced.blocked) {
    log("error", "canary_skipped", { reason: `batch ${synced.blocked.batchIndex} is awaiting a challenge` });
    return EXIT.skipped;
  }
  const { ledger, pendingEntries, head } = await withPending(rest, reader, env, synced.state);
  if (pendingEntries > 0) {
    log("error", "canary_skipped", { reason: `${pendingEntries} inbox entries are waiting for the sequencer` });
    return EXIT.skipped;
  }

  // At most two runs a day, judged from the chain: the canary's own earlier posts (a notice and a
  // withdrawal per run, in one transaction and so one block).
  const ownHeights = [...new Set(reader.archive.range(0, reader.archive.head).filter((r) => r.poster === account.cosmos).map((r) => r.height))].sort((a, b) => b - a).slice(0, 2);
  const times = await Promise.all(
    ownHeights.map(async (h) => Math.floor(Date.parse((await restGet<{ block: { header: { time: string } } }>(`/cosmos/base/tendermint/v1beta1/blocks/${h}`)).block.header.time) / 1000)),
  );
  const soon = tooSoon(times, Math.floor(Date.now() / 1000));
  if (soon) {
    log("error", "canary_skipped", { reason: soon });
    return EXIT.skipped;
  }

  // ---------------------------------------------------------------- the posts
  const plan = planCanary({ env, ledger, l2, vault: vault.address, payout, exitAddress, amount: amountUqor });
  const [pqc, windowOpen, balance] = await Promise.all([fetchPqcStatus({ rest: TESTNET.rest, address: poster.address }), poster.evmWindowOpen(), poster.balanceUqor()]);
  if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) throw new Error("the canary's ML-DSA-87 key is not its registered key");
  if (windowOpen) throw new Error("the canary has an open EVM window; its key must stay hybrid-only");
  const msgs = [postRollupDataMsg({ poster: poster.address, rollupId, data: plan.notice }), postRollupDataMsg({ poster: poster.address, rollupId, data: plan.withdrawal })];
  const sim = await poster.simulate(msgs);
  if (!sim.ok || sim.gasUsed === undefined) throw new Error(`simulation failed: ${sim.error ?? "no gas reported"}`);
  const planned = {
    rollupId,
    poster: poster.address,
    posterBalanceUqor: balance,
    l2Account: bytesToHex(l2.accountId).slice(0, 16),
    amountUqor,
    payout,
    exitAddress,
    withdrawalIndex: plan.withdrawalIndex,
    afterBatch: synced.state.batchIndex,
    inboxHead: head,
    gas: sim.gasUsed,
  };
  if (!broadcast) {
    log("info", "canary_simulated", { ...planned, note: "dry run: add --broadcast to send" });
    return EXIT.ok;
  }

  // ---------------------------------------------------------------- send, then watch (read-only)
  const fromBlock = await vault.pub.getBlockNumber();
  const res = await poster.send(msgs, sim.gasUsed);
  const postedAt = Date.now();
  log("info", "canary_posted", { ...planned, tx: res.transactionHash, height: res.height, feeUqor: res.feeUqor });
  for (const deadline = postedAt + waitSec * 1000; Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 15_000));
    const logs = await vault.pub.getLogs({ address: vault.address, event: FRONTED, args: { payout }, fromBlock }).catch(() => []);
    const f = logs.at(-1);
    if (f) {
      log("info", "canary_fronted", {
        tx: f.transactionHash,
        evmBlock: f.blockNumber,
        batchIndex: f.args.batchIndex,
        withdrawalIndex: f.args.withdrawalIndex,
        paidWei: f.args.paid,
        secondsAfterPost: Math.round((Date.now() - postedAt) / 1000),
        note: "the relayer executes it and sweeps the exit address back to the vault after finality",
      });
      return EXIT.ok;
    }
  }
  log("error", "canary_not_fronted", { waitedSec: waitSec, hint: "the sentinel warns too; check the watchtowers' attestations, the vault's liquidity and the relayer. The withdrawal is paid in full after finality either way." });
  return EXIT.notFronted;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", "canary_failed", { reason: (err as Error).message });
    process.exit(EXIT.failed);
  });

