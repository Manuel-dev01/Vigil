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
 * Fraud and rollback (see sync.ts): a batch on chain that does not reproduce
 * blocks Keel, which logs `awaiting_challenge` and submits nothing until the
 * watchtower's challenge removes it (`fraud_finalized` if it can no longer be
 * challenged). When an upheld challenge rolls the rollup back, Keel logs
 * `rollback`, rebuilds its ledger from the chain and re-batches the rolled-back
 * inbox entries.
 *
 *   pnpm --filter @vigil/keel start -- --env <creator .env> [--rollup vigil-pay-1]
 *        [--data <dir>] [--interval <seconds>] [--dry-run] [--once]
 *
 * --dry-run plans and simulates every batch but never sends one.
 *
 * Standby (see standby.ts): with --standby-blocks N (KEEL_STANDBY_BLOCKS) Keel
 * runs as a second sequencer with its own bonded key. It batches only once the
 * oldest inbox entry has waited N blocks without the primary batching it. A
 * standby key that is not the creator's submits unanchored batches.
 * One Keel per key: a lock file in the data directory refuses a second copy
 * (two sequencers on one key race for the account sequence).
 *
 * Hosted (see Dockerfile): without --env the key comes from the process
 * environment (PRIVATE_KEY + QORE_PQC_RECOVERY_CODE, or QORE_MNEMONIC), and
 * KEEL_ROLLUP, KEEL_DATA_DIR, KEEL_DRY_RUN=1 and KEEL_LOCK=0 stand in for the
 * flags. A single-replica container turns the lock off: its PIDs repeat across
 * restarts, so a stale lock could look alive.
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
import { argValue, loadOperator, loadOperatorFrom } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { emptyState, loadSnapshot, saveSnapshot, snapshotOf, stateFrom, type LedgerState } from "./snapshot.ts";
import { syncLedger, type SyncResult } from "./sync.ts";
import { parseStandbyBlocks, standbyDecision } from "./standby.ts";

class FatalError extends Error {}

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env") ?? process.env["KEEL_ENV"];
const rollupId = argValue(argv, "--rollup") ?? process.env["KEEL_ROLLUP"] ?? "vigil-pay-1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = resolve(argValue(argv, "--data") ?? process.env["KEEL_DATA_DIR"] ?? resolve(repoRoot, "data/keel", rollupId));
const intervalMs = Math.max(2, Number(argValue(argv, "--interval") ?? process.env["KEEL_INTERVAL"] ?? "6")) * 1000;
const dryRun = argv.includes("--dry-run") || process.env["KEEL_DRY_RUN"] === "1";
const once = argv.includes("--once");
const useLock = process.env["KEEL_LOCK"] !== "0";
let standbyBlocks: number | undefined;
try {
  standbyBlocks = parseStandbyBlocks(argValue(argv, "--standby-blocks") ?? process.env["KEEL_STANDBY_BLOCKS"]);
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

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
const account = envPath ? await loadOperator(envPath) : await loadOperatorFrom(process.env);
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
// Only the creator's key can anchor. Any other bonded key may still sequence, unanchored, but only as a standby.
const anchoring = rollup.creator === sender.address;
if (!anchoring && standbyBlocks === undefined) {
  problems.push(`this key (${sender.address}) is not the creator (${rollup.creator}), so it cannot anchor; run it as a standby (--standby-blocks N)`);
}
if (anchoring && !rollup.layerId) problems.push(`rollup ${rollupId} has no layer id to anchor to`);
if (BigInt(bond.amount) < BigInt(params.minSubmitterBond ?? "1000000000")) problems.push(`submitter bond ${bond.amount} uqor is below the minimum`);
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) problems.push("the ML-DSA-87 key in this .env is not the account's registered key");
if (windowOpen) problems.push("the account has an open EVM window; this key must stay hybrid-only");
if (problems.length) {
  for (const p of problems) log("error", "preflight_refused", { reason: p });
  process.exit(1);
}
log("info", "start", {
  sequencer: sender.address,
  role: standbyBlocks === undefined ? "primary" : "standby",
  ...(standbyBlocks !== undefined && { standbyBlocks }),
  anchoring,
  layer: rollup.layerId,
  bond: bond.amount,
  balanceUqor: balance,
  dataDir,
  intervalMs,
  dryRun,
  keySource: envPath ? "file" : "environment",
});

if (useLock) {
  try {
    takeLock();
  } catch (err) {
    log("error", "lock_refused", { reason: (err as Error).message });
    process.exit(1);
  }
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

const writeStatus = (s: Record<string, unknown>) =>
  writeFileSync(statusPath, JSON.stringify({ ts: new Date().toISOString(), ...s }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

// A batch that does not reproduce is the watchtower's to challenge. Keel never
// builds on it: it waits, says so once (and again with each heartbeat), and
// carries on by itself once the challenge rolls the rollup back.
let blocked: SyncResult["blocked"];
let blockedLoggedAt = 0;
function noteBlocked(b: SyncResult["blocked"]): void {
  const key = (x: SyncResult["blocked"]) => (x ? `${x.batchIndex}:${x.status}` : "");
  if (!b) {
    if (blocked) log("info", "unblocked", { batchIndex: blocked.batchIndex });
    blocked = undefined;
    return;
  }
  if (key(b) !== key(blocked) || Date.now() - blockedLoggedAt > HEARTBEAT_MS) {
    // A finalized batch can no longer be challenged: the rollup needs a human.
    if (b.status === "finalized") log("error", "fraud_finalized", b);
    else log("warn", "awaiting_challenge", b);
    blockedLoggedAt = Date.now();
  }
  blocked = b;
}

async function resync(from: LedgerState): Promise<LedgerState> {
  const r = await syncLedger(rest, env, from, (b) =>
    log("info", "batch_replayed", { batchIndex: b.batchIndex, inboxEnd: b.inboxEnd, stateRoot: b.stateRoot }),
  );
  if (r.rolledBack) {
    log("warn", "rollback", { fromBatchIndex: r.rolledBack.fromBatchIndex, toBatchIndex: r.state.batchIndex, reason: r.rolledBack.reason });
  }
  if (r.replayed > 0 || r.rolledBack) persist(r.state);
  noteBlocked(r.blocked);
  return r.state;
}

let state: LedgerState;
try {
  const snap = loadSnapshot(snapshotPath);
  state = snap ? stateFrom(snap, env) : emptyState();
  state = await resync(state);
  persist(state);
} catch (err) {
  log("error", "fatal", { reason: `could not load or sync the ledger: ${(err as Error).message}` });
  process.exit(2);
}
log("info", "state_ready", { batchIndex: state.batchIndex, inboxEnd: state.inboxEnd, stateRoot: hex(state.ledger.root()), blocked });

// ------------------------------------------------------------------ loop
// The standby says once per waiting entry that it is leaving it to the primary.
let standbyNoted = -1;

async function pass(): Promise<"idle" | "blocked" | "submitted" | "planned" | "standby"> {
  // Sync on every pass, even with an empty inbox: another submitter's batch,
  // a fraudulent one or a rollback can arrive at any time.
  state = await resync(state);
  if (blocked) {
    writeStatus({ state: "blocked", batchIndex: state.batchIndex, blocked });
    return "blocked";
  }
  const inbox = await rest.getInbox(rollupId);
  if (inbox.headSequence <= inbox.consumedSequence) {
    writeStatus({ state: "idle", inbox, batchIndex: state.batchIndex });
    return "idle";
  }
  let takeover: { waitedBlocks: number; oldestEntry: number } | undefined;
  if (standbyBlocks !== undefined) {
    const [tip, oldest] = await Promise.all([rest.getLatestHeight(), rest.getPostedData(rollupId, inbox.consumedSequence)]);
    const d = standbyDecision({ tipHeight: tip, oldestWaitingHeight: oldest.height, standbyBlocks });
    if (!d.due) {
      if (standbyNoted !== inbox.consumedSequence) {
        log("info", "standby_waiting", { oldestEntry: inbox.consumedSequence, waitedBlocks: d.waited, standbyBlocks });
        standbyNoted = inbox.consumedSequence;
      }
      writeStatus({ state: "standby", inbox, batchIndex: state.batchIndex, waitedBlocks: d.waited, standbyBlocks });
      return "standby";
    }
    takeover = { waitedBlocks: d.waited, oldestEntry: inbox.consumedSequence };
    log("warn", "standby_takeover", { ...takeover, standbyBlocks, postedAt: oldest.height, tip });
  }
  const plan = await planQledgerBatch(rest, { ...env, submitter: sender.address, ledger: state.ledger });
  const rootErr = withdrawalsRootError(plan.input.withdrawalsRoot);
  if (rootErr) throw new Error(`batch ${plan.input.batchIndex}: ${rootErr}`);
  const anchorSignature = anchoring
    ? pqcSign(
        account.pqc.secretKey,
        anchorSignBytesForBatch({
          chainId: env.chainId,
          layerId: rollup.layerId,
          batchIndex: plan.input.batchIndex,
          stateRoot: plan.input.stateRoot,
          txCount: plan.input.txCount,
        }),
      )
    : undefined;
  const msg = submitBatchMsg({ sequencer: sender.address, ...plan.input, ...(anchorSignature && { anchorSignature }) });
  const planned = {
    batchIndex: plan.input.batchIndex,
    inboxFrom: inbox.consumedSequence,
    inboxEnd: plan.input.inboxEnd,
    txCount: plan.input.txCount,
    stateRoot: hex(plan.input.stateRoot),
    withdrawals: plan.result.withdrawals.length,
    anchored: anchoring,
    ...(takeover && { takeover }),
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
  writeStatus({ state: "submitted", lastBatch: { ...planned, tx: res.transactionHash, height: res.height } });
  return "submitted";
}

let lastBeat = 0;
while (!stopping) {
  let wait = intervalMs;
  try {
    const r = await pass();
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      const bal = await sender.balanceUqor();
      log(bal < LOW_BALANCE_UQOR ? "warn" : "info", "heartbeat", {
        batchIndex: state.batchIndex,
        inboxEnd: state.inboxEnd,
        balanceUqor: bal,
        ...(blocked && { blockedAt: blocked.batchIndex }),
      });
      lastBeat = Date.now();
    }
    if (r === "submitted") wait = 2000; // more may be waiting (a batch takes at most 64 entries)
    if (r === "blocked") wait = Math.max(intervalMs, 15_000); // the challenge comes from the watchtower; no need to re-fetch the bad batch every few seconds
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
