/**
 * Keep-alive pulse: post one tiny L2 transfer so the rollup produces a fresh,
 * anchored batch.
 *
 * Why: the chain prunes a finalized batch's record after
 * `finalized_batch_retention_blocks` (432,000 blocks, about 7 days on testnet),
 * and a settlement receipt can no longer be checked against chain state once its
 * batch is gone. An idle rollup therefore loses every verifiable receipt within
 * a week. Run this on a schedule (hosted: a Railway cron service) so recent
 * batches always exist.
 *
 * Each run:
 *   1. replays the rollup from chain data (sync.ts);
 *   2. refuses if a batch is awaiting a challenge, or if entries are still
 *      waiting after PULSE_WAIT_SEC (the sequencer is not batching; one more
 *      post would not help);
 *   3. moves PULSE_AMOUNT_UQOR (default 0.01 QOR) between two L2 accounts, from
 *      whichever holds more, so neither drains;
 *   4. posts it from the pulse poster (hybrid-signed), then waits up to
 *      PULSE_WAIT_SEC for a batch to consume it and logs that batch.
 *
 * State: like Keel, the job keeps a ledger snapshot and an inbox archive
 * (PULSE_DATA_DIR/<rollup>/, hosted on a volume) and syncs forward from them.
 * Without them it rebuilds from the repository's committed inbox archive
 * (data/inbox/<rollup>.jsonl) and whatever the chain still holds.
 *
 * Exit status, so a scheduler shows a run that did not do its job:
 *   0  a batch consumed the pulse (or, with PULSE_DRY_RUN=1, the post simulated)
 *   1  failed or refused (an error, neither L2 account can pay, ...)
 *   2  skipped: a batch awaits a challenge, or entries were still waiting for
 *      the sequencer after PULSE_WAIT_SEC (it is not batching)
 *   3  posted, but no batch consumed it within PULSE_WAIT_SEC (neither
 *      sequencer is batching)
 *
 * Hosted: QORE_MNEMONIC (the poster), PULSE_L2_SEED_A and PULSE_L2_SEED_B
 * (64 hex each), KEEL_ROLLUP, PULSE_DATA_DIR, PULSE_DRY_RUN=1 to simulate only.
 * Local: --env <poster .env> --key-a <l2 key file> --key-b <l2 key file> [--data <dir>] [--dry-run]
 */
import "./net.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import {
  bytesToHex,
  createRdkClient,
  encodeQledgerTx,
  executeQledger,
  postRollupDataMsg,
  qledgerKeypairFromSeed,
  signQledgerTx,
  verifyQledgerTx,
} from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { argValue, loadOperator, loadOperatorFrom } from "./account.ts";
import { HybridSender } from "./chain.ts";
import { loadL2Key } from "./l2-key.ts";
import { emptyState, loadSnapshot, saveSnapshot, snapshotOf, stateFrom } from "./snapshot.ts";
import { syncLedger, withPending } from "./sync.ts";

/** Exit statuses (see the header). */
export const PULSE_EXIT = { ok: 0, failed: 1, skipped: 2, notBatched: 3 } as const;

/** The sender is whichever account holds more; ties go to A. Undefined if neither can pay. */
export function pickPulseSender(balA: bigint, balB: bigint, amount: bigint): "a" | "b" | undefined {
  if (balA < amount && balB < amount) return undefined;
  return balA >= balB ? "a" : "b";
}

const argv = process.argv.slice(2);
const isMain = process.argv[1]?.endsWith("pulse.ts");

function log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}

async function main(): Promise<number> {
  const rollupId = argValue(argv, "--rollup") ?? process.env["KEEL_ROLLUP"] ?? "vigil-pay-1";
  const dryRun = argv.includes("--dry-run") || process.env["PULSE_DRY_RUN"] === "1";
  const amount = BigInt(process.env["PULSE_AMOUNT_UQOR"] ?? "10000");
  const waitSec = Number(process.env["PULSE_WAIT_SEC"] ?? "120");
  if (amount <= 0n || amount > 1_000_000n) throw new Error("PULSE_AMOUNT_UQOR must be 1 to 1,000,000 (at most 1 QOR)");

  const keyA = argValue(argv, "--key-a");
  const keyB = argValue(argv, "--key-b");
  const a = keyA ? loadL2Key(keyA) : qledgerKeypairFromSeed(process.env["PULSE_L2_SEED_A"] ?? "");
  const b = keyB ? loadL2Key(keyB) : qledgerKeypairFromSeed(process.env["PULSE_L2_SEED_B"] ?? "");
  const envPath = argValue(argv, "--env");
  const account = envPath ? await loadOperator(envPath) : await loadOperatorFrom(process.env);
  const poster = new HybridSender(account);

  const env = { chainId: TESTNET.chainId, rollupId };
  const rest = createRdkClient({ network: "testnet" }).rest;
  const dataDir = argValue(argv, "--data") ?? process.env["PULSE_DATA_DIR"];
  const snapPath = dataDir ? resolve(dataDir, rollupId, "ledger.json") : undefined;
  const snap = snapPath ? loadSnapshot(snapPath) : undefined;
  const reader = openInboxReader(env, {
    ...(dataDir && { archivePath: resolve(dataDir, rollupId, "inbox.jsonl") }),
    log: (event, fields) => log(event === "inbox_archive_rejected" ? "warn" : "info", event, fields),
  });
  let synced = await syncLedger(rest, reader, env, snap ? stateFrom(snap, env) : emptyState());
  if (snapPath && !synced.blocked) {
    mkdirSync(dirname(snapPath), { recursive: true });
    saveSnapshot(snapPath, snapshotOf(env, synced.state, new Date().toISOString()));
    // Keep the archive whole up to the state (one read with the committed archive as seed).
    const archived = await reader.read(0, synced.state.inboxEnd).then(
      () => reader.archive.head,
      (err: Error) => `incomplete: ${err.message}`,
    );
    log("info", "pulse_state", { batchIndex: synced.state.batchIndex, from: snap ? "snapshot" : "empty ledger", snapshot: snapPath, archived });
  }
  if (synced.blocked) {
    log("error", "pulse_skipped", { reason: `batch ${synced.blocked.batchIndex} is awaiting a challenge` });
    return PULSE_EXIT.skipped;
  }
  let { ledger, pendingEntries } = await withPending(rest, reader, env, synced.state);
  if (pendingEntries > 0) {
    // Someone posted just now, say: the sequencer batches within seconds. Give it as long as a pulse
    // gets before calling it stuck.
    log("info", "pulse_waiting", { reason: `${pendingEntries} entries waiting for the sequencer`, waitSec });
    for (const deadline = Date.now() + waitSec * 1000; Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 6000));
      const inbox = await rest.getInbox(rollupId);
      if (inbox.consumedSequence >= inbox.headSequence) break;
    }
    synced = await syncLedger(rest, reader, env, synced.state);
    if (synced.blocked) {
      log("error", "pulse_skipped", { reason: `batch ${synced.blocked.batchIndex} is awaiting a challenge` });
      return PULSE_EXIT.skipped;
    }
    ({ ledger, pendingEntries } = await withPending(rest, reader, env, synced.state));
    if (pendingEntries > 0) {
      log("error", "pulse_skipped", { reason: `${pendingEntries} entries still waiting for the sequencer after ${waitSec} s`, batchIndex: synced.state.batchIndex });
      return PULSE_EXIT.skipped;
    }
  }
  const [sa, sb] = [ledger.get(a.accountId), ledger.get(b.accountId)];
  const side = pickPulseSender(sa.balance, sb.balance, amount);
  if (!side) {
    log("error", "pulse_refused", { reason: "neither L2 account can pay", balanceA: sa.balance, balanceB: sb.balance });
    return PULSE_EXIT.failed;
  }
  const [from, to, state] = side === "a" ? [a, b, sa] : [b, a, sb];
  const tx = signQledgerTx({ ...env, secretKey: from.secretKey, publicKey: from.publicKey, nonce: state.nonce, amount, to: to.accountId });
  if (!verifyQledgerTx(tx, env.chainId, rollupId)) throw new Error("the signed transaction does not verify");
  const payload = encodeQledgerTx(tx);
  const trial = ledger.clone();
  executeQledger(env, trial, [{ height: 0n, poster: "", payload }]);
  if (trial.get(from.accountId).nonce !== state.nonce + 1n) {
    log("error", "pulse_refused", { reason: "the rollup would skip this transfer" });
    return PULSE_EXIT.failed;
  }

  const [pqc, windowOpen, balance] = await Promise.all([
    fetchPqcStatus({ rest: TESTNET.rest, address: poster.address }),
    poster.evmWindowOpen(),
    poster.balanceUqor(),
  ]);
  if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) throw new Error("the poster's ML-DSA-87 key is not its registered key");
  if (windowOpen) throw new Error("the poster has an open EVM window; this key must stay hybrid-only");

  const msg = postRollupDataMsg({ poster: poster.address, rollupId, data: payload });
  const sim = await poster.simulate([msg]);
  if (!sim.ok || sim.gasUsed === undefined) throw new Error(`simulation failed: ${sim.error ?? "no gas reported"}`);
  const planned = { rollupId, from: bytesToHex(from.accountId).slice(0, 16), to: bytesToHex(to.accountId).slice(0, 16), amount, nonce: state.nonce, poster: poster.address, posterBalanceUqor: balance, afterBatch: synced.state.batchIndex };
  if (dryRun) {
    log("info", "pulse_simulated", { ...planned, gas: sim.gasUsed });
    return PULSE_EXIT.ok;
  }
  const res = await poster.send([msg], sim.gasUsed);
  log("info", "pulse_posted", { ...planned, tx: res.transactionHash, height: res.height, feeUqor: res.feeUqor });

  // Wait for a batch to consume it, so the log shows the batch this pulse produced.
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const latest = await rest.getLatestBatch(rollupId).catch(() => undefined);
    if (latest && latest.batchIndex > synced.state.batchIndex) {
      log("info", "pulse_batched", { batchIndex: latest.batchIndex, status: latest.status, submittedAt: latest.submittedAt });
      return PULSE_EXIT.ok;
    }
  }
  log("error", "pulse_not_batched_yet", { waitedSec: waitSec, hint: "no sequencer has batched it yet; the standby takes over after 30 blocks" });
  return PULSE_EXIT.notBatched;
}

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      log("error", "pulse_failed", { reason: (err as Error).message });
      process.exit(PULSE_EXIT.failed);
    });
}
