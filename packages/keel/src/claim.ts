/**
 * Execute the withdrawals of finalized qledger-v1 batches on L1. Anyone may
 * submit them; the funds always go to the recipient each withdrawal names.
 * Simulates by default; only --broadcast sends.
 *
 *   tsx src/claim.ts --env <submitter .env> [--rollup vigil-pay-1] [--batch N] [--broadcast]
 *
 * Withdrawals are recomputed by replaying the rollup from its first batch
 * (every root checked against the chain, see sync.ts), and each proof is the
 * qledger sibling path (`qledgerWithdrawalProof`). A withdrawal the chain has
 * already executed fails simulation and is skipped.
 */
import "./net.ts";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import {
  QLEDGER_WITHDRAWAL_DENOM,
  createRdkClient,
  executeWithdrawalMsg,
  qledgerWithdrawalProof,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { argValue, loadOperator } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { emptyState } from "./snapshot.ts";
import { syncLedger } from "./sync.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
const only = argValue(argv, "--batch");
const broadcast = argv.includes("--broadcast");
if (!envPath) {
  console.error("usage: claim.ts --env <submitter .env> [--rollup id] [--batch N] [--broadcast]");
  process.exit(1);
}
const env = { chainId: TESTNET.chainId, rollupId };
const fmt = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;

const rest = createRdkClient({ network: "testnet" }).rest;
const withBatches: { batchIndex: number; status: string; finalizedAt: number; withdrawals: QledgerWithdrawal[] }[] = [];
await syncLedger(rest, env, emptyState(), (b, r) => {
  if (r.withdrawals.length) withBatches.push({ batchIndex: b.batchIndex, status: b.status, finalizedAt: b.finalizedAt, withdrawals: r.withdrawals });
});
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
