/**
 * Keel: the sequencer for a qledger-v1 based rollup whose creator it runs as.
 *
 * Each pass reads the rollup's inbox. When entries are waiting it plans the
 * next batch with the RDK (`planQledgerBatch`: admission rules, entry fetch and
 * check, re-execution), signs the batch's v2 anchor bytes with the creator's
 * ML-DSA-87 key so the chain anchors it in the same transaction, simulates the
 * `MsgSubmitBatch`, then sends it hybrid-signed. The ledger after the batch is
 * saved locally; on start it is checked against the chain and any batches it
 * missed are replayed root by root.
 *
 *   pnpm --filter @vigil/keel start -- --env <creator .env> [--rollup vigil-pay-1]
 *        [--data <dir>] [--interval <seconds>] [--dry-run] [--once]
 *
 * --dry-run plans and simulates every batch but never sends one.
 * One Keel per key: a lock file in the data directory refuses a second copy
 * (two sequencers on one key race for the account sequence).
 */
import "./net.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPqcStatus, isRegisteredPqcKey, pqcSign } from "@qorechain/sdk";
import {
  anchorSignBytesForBatch,
  bytesToHex,
  createRdkClient,
  planQledgerBatch,
  submitBatchMsg,
  withdrawalsRootError,
} from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { argValue, loadOperator } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { emptyState, loadSnapshot, saveSnapshot, snapshotOf, stateFrom, type LedgerState } from "./snapshot.ts";
import { syncLedger } from "./sync.ts";

class FatalError extends Error {}

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env") ?? process.env["KEEL_ENV"];
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = resolve(argValue(argv, "--data") ?? resolve(repoRoot, "data/keel", rollupId));
const intervalMs = Math.max(2, Number(argValue(argv, "--interval") ?? "6")) * 1000;
const dryRun = argv.includes("--dry-run");
const once = argv.includes("--once");
if (!envPath) throw new Error("Pass --env <path to the creator's .env> (or set KEEL_ENV)");

const env = { chainId: TESTNET.chainId, rollupId };
const snapshotPath = resolve(dataDir, "ledger.json");
const statusPath = resolve(dataDir, "status.json");
const lockPath = resolve(dataDir, "keel.lock");
const HEARTBEAT_MS = 10 * 60 * 1000;
const LOW_BALANCE_UQOR = 5_000_000n;

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, rollup: rollupId, ...fields }, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

// ------------------------------------------------------------------ lock
function takeLock(): void {
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new FatalError(`another Keel (pid ${pid}) holds ${lockPath}; one sequencer per key`);
    log("warn", "stale_lock", { pid });
  }
  writeFileSync(lockPath, String(process.pid));
}
const releaseLock = () => {
  try {
    if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath);
  } catch {
    /* best effort */
  }
};

// ------------------------------------------------------------------ preflight
const account = await loadOperator(envPath);
const sender = new HybridSender(account);
const rdk = createRdkClient({ network: "testnet" });
const rest = rdk.rest;

const rollup = await rest.getRollup(rollupId);
const [params, bond, pqc, windowOpen, balance] = await Promise.all([
  rest.getParams(),
  rest.getSubmitterBond(rollupId, sender.address),
  fetchPqcStatus({ rest: TESTNET.rest, address: sender.address }),
  sender.evmWindowOpen(),
  sender.balanceUqor(),
]);
const problems: string[] = [];
if (rollup.executionVm !== "qledger-v1") problems.push(`rollup ${rollupId} is not qledger-v1`);
if (rollup.sequencing !== "based") problems.push(`rollup ${rollupId} is not based`);
if (rollup.status !== "active") problems.push(`rollup ${rollupId} is ${rollup.status}, not active`);
if (rollup.creator !== sender.address) problems.push(`this key (${sender.address}) is not the creator (${rollup.creator}), so it cannot anchor`);
if (!rollup.layerId) problems.push(`rollup ${rollupId} has no layer id to anchor to`);
if (BigInt(bond.amount) < BigInt(params.minSubmitterBond ?? "1000000000")) problems.push(`submitter bond ${bond.amount} uqor is below the minimum`);
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) problems.push("the ML-DSA-87 key in this .env is not the account's registered key");
if (windowOpen) problems.push("the account has an open EVM window; this key must stay hybrid-only");
if (problems.length) {
  for (const p of problems) log("error", "preflight_refused", { reason: p });
  process.exit(1);
}
log("info", "start", {
  sequencer: sender.address,
  layer: rollup.layerId,
  bond: bond.amount,
  balanceUqor: balance,
  dataDir,
  intervalMs,
  dryRun,
});

try {
  takeLock();
} catch (err) {
  log("error", "lock_refused", { reason: (err as Error).message });
  process.exit(1);
}
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("info", "stopping", { signal: sig });
    stopping = true;
  });
}
process.on("exit", releaseLock);

// ------------------------------------------------------------------ state
function persist(state: LedgerState): void {
  saveSnapshot(snapshotPath, snapshotOf(env, state, new Date().toISOString()));
}

async function resync(state: LedgerState): Promise<LedgerState> {
  try {
    const r = await syncLedger(rest, env, state, (b) =>
      log("info", "batch_replayed", { batchIndex: b.batchIndex, inboxEnd: b.inboxEnd, stateRoot: b.stateRoot }),
    );
    if (r.replayed > 0) persist(r.state);
    return r.state;
  } catch (err) {
    throw new FatalError((err as Error).message);
  }
}

let state: LedgerState;
const snap = loadSnapshot(snapshotPath);
state = snap ? stateFrom(snap, env) : emptyState();
state = await resync(state);
persist(state);
log("info", "state_ready", { batchIndex: state.batchIndex, inboxEnd: state.inboxEnd, stateRoot: hex(state.ledger.root()) });

// ------------------------------------------------------------------ loop
async function pass(): Promise<"idle" | "submitted" | "planned"> {
  const inbox = await rest.getInbox(rollupId);
  if (inbox.headSequence <= inbox.consumedSequence) {
    writeFileSync(statusPath, JSON.stringify({ ts: new Date().toISOString(), state: "idle", inbox, batchIndex: state.batchIndex }, null, 2) + "\n");
    return "idle";
  }
  state = await resync(state);
  const plan = await planQledgerBatch(rest, { ...env, submitter: sender.address, ledger: state.ledger });
  const rootErr = withdrawalsRootError(plan.input.withdrawalsRoot);
  if (rootErr) throw new Error(`batch ${plan.input.batchIndex}: ${rootErr}`);
  const anchorSignature = pqcSign(
    account.pqc.secretKey,
    anchorSignBytesForBatch({
      chainId: env.chainId,
      layerId: rollup.layerId,
      batchIndex: plan.input.batchIndex,
      stateRoot: plan.input.stateRoot,
      txCount: plan.input.txCount,
    }),
  );
  const msg = submitBatchMsg({ sequencer: sender.address, ...plan.input, anchorSignature });
  const planned = {
    batchIndex: plan.input.batchIndex,
    inboxFrom: inbox.consumedSequence,
    inboxEnd: plan.input.inboxEnd,
    txCount: plan.input.txCount,
    stateRoot: hex(plan.input.stateRoot),
    withdrawals: plan.result.withdrawals.length,
  };
  const sim = await sender.simulate([msg]);
  if (!sim.ok || sim.gasUsed === undefined) throw new Error(`simulate batch ${plan.input.batchIndex} failed: ${sim.error ?? "no gas reported"}`);
  if (dryRun) {
    log("info", "batch_simulated", { ...planned, gas: sim.gasUsed });
    return "planned";
  }
  const res = await sender.send([msg], sim.gasUsed);
  state = { ledger: plan.ledger, batchIndex: Number(plan.input.batchIndex), inboxEnd: Number(plan.input.inboxEnd) };
  persist(state);
  log("info", "batch_submitted", {
    ...planned,
    tx: res.transactionHash,
    height: res.height,
    gasUsed: res.gasUsed,
    feeUqor: res.feeUqor,
    events: [...new Set(res.events.map((e) => e.type))].filter((t) => !["tx", "message", "coin_spent", "coin_received", "transfer"].includes(t)),
  });
  writeFileSync(statusPath, JSON.stringify({ ts: new Date().toISOString(), state: "submitted", lastBatch: { ...planned, tx: res.transactionHash, height: res.height } }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  return "submitted";
}

let lastBeat = 0;
while (!stopping) {
  let wait = intervalMs;
  try {
    const r = await pass();
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      const bal = await sender.balanceUqor();
      log(bal < LOW_BALANCE_UQOR ? "warn" : "info", "heartbeat", { batchIndex: state.batchIndex, inboxEnd: state.inboxEnd, balanceUqor: bal });
      lastBeat = Date.now();
    }
    if (r === "submitted") wait = 2000; // more may be waiting (a batch takes at most 64 entries)
  } catch (err) {
    if (err instanceof FatalError) {
      log("error", "fatal", { reason: err.message });
      process.exit(2);
    }
    log("warn", "pass_failed", { reason: (err as Error).message });
    wait = Math.max(intervalMs, 30_000); // let a sent-but-unconfirmed tx land before planning again
  }
  if (once) break;
  await sleep(wait);
}
log("info", "stopped", { batchIndex: state.batchIndex });
process.exit(0);
