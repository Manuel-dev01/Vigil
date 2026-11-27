/**
 * Read an L2 balance, and the withdrawals to an L1 address, by replaying the rollup from chain data. No key
 * is needed and nothing is sent: step 1 of leaving vigil-pay-1 without Vigil (docs/ESCAPE_HATCH.md).
 *
 *   tsx src/balance.ts [--account <hex> | --key <l2 key file>] [--to <qor1…>] [--rollup vigil-pay-1] [--data <dir>]
 *
 * --account takes a qledger-v1 account id (32 bytes, hex); --key reads it from an L2 key file (l2-key.ts),
 * whose secret is only used to derive the id. --to lists every withdrawal to that L1 address: paid, final
 * (anyone can execute it with claim.ts), or waiting for its batch's challenge window.
 *
 * The replay checks every batch's state and withdrawals roots against the chain (sync.ts). It starts from
 * the newest local snapshot (--data, KEEL_DATA_DIR, PULSE_DATA_DIR, data/keel/<rollup>) or from the first
 * batch; entries the chain has pruned come from the committed archive (data/inbox/<rollup>.jsonl), checked
 * against commitments the chain still holds. It also says how long the oldest unbatched entry has waited,
 * which is when a standby sequencer (or anyone bonded) would batch it.
 */
import "./net.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, createRdkClient, hexToBytes, isCanonicalQorAddress } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { argValue } from "./account.ts";
import { executedWithdrawals, nextStep, withdrawalsTo, type BatchWithdrawals } from "./escape.ts";
import { loadL2Key } from "./l2-key.ts";
import { emptyState, newestSnapshot, snapshotPaths } from "./snapshot.ts";
import { oldestWaitingSequence } from "./standby.ts";
import { syncLedger, withPending } from "./sync.ts";

const argv = process.argv.slice(2);
const accountHex = argValue(argv, "--account");
const keyPath = argValue(argv, "--key");
const to = argValue(argv, "--to");
const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
if ((!accountHex && !keyPath && !to) || (accountHex && keyPath)) {
  console.error("usage: balance.ts [--account <hex> | --key <l2 key file>] [--to <qor1…>] [--rollup vigil-pay-1] [--data <dir>]");
  process.exit(1);
}
if (to && !isCanonicalQorAddress(to)) throw new Error(`${to} is not a canonical qor1 address`);
const accountId = keyPath ? loadL2Key(keyPath).accountId : accountHex ? hexToBytes(accountHex.replace(/^0x/, "")) : undefined;
if (accountId && accountId.length !== 32) throw new Error("the account id must be 32 bytes (64 hex characters)");

const env = { chainId: TESTNET.chainId, rollupId };
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
const fmt = (u: bigint) => `${(Number(u) / 1e6).toLocaleString("en-GB", { maximumFractionDigits: 6 })} QOR`;

const rest = createRdkClient({ network: "testnet" }).rest;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const snap = newestSnapshot(snapshotPaths(rollupId, repoRoot, [argValue(argv, "--data")]), env, {
  onSkip: (path, why) => console.warn(`note: skipped snapshot ${path}: ${why}`),
});
const reader = openInboxReader(env, { log: (event, fields) => console.warn(`note: ${event}`, JSON.stringify(fields)) });
const withBatches: BatchWithdrawals[] = [];
const synced = await syncLedger(rest, reader, env, snap?.state ?? emptyState(), (b, r) => {
  if (r.withdrawals.length) withBatches.push({ batchIndex: b.batchIndex, status: b.status, submittedTime: b.submittedTime, withdrawals: r.withdrawals });
});
const { state } = synced;
console.log(`rollup      ${rollupId}: replayed to batch ${state.batchIndex}, every root checked against the chain`);
console.log(`replayed    from ${snap ? `${snap.path} (after batch ${snap.state.batchIndex})` : "the first batch"}`);
if (synced.pruned) console.log(`note        the chain has pruned the records of batches ${synced.pruned.fromBatchIndex} to ${synced.pruned.toBatchIndex}; their entries were replayed in one go`);
if (synced.blocked) {
  console.log(`WARNING     ${synced.blocked.reason}`);
  console.log("            Nothing after it is applied. It is a fraud for any watcher to challenge (anyone may, within the window).");
}

if (accountId) {
  const settled = state.ledger.get(accountId);
  console.log(`account     ${hex(accountId)}`);
  console.log(`settled     ${fmt(settled.balance)}, nonce ${settled.nonce} (after batch ${state.batchIndex})`);
}
if (!synced.blocked) {
  const { ledger, pendingEntries, head } = await withPending(rest, reader, env, state);
  if (accountId) {
    const pending = ledger.get(accountId);
    console.log(`with inbox  ${fmt(pending.balance)}, nonce ${pending.nonce} (with ${pendingEntries} entr${pendingEntries === 1 ? "y" : "ies"} posted but not yet batched)`);
  }
  if (pendingEntries > 0) {
    const seq = oldestWaitingSequence(state.inboxEnd);
    const [posted, tip] = await Promise.all([rest.getPostedData(rollupId, seq), rest.getLatestHeight()]);
    const waited = tip - Number(posted.height);
    console.log(
      `inbox       ${pendingEntries} waiting (entries ${seq} to ${head}); the oldest has waited ${waited} blocks. Any bonded account may batch it; a standby Keel does after 30.`,
    );
  } else {
    console.log("inbox       nothing waiting to be batched");
  }
}

if (to) {
  if (snap) console.log(`note        withdrawals in batches up to ${snap.state.batchIndex} are in the snapshot, not listed; pass --data <empty dir> to replay from the first batch`);
  const [rollup, txs] = await Promise.all([rest.getRollup(rollupId), rest.searchTxs(`rdk_withdrawal_executed.rollup_id='${rollupId}'`)]);
  const windowSec = Number(rollup.challengeWindowSec ?? 3600);
  const rows = withdrawalsTo(to, withBatches, executedWithdrawals(txs, rollupId), windowSec);
  console.log(`withdrawals to ${to}: ${rows.length}`);
  for (const r of rows) console.log(`  batch ${r.batchIndex} withdrawal ${r.index}: ${fmt(r.amount)}, ${nextStep(r, rollupId)}`);
}
