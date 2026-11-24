#!/usr/bin/env tsx
/**
 * vigil-exit-relayer: pays InstantExitVault exits automatically (see src/relayer.ts).
 *
 *   tsx src/main.ts --once                                  # observe: one pass, prints what it would send
 *   tsx src/main.ts --env ../../.env.exit-relayer --once    # observe with the key (simulates executions too)
 *   tsx src/main.ts --env ../../.env.exit-relayer --mode relay
 *
 * Options (each also read from the environment variable named):
 *   --vault <0x…>         EXIT_VAULT, default the InstantExitVault in deployments/diana.json
 *   --rollup <id>         EXIT_ROLLUP, default the vault's rollupId()
 *   --mode relay|observe  EXIT_RELAYER_MODE, default observe (sends nothing)
 *   --payouts <list>      EXIT_PAYOUTS: comma list of payouts (qor1… or 0x…) to serve, besides those
 *                         announced in the inbox with a payout notice and the inbox's own posters
 *   --interval <s>        EXIT_RELAYER_INTERVAL, default 6
 *   --front-margin <s>    EXIT_FRONT_MARGIN, default 60: leave claims this close to their deadline alone
 *   --lookback <n>        EXIT_LOOKBACK, default 500 inbox entries read back on start
 *   --archive <file>      EXIT_INBOX_ARCHIVE: keep an inbox archive there (on a volume, say). Without it the
 *                         relayer keeps entries in memory; either way the repository's committed archive
 *                         (data/inbox/<rollup>.jsonl) supplies entries the chain has pruned
 *   --window-blocks <n>   EXIT_WINDOW_BLOCKS, default 150 (about 3.5 minutes)
 *   --min-exit <uqor>     EXIT_MIN_UQOR, default 10000: never front a smaller exit (each costs ~0.13 QOR)
 *   --min-balance <uqor>  EXIT_MIN_BALANCE, default 300000: send nothing below this balance
 *   --windows-per-hour <n> EXIT_WINDOWS_PER_HOUR, default 6
 *   --env <file>          a .env with the relayer's key (local runs). Hosted, the key is the secret
 *                         variable RELAYER_MNEMONIC instead.
 *   --once                one pass, then exit
 *
 * The key must be the relayer's own: never the rollup creator's, a quorum member's or the LP's. It needs
 * its ML-DSA-87 key registered (every native transaction is hybrid-signed, and only that key can open
 * an EVM window). One relayer per key. Logs are JSON lines; secrets are never logged.
 */
import "@vigil/core/net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bech32ToHex, createRdkClient, createRdkRegistry } from "@qorechain/rdk";
import { fetchPqcStatus, isRegisteredPqcKey, qorechainRegistryTypes, type UnifiedAccount } from "@qorechain/sdk";
import { TESTNET } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { loadOperator, loadOperatorFrom } from "@vigil/keel/account";
import { HybridSender } from "@vigil/keel/chain";
import { getAddress, type Hex } from "viem";
import { Relayer, type Quorum } from "./relayer.ts";
import { Vault } from "./vault.ts";

const args = process.argv.slice(2);
const opt = (flag: string, env: string, d?: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : process.env[env] || d);
const once = args.includes("--once");
const mode = opt("--mode", "EXIT_RELAYER_MODE", "observe");
if (mode !== "relay" && mode !== "observe") throw new Error(`--mode must be relay or observe, not ${mode}`);
/** A whole number of at least `min`, or exit with a clear message (a typo must not become NaN). */
function int(flag: string, env: string, d: string, min: number): number {
  const raw = opt(flag, env, d)!;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} (${env}) must be a whole number >= ${min}, not "${raw}"`);
  return n;
}
const intervalMs = int("--interval", "EXIT_RELAYER_INTERVAL", "6", 1) * 1000;
const frontMarginSec = int("--front-margin", "EXIT_FRONT_MARGIN", "60", 0);
const lookback = int("--lookback", "EXIT_LOOKBACK", "500", 1);
const windowBlocks = int("--window-blocks", "EXIT_WINDOW_BLOCKS", "150", 20);
const minExitUqor = BigInt(int("--min-exit", "EXIT_MIN_UQOR", "10000", 1));
const minBalanceUqor = BigInt(int("--min-balance", "EXIT_MIN_BALANCE", "300000", 0));
const windowsPerHour = int("--windows-per-hour", "EXIT_WINDOWS_PER_HOUR", "6", 1);

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

function deployedVault(): Hex {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, "../../../deployments/diana.json"), resolve(process.cwd(), "deployments/diana.json")]) {
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, "utf8")) as { InstantExitVault?: { address: Hex } };
      if (d.InstantExitVault) return d.InstantExitVault.address;
    }
  }
  throw new Error("no --vault given and no InstantExitVault in deployments/diana.json");
}

const toHex20 = (a: string): string => (a.startsWith("qor1") ? bech32ToHex(a) : getAddress(a)).toLowerCase().replace(/^0x/, "");

const vault = new Vault(getAddress(opt("--vault", "EXIT_VAULT") ?? deployedVault()), TESTNET.evmRpc, TESTNET.evmChainId);
const rdk = createRdkClient({ network: "testnet" });

// ------------------------------------------------------------- the vault, from chain
const [vaultChain, vaultRollup, members, threshold, feeBps, lp] = await Promise.all([
  vault.read<string>("chainId"),
  vault.read<string>("rollupId"),
  vault.read<Hex[]>("quorum"),
  vault.read<bigint>("threshold"),
  vault.read<number>("feeBps"),
  vault.read<Hex>("lp"),
]);
if (vaultChain !== TESTNET.chainId) throw new Error(`the vault serves ${vaultChain}, not ${TESTNET.chainId}`);
const rollupId = opt("--rollup", "EXIT_ROLLUP", vaultRollup)!;
if (rollupId !== vaultRollup) throw new Error(`the vault serves rollup ${vaultRollup}, not ${rollupId}`);
const keys = await Promise.all(members.map((m) => vault.read<Hex>("keyOf", [m])));
// A member without a usable key can't sign claims the vault accepts, so its claims are ignored. That is
// no reason to stop: executing and sweeping need no quorum. (Crashing would loop under restart=ALWAYS.)
keys.forEach((k, i) => {
  if ((k.length - 2) / 2 !== 2592) log("member-key-unusable", { member: members[i], note: "its claims are ignored until it has an ML-DSA-87 key again" });
});
const rollup = await rdk.rest.getRollup(rollupId);
const quorum: Quorum = { members, keys: keys.map((k) => ((k.length - 2) / 2 === 2592 ? k.slice(2) : "")), threshold: Number(threshold), feeBps: Number(feeBps) };

// ------------------------------------------------------------------ the key
let account: UnifiedAccount | undefined;
const envFile = opt("--env", "EXIT_RELAYER_ENV");
if (envFile) account = await loadOperator(envFile);
else if (process.env["RELAYER_MNEMONIC"]) account = await loadOperatorFrom({ QORE_MNEMONIC: process.env["RELAYER_MNEMONIC"] });
if (mode === "relay" && !account) throw new Error("relay mode needs the relayer's key: --env <file> or RELAYER_MNEMONIC");

let sender: HybridSender | undefined;
if (account) {
  const evm = getAddress(account.evm);
  if (account.cosmos === rollup.creator) throw new Error("refusing the rollup creator's key: its EVM window must stay closed");
  if (members.some((m) => getAddress(m) === evm)) throw new Error("refusing a quorum member's key: watchtowers never open EVM windows");
  if (getAddress(lp) === evm) throw new Error("refusing the LP's key");
  const pqc = await fetchPqcStatus({ rest: TESTNET.rest, address: account.cosmos });
  if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) throw new Error("the relayer's ML-DSA-87 key is not registered on chain (run scripts/drill/register-pqc.ts)");
  // The RDK's registry plus QoreChain's own types, so the same signer sends withdrawals and EVM windows.
  const registry = createRdkRegistry();
  for (const [url, type] of qorechainRegistryTypes) if (!registry.lookupType(url)) registry.register(url, type);
  sender = new HybridSender(account, registry);
}

const payouts = (opt("--payouts", "EXIT_PAYOUTS", "") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(toHex20);

const archivePath = opt("--archive", "EXIT_INBOX_ARCHIVE");
const reader = openInboxReader({ chainId: TESTNET.chainId, rollupId }, { ...(archivePath && { archivePath: resolve(archivePath) }), log });

const relayer = new Relayer(
  rdk.rest,
  reader,
  account ? vault.withSigner(account.privateKey as Hex) : vault,
  sender,
  quorum,
  {
    chainId: TESTNET.chainId,
    evmChainId: TESTNET.evmChainId,
    rollupId,
    mode,
    frontMarginSec,
    lookback,
    windowBlocks,
    challengeWindowSec: Number(rollup.challengeWindowSec ?? 3600),
    minExitUqor,
    minBalanceUqor,
    windowsPerHour,
  },
  log,
  payouts,
);

log("start", {
  mode,
  vault: vault.address,
  rollupId,
  quorum: members,
  threshold: quorum.threshold,
  feeBps: quorum.feeBps,
  relayer: sender ? { qor: sender.address, evm: account!.evm, balanceUqor: (await sender.balanceUqor()).toString() } : "none (observe only)",
  payouts: payouts.map((p) => `0x${p}`),
});

let stopping = false;
let wake: (() => void) | undefined;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    log("stopping", { signal: sig });
    wake?.();
  });
}

let passes = 0;
while (!stopping) {
  const t0 = Date.now();
  try {
    await relayer.pass();
  } catch (e) {
    log("pass-failed", { message: (e as Error).message.split("\n")[0]?.slice(0, 300) });
  }
  passes++;
  if (once) break;
  if (passes % 600 === 1 && sender) {
    const bal = await sender.balanceUqor().catch(() => -1n);
    log("status", { ...relayer.summary(), balanceUqor: bal.toString(), ...(bal >= 0n && bal < 300_000n ? { warning: "balance below 0.3 QOR" } : {}) });
  }
  await new Promise<void>((ok) => {
    wake = ok;
    setTimeout(ok, Math.max(500, intervalMs - (Date.now() - t0)));
  });
}
if (once) log("done", relayer.summary());
