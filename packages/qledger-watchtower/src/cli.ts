#!/usr/bin/env tsx
/**
 * vigil-watchtower: re-execute every batch of one or all qledger-v1 rollups on
 * QoreChain from chain data, keep a data-availability archive, write a status
 * feed, and (in challenge mode) challenge wrong batches inside their window.
 *
 *   tsx src/cli.ts --rollup vigil-pay-1 --once                 # observe, one pass
 *   tsx src/cli.ts --rollup all --interval 10                   # observe every qledger rollup
 *   tsx src/cli.ts --rollup vigil-pay-1 --mode challenge        # needs WATCHTOWER_MNEMONIC
 *
 * Two paths find a bad batch:
 * - **Fast (`--follow ws`, the default for named rollups).** The node's
 *   websocket pushes each batch-submitting tx the moment its block commits. The
 *   batch is decoded from the tx and judged at once. Inbox posts are pushed too,
 *   so their entries are already archived when a batch covers them.
 * - **Full pass, every `--interval` seconds.** Every live batch is re-read from
 *   REST and judged, and the status file is written. This catches anything the
 *   socket missed. While the socket is down, the pass runs every 2 s.
 *
 * Options (each also read from the environment variable named):
 *   --data <dir>            WATCHTOWER_DATA, default ./data/watchtower
 *   --interval <s>          WATCHTOWER_INTERVAL, default 10
 *   --follow ws|poll        WATCHTOWER_FOLLOW, default ws (poll for --rollup all)
 *   --gas-price <uqor>      WATCHTOWER_GAS_PRICE, default 0.3 per unit of gas
 *   --challenge-delay <s>   WATCHTOWER_CHALLENGE_DELAY, default 0. A backup
 *                           watchtower waits this long, then challenges only if
 *                           the batch is still open (so it does not pay to lose
 *                           a race against our own primary)
 *   --attest-exits <0x…>    WATCHTOWER_EXIT_VAULT: sign instant exits for this
 *                           InstantExitVault (see src/exits.ts). For each valid,
 *                           unfinalized batch with withdrawals, the watchtower signs
 *                           one claim per withdrawal with its ML-DSA-87 key and posts
 *                           them into the rollup's inbox. Needs --mode challenge.
 *   --exit-margin <s>       WATCHTOWER_EXIT_MARGIN, default 600: claims expire this
 *                           long before the batch could be final
 *   --evm-chain-id <n>      WATCHTOWER_EVM_CHAIN_ID, default 9800
 *
 * Exit code with --once: 0 all valid, 2 an invalid batch was found.
 * Logs are JSON lines on stdout. Secrets are read from the environment only and never logged.
 */
import "@vigil/core/net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRdkClient } from "@qorechain/rdk";
import { InboxArchive } from "./archive.ts";
import { Challenger, OUT_OF_GAS, accountFromMnemonic, rpcTransport } from "./challenger.ts";
import { claimsForBatch, encodeAttestation, recipientBytes, signClaims } from "./exits.ts";
import { batchesFromTx, postsFromEvents } from "./fast.ts";
import { TxFollower, websocketUrl, type TxEvent } from "./follow.ts";
import { RollupTracker, chainSource, type Judgement, type LiveBatch } from "./tracker.ts";

const args = process.argv.slice(2);
const opt = (flag: string, env: string, d?: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : process.env[env] || d);
const rollupArg = opt("--rollup", "WATCHTOWER_ROLLUP", "all")!;
const mode = opt("--mode", "WATCHTOWER_MODE", "observe")!;
const once = args.includes("--once");
const intervalMs = Number(opt("--interval", "WATCHTOWER_INTERVAL", "10")) * 1000;
const dataDir = resolve(opt("--data", "WATCHTOWER_DATA", "./data/watchtower")!);
const follow = opt("--follow", "WATCHTOWER_FOLLOW", rollupArg === "all" ? "poll" : "ws")!;
const gasPrice = Number(opt("--gas-price", "WATCHTOWER_GAS_PRICE", "0.3"));
const challengeDelayMs = Number(opt("--challenge-delay", "WATCHTOWER_CHALLENGE_DELAY", "0")) * 1000;
const exitVault = opt("--attest-exits", "WATCHTOWER_EXIT_VAULT");
const exitMarginSec = Number(opt("--exit-margin", "WATCHTOWER_EXIT_MARGIN", "600"));
const evmChainId = Number(opt("--evm-chain-id", "WATCHTOWER_EVM_CHAIN_ID", "9800"));
if (!["observe", "challenge"].includes(mode)) throw new Error(`unknown --mode ${mode}`);
if (exitVault && !/^0x[0-9a-fA-F]{40}$/.test(exitVault)) throw new Error("--attest-exits needs a 0x vault address");
if (exitVault && mode !== "challenge") throw new Error("--attest-exits needs --mode challenge (it signs and posts with WATCHTOWER_MNEMONIC)");
if (!(exitMarginSec >= 60)) throw new Error("--exit-margin must be at least 60 seconds");
if (!["ws", "poll"].includes(follow)) throw new Error(`unknown --follow ${follow}`);
if (follow === "ws" && rollupArg === "all") throw new Error("--follow ws needs named rollups (--rollup a,b); use --follow poll with --rollup all");
if (!(gasPrice >= 0.1 && gasPrice <= 10)) throw new Error(`--gas-price ${gasPrice} is outside 0.1..10 uqor per gas`);
if (!(challengeDelayMs >= 0)) throw new Error("--challenge-delay must be a number of seconds");
mkdirSync(dataDir, { recursive: true });

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");

const rdk = createRdkClient({ network: "testnet" });
const chainId = rdk.network.chainId;
const ep = { chainId, rest: rdk.network.endpoints.rest, rpc: rdk.network.endpoints.rpc };

const account = mode === "challenge"
  ? await accountFromMnemonic(process.env.WATCHTOWER_MNEMONIC ?? (() => { throw new Error("challenge mode needs WATCHTOWER_MNEMONIC"); })())
  : undefined;
const challenger = account ? new Challenger(account, chainId, await rpcTransport(ep), { gasPrice, rest: ep.rest }) : undefined;
await challenger?.ready();

// Batches settled for good: challenge upheld, lost to another challenger, or given up on.
const challengedPath = join(dataDir, "challenged.json");
const challenged = new Set<string>(existsSync(challengedPath) ? (JSON.parse(readFileSync(challengedPath, "utf8")) as string[]) : []);
const settle = (id: string) => {
  challenged.add(id);
  writeFileSync(challengedPath, JSON.stringify([...challenged], null, 2));
};
const inFlight = new Set<string>();

// Instant exits already attested (rollup:batch:stateRoot), and batches too close to final to attest.
const attestedPath = join(dataDir, "exit-attested.json");
const attested = new Set<string>(existsSync(attestedPath) ? (JSON.parse(readFileSync(attestedPath, "utf8")) as string[]) : []);
const attesting = new Set<string>();
const tooLate = new Set<string>();
const challengeWindows = new Map<string, number>();

/** Sign and post exit claims for a valid, unfinalized batch with withdrawals. Never throws. */
async function maybeAttest(rollupId: string, batch: LiveBatch, withdrawals: NonNullable<Extract<Judgement, { kind: "valid" }>["withdrawals"]>): Promise<void> {
  if (!exitVault || !challenger || !account || withdrawals.length === 0) return;
  if (batch.status !== "submitted" || batch.submittedTime === undefined) return;
  const id = `${rollupId}:${batch.batchIndex}:${norm(batch.stateRoot)}`;
  if (attested.has(id) || attesting.has(id) || tooLate.has(id)) return;
  attesting.add(id);
  try {
    let windowSec = challengeWindows.get(rollupId);
    if (windowSec === undefined) {
      windowSec = (await rdk.rest.getRollup(rollupId)).challengeWindowSec ?? 0;
      challengeWindows.set(rollupId, windowSec);
    }
    const claims = claimsForBatch({ batchIndex: batch.batchIndex, stateRoot: batch.stateRoot, submittedTime: batch.submittedTime }, withdrawals, windowSec, exitMarginSec);
    if (claims[0]!.deadline <= Math.floor(Date.now() / 1000) + 60) {
      tooLate.add(id);
      log("exit-attest-skipped", { rollupId, batch: batch.batchIndex, reason: "too close to final", deadline: claims[0]!.deadline });
      return;
    }
    const target = { evmChainId, vault: exitVault, chainId, rollupId };
    const payload = encodeAttestation({ vault: exitVault, member: recipientBytes(account.cosmos), claims: signClaims(target, account.pqc.secretKey, claims) });
    const sent = await challenger.post(rollupId, payload, `vigil watchtower: exit attestation ${rollupId} batch ${batch.batchIndex}`);
    const r = await challenger.outcome(sent.hash);
    if (r?.code === 0) {
      attested.add(id);
      writeFileSync(attestedPath, JSON.stringify([...attested], null, 2));
      log("exit-attested", { rollupId, batch: batch.batchIndex, withdrawals: claims.length, deadline: claims[0]!.deadline, tx: sent.hash, height: r.height, bytes: payload.length, feeUqor: sent.feeUqor });
    } else {
      log("exit-attest-failed", { rollupId, batch: batch.batchIndex, tx: sent.hash, code: r?.code, rawLog: r?.rawLog?.slice(0, 200) });
    }
  } catch (e) {
    log("exit-attest-failed", { rollupId, batch: batch.batchIndex, message: (e as Error).message.slice(0, 240) });
  } finally {
    attesting.delete(id);
  }
}
const attempts = new Map<string, number>();
const MAX_ATTEMPTS = 3;

const trackers = new Map<string, RollupTracker>();
function trackerFor(rollupId: string): RollupTracker {
  let t = trackers.get(rollupId);
  if (!t) {
    const env = { chainId, rollupId };
    t = new RollupTracker(env, chainSource(rdk.rest, env, ep.rest), new InboxArchive(env, join(dataDir, `${rollupId}.inbox.jsonl`)));
    trackers.set(rollupId, t);
    log("watch", { rollupId, archived: t.archive.head });
  }
  return t;
}
async function rollupIds(): Promise<string[]> {
  if (rollupArg !== "all") return rollupArg.split(",");
  return (await rdk.rest.listRollups()).filter((r) => r.executionVm === "qledger-v1" && r.status !== "stopped").map((r) => r.rollupId);
}

/** Challenge one invalid batch, at most once at a time and at most MAX_ATTEMPTS times. */
async function maybeChallenge(rollupId: string, t: RollupTracker, batch: LiveBatch, j: Judgement, via: string, detectedAt: number, factor = 1): Promise<void> {
  if (!challenger || j.kind !== "invalid" || batch.status !== "submitted") return;
  const id = `${rollupId}:${batch.batchIndex}:${norm(batch.stateRoot)}`;
  if (challenged.has(id) || inFlight.has(id)) return;
  const attempt = (attempts.get(id) ?? 0) + 1;
  if (attempt > MAX_ATTEMPTS) {
    log("challenge-given-up", { rollupId, batch: batch.batchIndex, attempts: MAX_ATTEMPTS });
    settle(id);
    return;
  }
  attempts.set(id, attempt);
  inFlight.add(id);
  let retryWith: number | undefined;
  try {
    if (challengeDelayMs > 0) {
      await sleep(challengeDelayMs);
      const now = await rdk.rest.getBatch(rollupId, batch.batchIndex).catch(() => undefined);
      if (!now || now.status !== "submitted" || norm(now.stateRoot) !== norm(batch.stateRoot)) {
        log("challenge-skipped", { rollupId, batch: batch.batchIndex, afterMs: challengeDelayMs, reason: now ? `batch is ${now.status}${norm(now.stateRoot) !== norm(batch.stateRoot) ? " (replaced)" : ""}` : "batch gone" });
        settle(id);
        return;
      }
    }
    const c = t.challenge(batch);
    if (!c.wins) {
      log("challenge-refused", { rollupId, batch: batch.batchIndex, reason: "checkQledgerFraud says the chain would not uphold it" });
      settle(id);
      return;
    }
    const entries = batch.inboxEnd - batch.inboxStart;
    const sent = await challenger.send(rollupId, c, entries, factor);
    log("challenge-sent", { rollupId, batch: batch.batchIndex, via, tx: sent.hash, attempt, gas: sent.gas, feeUqor: sent.feeUqor, gasPrice, proofBytes: c.proof.length, msSinceDetected: Date.now() - detectedAt });
    const r = await challenger.outcome(sent.hash);
    if (!r) {
      log("challenge-unconfirmed", { rollupId, batch: batch.batchIndex, tx: sent.hash });
      return;
    }
    log("challenge-result", { rollupId, batch: batch.batchIndex, tx: sent.hash, code: r.code, height: r.height, gasUsed: String(r.gasUsed), ...(r.code !== 0 && { rawLog: r.rawLog.slice(0, 240) }) });
    if (r.code === 0) {
      log("challenge-upheld", { rollupId, batch: batch.batchIndex, tx: sent.hash, height: r.height });
      settle(id);
    } else if (r.code === OUT_OF_GAS) {
      retryWith = factor * 2;
    } else if (/rejected|finalized|not challengeable|already/i.test(r.rawLog)) {
      settle(id); // someone else's challenge landed first, or the window closed
    }
  } catch (e) {
    log("challenge-failed", { rollupId, batch: batch.batchIndex, attempt, code: (e as { code?: number }).code, message: (e as Error).message.slice(0, 240) });
  } finally {
    inFlight.delete(id);
  }
  if (retryWith) await maybeChallenge(rollupId, t, batch, j, `${via}+gas-retry`, detectedAt, retryWith);
}

let sawInvalid = false;
async function pass(): Promise<void> {
  const tip = await rdk.getChainTip();
  const pending: Promise<void>[] = [];
  for (const rollupId of await rollupIds()) {
    const t = trackerFor(rollupId);
    let tracked;
    try {
      tracked = await t.sync();
    } catch (e) {
      log("error", { rollupId, message: (e as Error).message });
      continue;
    }
    const summary = tracked.map(({ batch, judgement }) => ({ index: batch.batchIndex, status: batch.status, inboxEnd: batch.inboxEnd, verdict: judgement.kind }));
    writeFileSync(join(dataDir, `${rollupId}.status.json`), JSON.stringify({ rollupId, height: tip.height, checkedAt: new Date().toISOString(), archived: t.archive.head, follow: follower?.connected ? "ws" : "poll", batches: summary }, null, 2) + "\n");
    const bad = tracked.filter(({ judgement }) => judgement.kind === "invalid" || judgement.kind === "descends-from-invalid");
    log("pass", { rollupId, height: tip.height, batches: tracked.length, valid: tracked.length - bad.length, invalid: bad.length, unknown: tracked.filter((x) => x.judgement.kind === "unknown-parent").length });
    for (const { batch, judgement } of bad) {
      sawInvalid = true;
      log("invalid", { rollupId, batch: batch.batchIndex, status: batch.status, judgement, via: "pass" });
      pending.push(maybeChallenge(rollupId, t, batch, judgement, "pass", Date.now()));
    }
    // Instant exits come after challenges and never hold up a pass.
    for (const { batch, judgement } of tracked) {
      if (judgement.kind === "valid" && judgement.withdrawals?.length) {
        const a = maybeAttest(rollupId, batch, judgement.withdrawals);
        if (once) pending.push(a);
      }
    }
  }
  if (once) await Promise.all(pending);
}

/** The fast path: a tx touching a watched rollup was just committed. */
function onTx(rollupId: string, kind: "batch" | "post", e: TxEvent): void {
  const t = trackerFor(rollupId);
  if (kind === "post") {
    const seqs = postsFromEvents(e.events, rollupId);
    const to = seqs.length ? Math.max(...seqs) : 0;
    if (to > t.archive.head) {
      const t0 = Date.now();
      t.ensureEntries(to).then(
        () => log("prefetched", { rollupId, through: to, height: e.height, ms: Date.now() - t0 }),
        (err: Error) => log("prefetch-failed", { rollupId, through: to, message: err.message.slice(0, 200) }),
      );
    }
    return;
  }
  let batches: LiveBatch[];
  try {
    batches = batchesFromTx(e.txBase64, e.events, rollupId);
  } catch (err) {
    log("decode-failed", { rollupId, height: e.height, message: (err as Error).message.slice(0, 200) });
    return;
  }
  for (const b of batches) {
    void (async () => {
      let j: Judgement;
      try {
        j = await t.judgeNow(b);
      } catch (err) {
        log("error", { rollupId, batch: b.batchIndex, via: "ws", message: (err as Error).message.slice(0, 200) });
        return;
      }
      log("seen", { rollupId, batch: b.batchIndex, height: e.height, inbox: `${b.inboxStart}-${b.inboxEnd}`, verdict: j.kind, judgedInMs: Date.now() - e.receivedAt });
      if (j.kind === "invalid" || j.kind === "descends-from-invalid") {
        log("invalid", { rollupId, batch: b.batchIndex, status: b.status, judgement: j, via: "ws", height: e.height });
        await maybeChallenge(rollupId, t, b, j, "ws", e.receivedAt);
      }
    })();
  }
}

let follower: TxFollower | undefined;
log("start", { mode, rollup: rollupArg, dataDir, follow, intervalMs, gasPrice, challengeDelayMs, watchtower: account?.cosmos, ...(exitVault && { exitVault, exitMarginSec, evmChainId }) });
for (let first = true; ; first = false) {
  try {
    await pass();
  } catch (e) {
    log("error", { message: (e as Error).message });
  }
  if (once) process.exit(sawInvalid ? 2 : 0);
  if (first && follow === "ws") {
    // After the first pass, so every honest state the socket's batches build on is known.
    const ids = await rollupIds();
    const queries = ids.flatMap((id) => [`tm.event='Tx' AND batch_submitted.rollup_id='${id}'`, `tm.event='Tx' AND rdk_data_posted.rollup_id='${id}'`]);
    follower = new TxFollower(websocketUrl(ep.rpc), queries, (e) => onTx(ids[Math.floor(e.query / 2)]!, e.query % 2 === 0 ? "batch" : "post", e), { log });
    follower.start();
  }
  await sleep(follower?.connected ? intervalMs : Math.min(intervalMs, 2_000));
}
