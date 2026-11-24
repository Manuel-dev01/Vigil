/**
 * Sign a qledger-v1 transfer or withdrawal with an L2 (ML-DSA-44) key and post
 * it to the rollup's inbox from an L1 account (hybrid-signed). The sequencer
 * then batches it. Simulates by default; only --broadcast sends.
 *
 *   tsx src/l2-send.ts --env <poster .env> --key <l2 key file> --amount <QOR>
 *                      (--to-key <l2 key file> | --to <account id hex> | --withdraw-to <qor1…>)
 *                      [--rollup vigil-pay-1] [--data <dir>] [--broadcast]
 *
 * The nonce and balance come from the chain: the state after the latest batch
 * (replayed and checked, see sync.ts) plus every inbox entry not yet batched.
 * The replay starts from the newest local snapshot (--data, KEEL_DATA_DIR,
 * PULSE_DATA_DIR, data/keel/<rollup>) or from the first batch; entries the
 * chain has pruned come from the committed archive (data/inbox/<rollup>.jsonl).
 * A transaction the rollup would skip (wrong nonce, short balance, bad
 * recipient) is refused before it costs a post fee.
 */
import "./net.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import {
  QLEDGER_MAX_POST_BYTES,
  bytesToHex,
  createRdkClient,
  encodeQledgerTx,
  executeQledger,
  hexToBytes,
  isCanonicalQorAddress,
  postRollupDataMsg,
  signQledgerTx,
  verifyQledgerTx,
} from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { argValue, loadOperator } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { loadL2Key } from "./l2-key.ts";
import { emptyState, newestSnapshot, snapshotPaths } from "./snapshot.ts";
import { syncLedger, withPending } from "./sync.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const keyPath = argValue(argv, "--key");
const amountQor = argValue(argv, "--amount");
const toKey = argValue(argv, "--to-key");
const toHex = argValue(argv, "--to");
const withdrawTo = argValue(argv, "--withdraw-to");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
const broadcast = argv.includes("--broadcast");
const targets = [toKey, toHex, withdrawTo].filter(Boolean).length;
if (!envPath || !keyPath || !amountQor || targets !== 1) {
  console.error(
    "usage: l2-send.ts --env <poster .env> --key <l2 key file> --amount <QOR> (--to-key <file> | --to <hex> | --withdraw-to <qor1…>) [--broadcast]",
  );
  process.exit(1);
}
if (!/^\d+(\.\d{1,6})?$/.test(amountQor)) throw new Error(`--amount must be QOR with at most 6 decimals, got ${amountQor}`);
const [whole, frac = ""] = amountQor.split(".");
const amount = BigInt(whole ?? "0") * 1_000_000n + BigInt(frac.padEnd(6, "0"));
if (amount >= 100_000_000n && !argv.includes("--approved")) throw new Error("100 QOR or more needs the team's written OK, then --approved");
if (withdrawTo && !isCanonicalQorAddress(withdrawTo)) throw new Error(`${withdrawTo} is not a canonical qor1 address`);

const env = { chainId: TESTNET.chainId, rollupId };
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
const fmt = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;

const from = loadL2Key(keyPath);
const to = toKey ? loadL2Key(toKey).accountId : toHex ? hexToBytes(toHex.replace(/^0x/, "")) : undefined;
if (to && to.length !== 32) throw new Error("the destination account id must be 32 bytes");

const rest = createRdkClient({ network: "testnet" }).rest;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const snap = newestSnapshot(snapshotPaths(rollupId, repoRoot, [argValue(argv, "--data")]), env, {
  onSkip: (path, why) => console.warn(`note: skipped snapshot ${path}: ${why}`),
});
const reader = openInboxReader(env, { log: (event, fields) => console.warn(`note: ${event}`, JSON.stringify(fields)) });
const synced = await syncLedger(rest, reader, env, snap?.state ?? emptyState());
if (synced.blocked) {
  console.error(`refused: ${synced.blocked.reason}. Wait for the watchtower's challenge to roll it back; a transaction built now could be rolled back with it.`);
  process.exit(1);
}
const { state } = synced;
const { ledger, pendingEntries } = await withPending(rest, reader, env, state);
const sender = ledger.get(from.accountId);

const tx = signQledgerTx({
  chainId: env.chainId,
  rollupId,
  secretKey: from.secretKey,
  publicKey: from.publicKey,
  nonce: sender.nonce,
  amount,
  ...(to ? { to } : { recipient: withdrawTo! }),
});
if (!verifyQledgerTx(tx, env.chainId, rollupId)) throw new Error("the signed transaction does not verify");
const payload = encodeQledgerTx(tx);
if (payload.length > QLEDGER_MAX_POST_BYTES) throw new Error(`the transaction is ${payload.length} bytes, over the ${QLEDGER_MAX_POST_BYTES}-byte post limit`);

// Apply it to a copy of the ledger: refuse anything the rollup would skip.
const trial = ledger.clone();
const result = executeQledger(env, trial, [{ height: 0n, poster: "", payload }]);
const after = trial.get(from.accountId);
const applied = after.nonce === sender.nonce + 1n;

console.log(`rollup      ${rollupId} (batched to batch ${state.batchIndex}, ${pendingEntries} entr${pendingEntries === 1 ? "y" : "ies"} waiting)`);
console.log(`replayed    from ${snap ? `${snap.path} (after batch ${snap.state.batchIndex})` : "the first batch"}`);
console.log(`from        ${hex(from.accountId)} (balance ${fmt(sender.balance)}, nonce ${sender.nonce})`);
console.log(to ? `transfer    ${fmt(amount)} to ${hex(to)}` : `withdraw    ${fmt(amount)} to ${withdrawTo}`);
console.log(`payload     ${payload.length} bytes, ML-DSA-44 signed`);
if (!applied) {
  console.error("refused: the rollup would skip this transaction (check the balance and the destination)");
  process.exit(1);
}
if (result.withdrawals.length) console.log(`withdrawal  index ${result.withdrawals[0]!.index} once batched`);

const account = await loadOperator(envPath);
const poster = new HybridSender(account);
const [pqc, windowOpen] = await Promise.all([fetchPqcStatus({ rest: TESTNET.rest, address: poster.address }), poster.evmWindowOpen()]);
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) throw new Error("the poster's ML-DSA-87 key in this .env is not its registered key");
if (windowOpen) throw new Error("the poster has an open EVM window; this key must stay hybrid-only");

const msg = postRollupDataMsg({ poster: poster.address, rollupId, data: payload });
const sim = await poster.simulate([msg]);
console.log(`poster      ${poster.address}`);
console.log(`simulate    ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
if (!sim.ok || sim.gasUsed === undefined || !broadcast) process.exit(sim.ok ? 0 : 1);

const res = await poster.send([msg], sim.gasUsed);
console.log(`posted      tx ${res.transactionHash} at height ${res.height} (fee ${res.feeUqor} uqor)`);
for (const e of res.events) {
  if (e.type.startsWith("rdk")) console.log(`  ${e.type}`, Object.fromEntries(e.attributes.filter((a) => a.key !== "msg_index").map((a) => [a.key, a.value])));
}
