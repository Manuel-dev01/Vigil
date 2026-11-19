/**
 * Deposit QOR into a qledger-v1 rollup, credited to a qledger account.
 * Simulates by default; only --broadcast sends.
 *
 *   tsx src/deposit.ts --env <depositor .env> --amount <QOR> (--to <account id hex> | --key <l2 key file>)
 *                      [--rollup vigil-pay-1] [--broadcast]
 *
 * Deposits of 100 QOR or more also need --approved: the team agrees in writing
 * before moving that much (vigil-kit CLAUDE.md).
 */
import "./net.ts";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { MIN_ROLLUP_DEPOSIT_UQOR, bytesToHex, createRdkClient, depositToRollupMsg, hexToBytes } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { argValue, loadOperator } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { loadL2Key } from "./l2-key.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
const amountQor = argValue(argv, "--amount");
const to = argValue(argv, "--to");
const keyPath = argValue(argv, "--key");
const broadcast = argv.includes("--broadcast");
if (!envPath || !amountQor || (!to && !keyPath)) {
  console.error("usage: deposit.ts --env <file> --amount <QOR> (--to <account id hex> | --key <l2 key file>) [--rollup id] [--broadcast]");
  process.exit(1);
}
if (!/^\d+(\.\d{1,6})?$/.test(amountQor)) throw new Error(`--amount must be QOR with at most 6 decimals, got ${amountQor}`);
const [whole, frac = ""] = amountQor.split(".");
const amount = BigInt(whole ?? "0") * 1_000_000n + BigInt(frac.padEnd(6, "0"));
const accountId = to ? hexToBytes(to.replace(/^0x/, "")) : loadL2Key(keyPath!).accountId;
if (accountId.length !== 32) throw new Error("the qledger account id must be 32 bytes");

const account = await loadOperator(envPath);
const sender = new HybridSender(account);
const rest = createRdkClient({ network: "testnet" }).rest;
const [rollup, pqc, windowOpen, balance] = await Promise.all([
  rest.getRollup(rollupId),
  fetchPqcStatus({ rest: TESTNET.rest, address: sender.address }),
  sender.evmWindowOpen(),
  sender.balanceUqor(),
]);
const fmt = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;
console.log(`depositor   ${sender.address} (balance ${fmt(balance)})`);
console.log(`rollup      ${rollupId} (${rollup.status}, ${rollup.executionVm})`);
console.log(`credit      ${bytesToHex(accountId).toLowerCase()}`);
console.log(`amount      ${fmt(amount)}`);

const problems: string[] = [];
if (rollup.status !== "active") problems.push(`rollup is ${rollup.status}`);
if (rollup.executionVm !== "qledger-v1") problems.push("rollup is not qledger-v1");
if (amount < MIN_ROLLUP_DEPOSIT_UQOR) problems.push(`the chain's minimum deposit is ${fmt(MIN_ROLLUP_DEPOSIT_UQOR)}`);
if (amount >= 100_000_000n && !argv.includes("--approved")) problems.push("100 QOR or more needs the team's written OK, then --approved");
if (amount + 1_000_000n > balance) problems.push("balance does not cover the amount plus fees");
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) problems.push("the ML-DSA-87 key in this .env is not the registered key");
if (windowOpen) problems.push("the depositor has an open EVM window; this key must stay hybrid-only");
if (problems.length) {
  for (const p of problems) console.error(`refused: ${p}`);
  process.exit(1);
}

const msg = depositToRollupMsg({ depositor: sender.address, rollupId, account: accountId, amount });
const sim = await sender.simulate([msg]);
console.log(`simulate    ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
if (!sim.ok || sim.gasUsed === undefined || !broadcast) process.exit(sim.ok ? 0 : 1);

const res = await sender.send([msg], sim.gasUsed);
console.log(`deposited   tx ${res.transactionHash} at height ${res.height} (fee ${res.feeUqor} uqor)`);
for (const e of res.events) {
  if (e.type.startsWith("rdk")) console.log(`  ${e.type}`, Object.fromEntries(e.attributes.filter((a) => a.key !== "msg_index").map((a) => [a.key, a.value])));
}
const inbox = await rest.getInbox(rollupId);
console.log(`inbox       head ${inbox.headSequence}, consumed ${inbox.consumedSequence}`);
