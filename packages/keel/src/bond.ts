/**
 * Bond as a batch submitter on a qledger-v1 based rollup, so this account may batch the inbox itself (as a
 * standby Keel) when no one else does: step 3 of leaving vigil-pay-1 without Vigil (docs/ESCAPE_HATCH.md).
 * Simulates by default; only --broadcast sends.
 *
 *   tsx src/bond.ts --env <submitter .env> [--rollup vigil-pay-1] [--broadcast]
 *
 * The bond is the chain's `min_submitter_bond`, read live (1,000 QOR on testnet on 27 Nov 2026). It is
 * slashed if a batch from this account is proven wrong. The account needs the bond plus about 1 QOR for
 * fees, its ML-DSA-87 key registered on chain, and no open EVM window. Every problem is listed before
 * anything is signed, so a dry run shows all that is missing at once.
 */
import "./net.ts";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { DEFAULT_MIN_SUBMITTER_BOND_UQOR, bondRollupSubmitterMsg, createRdkClient, isRestNotFound } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { argValue, loadOperator } from "./account.ts";
import { HybridSender } from "./chain.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
const broadcast = argv.includes("--broadcast");
if (!envPath) {
  console.error("usage: bond.ts --env <submitter .env> [--rollup vigil-pay-1] [--broadcast]");
  process.exit(1);
}
const fmt = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 })} QOR`;
const FEES = 1_000_000n;

const rest = createRdkClient({ network: "testnet" }).rest;
const account = await loadOperator(envPath);
const sender = new HybridSender(account);
const [rollup, params, held, pqc, windowOpen, balance] = await Promise.all([
  rest.getRollup(rollupId),
  rest.getParams(),
  rest.getSubmitterBond(rollupId, sender.address).catch((err: unknown) => {
    if (isRestNotFound(err)) return { amount: "0" };
    throw err;
  }),
  fetchPqcStatus({ rest: TESTNET.rest, address: sender.address }),
  sender.evmWindowOpen(),
  sender.balanceUqor(),
]);
const amount = BigInt(params.minSubmitterBond ?? String(DEFAULT_MIN_SUBMITTER_BOND_UQOR));
console.log(`rollup      ${rollupId}: ${rollup.status}, ${rollup.sequencing || "not based"}, ${rollup.executionVm || "not qledger-v1"}`);
console.log(`submitter   ${sender.address}: ${fmt(balance)} liquid, bond ${fmt(BigInt(held.amount))}`);
console.log(`plan        bond ${fmt(amount)} (min_submitter_bond, read live) with MsgBondRollupSubmitter, hybrid-signed`);
if (BigInt(held.amount) >= amount) {
  console.log("already bonded: this account may batch now (pnpm --filter @vigil/keel start -- --env <file> --standby-blocks 30)");
  process.exit(0);
}

const problems: string[] = [];
if (rollup.sequencing !== "based") problems.push(`${rollupId} is not a based rollup, so only its sequencer may batch`);
if (rollup.executionVm !== "qledger-v1") problems.push(`${rollupId} is not qledger-v1`);
if (rollup.status !== "active") problems.push(`${rollupId} is ${rollup.status}, not active`);
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) problems.push("the ML-DSA-87 key in this file is not the account's registered key (register it first)");
if (windowOpen) problems.push("the account has an open EVM window; close it first, this key should stay hybrid-only");
if (balance < amount + FEES) problems.push(`the account holds ${fmt(balance)}; it needs the bond plus about ${fmt(FEES)} for fees`);
if (problems.length) {
  for (const p of problems) console.error(`refused     ${p}`);
  process.exit(1);
}

const msg = bondRollupSubmitterMsg({ submitter: sender.address, rollupId, amount: amount.toString() });
const sim = await sender.simulate([msg]);
console.log(`simulate    ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
if (!sim.ok || sim.gasUsed === undefined || !broadcast) process.exit(sim.ok ? 0 : 1);

const res = await sender.send([msg], sim.gasUsed);
console.log(`bonded      tx ${res.transactionHash} at height ${res.height} (fee ${res.feeUqor} uqor)`);
console.log(`bond now    ${fmt(BigInt((await rest.getSubmitterBond(rollupId, sender.address)).amount))}`);
