/**
 * Execute the withdrawals of finalized qledger-v1 batches on L1. Anyone may
 * submit them; the funds always go to the recipient each withdrawal names.
 * Simulates by default; only --broadcast sends.
 *
 *   tsx src/claim.ts --env <submitter .env> [--rollup vigil-pay-1] [--batch N] [--data <dir>] [--broadcast]
 *
 * Withdrawals are recomputed by replaying the rollup (every root checked
 * against the chain, see sync.ts), and each proof is the qledger sibling path
 * (`qledgerWithdrawalProof`). A withdrawal the chain has already executed fails
 * simulation and is skipped.
 *
 * The replay starts from the first batch, or with --batch N from the newest
 * local snapshot before batch N (--data, KEEL_DATA_DIR, PULSE_DATA_DIR,
 * data/keel/<rollup>). Inbox entries the chain has pruned come from the
 * repository's committed archive (data/inbox/<rollup>.jsonl), checked against
 * the chain's commitments.
 */
import "./net.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import {
  QLEDGER_WITHDRAWAL_DENOM,
  createRdkClient,
  executeWithdrawalMsg,
  qledgerWithdrawalProof,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { argValue, loadOperator } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { emptyState, newestSnapshot, snapshotPaths } from "./snapshot.ts";
import { syncLedger } from "./sync.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
const only = argValue(argv, "--batch");
const broadcast = argv.includes("--broadcast");
if (!envPath) {
  console.error("usage: claim.ts --env <submitter .env> [--rollup id] [--batch N] [--data <dir>] [--broadcast]");
  process.exit(1);
}
if (only !== undefined && !/^\d+$/.test(only)) throw new Error(`--batch must be a batch index, got ${only}`);
const env = { chainId: TESTNET.chainId, rollupId };
const fmt = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;

const rest = createRdkClient({ network: "testnet" }).rest;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const reader = openInboxReader(env, { log: (event, fields) => console.warn(`note: ${event}`, JSON.stringify(fields)) });
// Withdrawals are only seen for batches re-executed here, so a snapshot is used only when it is before --batch.
const snap =
  only === undefined
    ? undefined
    : newestSnapshot(snapshotPaths(rollupId, repoRoot, [argValue(argv, "--data")]), env, {
        belowBatch: Number(only),
        onSkip: (path, why) => console.warn(`note: skipped snapshot ${path}: ${why}`),
      });
console.log(snap ? `replaying from ${snap.path} (after batch ${snap.state.batchIndex})` : "replaying from the first batch");
const withBatches: { batchIndex: number; status: string; finalizedAt: number; withdrawals: QledgerWithdrawal[] }[] = [];
const synced = await syncLedger(rest, reader, env, snap?.state ?? emptyState(), (b, r) => {
  if (r.withdrawals.length) withBatches.push({ batchIndex: b.batchIndex, status: b.status, finalizedAt: b.finalizedAt, withdrawals: r.withdrawals });
});
// Withdrawals are only taken from batches that reproduce. One that does not is
// fraud: its withdrawals are never claimed here, and nothing after it is read.
if (synced.blocked) console.warn(`note: ${synced.blocked.reason}; batches from ${synced.blocked.batchIndex} on are skipped`);
if (synced.pruned) console.warn(`note: the chain has pruned the records of batches ${synced.pruned.fromBatchIndex}..${synced.pruned.toBatchIndex}; their withdrawals can no longer be executed`);
const targets = withBatches.filter((b) => only === undefined || b.batchIndex === Number(only));
if (!targets.length) {
  console.log(only === undefined ? "no batch commits a withdrawal" : `batch ${only} commits no withdrawal`);
  process.exit(0);
}

const account = await loadOperator(envPath);
const sender = new HybridSender(account);
const [pqc, windowOpen] = await Promise.all([fetchPqcStatus({ rest: TESTNET.rest, address: sender.address }), sender.evmWindowOpen()]);
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) throw new Error("the submitter's ML-DSA-87 key in this .env is not its registered key");
if (windowOpen) throw new Error("the submitter has an open EVM window; this key must stay hybrid-only");

for (const b of targets) {
  if (b.status !== "finalized") {
    const batch = await rest.getBatch(rollupId, b.batchIndex);
    const rollup = await rest.getRollup(rollupId);
    const due = batch.submittedTime ? new Date((batch.submittedTime + Number(rollup.challengeWindowSec ?? 3600)) * 1000).toISOString() : "after the challenge window";
    console.log(`batch ${b.batchIndex}: ${b.status}, not final yet (challenge window ends ${due}); ${b.withdrawals.length} withdrawal(s) waiting`);
    continue;
  }
  for (let i = 0; i < b.withdrawals.length; i++) {
    const w = b.withdrawals[i]!;
    const msg = executeWithdrawalMsg({
      submitter: sender.address,
      rollupId,
      batchIndex: b.batchIndex,
      withdrawalIndex: w.index,
      recipient: w.recipient,
      denom: QLEDGER_WITHDRAWAL_DENOM,
      amount: w.amount,
      proof: qledgerWithdrawalProof(env.chainId, rollupId, b.withdrawals, i),
    });
    const sim = await sender.simulate([msg]);
    const label = `batch ${b.batchIndex} withdrawal ${w.index}: ${fmt(w.amount)} to ${w.recipient}`;
    if (!sim.ok || sim.gasUsed === undefined) {
      console.log(`${label}: simulate failed (${sim.error ?? "no gas"}); skipped`);
      continue;
    }
    if (!broadcast) {
      console.log(`${label}: simulate ok, gas ${sim.gasUsed}`);
      continue;
    }
    const res = await sender.send([msg], sim.gasUsed);
    console.log(`${label}: executed, tx ${res.transactionHash} at height ${res.height} (fee ${res.feeUqor} uqor)`);
    for (const e of res.events) {
      if (e.type.startsWith("rdk") || e.type === "withdrawal_executed") {
        console.log(`  ${e.type}`, Object.fromEntries(e.attributes.filter((a) => a.key !== "msg_index").map((a) => [a.key, a.value])));
      }
    }
  }
}
