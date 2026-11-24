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
 *   --exit-rollup <id>      WATCHTOWER_EXIT_ROLLUP, default vigil-pay-1: the one rollup
 *                           the vault serves; no other rollup's inbox is ever posted to
 *   --exit-max-claims <n>   WATCHTOWER_EXIT_MAX_CLAIMS, default 4: a batch with more exit-eligible
 *                           withdrawals is not attested (its exits are paid at finality instead)
 *   --exit-posts-per-day <n> WATCHTOWER_EXIT_POSTS_PER_DAY, default 12: attestation posts in any 24 h
 *   --exit-reserve <uqor>   WATCHTOWER_EXIT_RESERVE, default 5000000: never attest when the balance
 *                           is below this, so attesting can never spend the challenge budget
 *   Each claim is its own post (the chain refuses qledger posts over 6,144 bytes, after taking the
 *   fee), and a batch whose posts fail 3 times is given up.
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
import { attestationPosts, claimsForBatch, recipientBytes, signClaims } from "./exits.ts";
import { batchesFromTx, postsFromEvents } from "./fast.ts";
import { TxFollower, websocketUrl, type TxEvent } from "./follow.ts";
import { backoffMs, challengeResultDecision, currentBatchDecision } from "./policy.ts";
import { RollupTracker, attestableBatches, batchKey, chainSource, type Judgement, type LiveBatch } from "./tracker.ts";

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
const exitRollup = opt("--exit-rollup", "WATCHTOWER_EXIT_ROLLUP", "vigil-pay-1")!;
const exitMaxClaims = Number(opt("--exit-max-claims", "WATCHTOWER_EXIT_MAX_CLAIMS", "4"));
const exitPostsPerDay = Number(opt("--exit-posts-per-day", "WATCHTOWER_EXIT_POSTS_PER_DAY", "12"));
const exitReserveUqor = BigInt(opt("--exit-reserve", "WATCHTOWER_EXIT_RESERVE", "5000000")!);
if (!["observe", "challenge"].includes(mode)) throw new Error(`unknown --mode ${mode}`);
if (exitVault && !/^0x[0-9a-fA-F]{40}$/.test(exitVault)) throw new Error("--attest-exits needs a 0x vault address");
if (exitVault && mode !== "challenge") throw new Error("--attest-exits needs --mode challenge (it signs and posts with WATCHTOWER_MNEMONIC)");
if (!(exitMarginSec >= 60)) throw new Error("--exit-margin must be at least 60 seconds");
if (!(Number.isInteger(exitMaxClaims) && exitMaxClaims >= 1)) throw new Error("--exit-max-claims must be a positive integer");
if (!(Number.isInteger(exitPostsPerDay) && exitPostsPerDay >= 1)) throw new Error("--exit-posts-per-day must be a positive integer");
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
const attestFailures = new Map<string, number>();
const MAX_ATTEST_FAILURES = 3;
// When each attestation post was sent (ms), for the daily budget. Kept on the volume across restarts.
const postTimesPath = join(dataDir, "exit-post-times.json");
let postTimes: number[] = existsSync(postTimesPath) ? (JSON.parse(readFileSync(postTimesPath, "utf8")) as number[]) : [];
const postsInLastDay = () => {
  postTimes = postTimes.filter((t) => t > Date.now() - 86_400_000);
  return postTimes.length;
};

async function balanceUqor(address: string): Promise<bigint> {
  const r = await fetch(`${ep.rest}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=uqor`);
  if (!r.ok) throw new Error(`balance query HTTP ${r.status}`);
  return BigInt(((await r.json()) as { balance?: { amount?: string } }).balance?.amount ?? "0");
}

/**
 * Sign and post exit claims for a valid, unfinalized batch with withdrawals. Never throws.
 * Bounded so that nobody can make it spend the watchtower's challenge budget: one claim per post (the
 * chain refuses larger qledger posts after taking the fee), at most --exit-max-claims claims per batch,
 * --exit-posts-per-day posts per 24 h, never below --exit-reserve, and a batch is given up after
 * MAX_ATTEST_FAILURES failed posts.
 */
async function maybeAttest(rollupId: string, batch: LiveBatch, withdrawals: NonNullable<Extract<Judgement, { kind: "valid" }>["withdrawals"]>): Promise<void> {
  if (!exitVault || !challenger || !account || withdrawals.length === 0 || rollupId !== exitRollup) return;
  if (batch.status !== "submitted" || batch.submittedTime === undefined) return;
  const id = `${rollupId}:${batchKey(batch)}`;
  if (attested.has(id) || attesting.has(id) || tooLate.has(id)) return;
  attesting.add(id);
  const skip = (reason: string, fields: Record<string, unknown> = {}) => {
    tooLate.add(id);
    log("exit-attest-skipped", { rollupId, batch: batch.batchIndex, reason, ...fields });
  };
  const failed = (fields: Record<string, unknown>) => {
    const n = (attestFailures.get(id) ?? 0) + 1;
    attestFailures.set(id, n);
    log("exit-attest-failed", { rollupId, batch: batch.batchIndex, failures: n, ...fields });
    if (n >= MAX_ATTEST_FAILURES) skip(`gave up after ${n} failures`);
  };
  try {
    let windowSec = challengeWindows.get(rollupId);
    if (windowSec === undefined) {
      windowSec = (await rdk.rest.getRollup(rollupId)).challengeWindowSec ?? 0;
      challengeWindows.set(rollupId, windowSec);
    }
    const claims = claimsForBatch({ batchIndex: batch.batchIndex, stateRoot: batch.stateRoot, submittedTime: batch.submittedTime }, withdrawals, windowSec, exitMarginSec);
    if (claims.length === 0) return skip("no withdrawal to a 20-byte address");
    if (claims.length > exitMaxClaims) return skip("more exit-eligible withdrawals than --exit-max-claims", { claims: claims.length, max: exitMaxClaims });
    if (claims[0]!.deadline <= Math.floor(Date.now() / 1000) + 60) return skip("too close to final", { deadline: claims[0]!.deadline });
    const target = { evmChainId, vault: exitVault, chainId, rollupId };
    const posts = attestationPosts({ vault: exitVault, member: recipientBytes(account.cosmos), claims: signClaims(target, account.pqc.secretKey, claims) });
    const todo = posts.map((p, i) => ({ p, key: `${id}:${i}/${posts.length}` })).filter((x) => !attested.has(x.key));
    if (postsInLastDay() + todo.length > exitPostsPerDay) return skip("daily attestation budget spent", { postsInLastDay: postsInLastDay(), budget: exitPostsPerDay });
    const balance = await balanceUqor(account.cosmos);
    if (balance < exitReserveUqor) return skip("balance below the challenge reserve", { balanceUqor: balance.toString(), reserveUqor: exitReserveUqor.toString() });
    for (const { p, key } of todo) {
      const sent = await challenger.post(rollupId, p, `vigil watchtower: exit attestation ${rollupId} batch ${batch.batchIndex}`);
      postTimes.push(Date.now());
      writeFileSync(postTimesPath, JSON.stringify(postTimes));
      const r = await challenger.outcome(sent.hash);
      if (r?.code !== 0) return failed({ tx: sent.hash, code: r?.code, rawLog: r?.rawLog?.slice(0, 200) });
      attested.add(key);
      writeFileSync(attestedPath, JSON.stringify([...attested], null, 2));
      log("exit-attested", { rollupId, batch: batch.batchIndex, post: key.slice(id.length + 1), withdrawals: claims.length, deadline: claims[0]!.deadline, tx: sent.hash, height: r.height, bytes: p.length, feeUqor: sent.feeUqor });
    }
    attested.add(id);
    writeFileSync(attestedPath, JSON.stringify([...attested], null, 2));
  } catch (e) {
    failed({ message: (e as Error).message.slice(0, 240) });
  } finally {
    attesting.delete(id);
  }
}
const attempts = new Map<string, number>();

const trackers = new Map<string, RollupTracker>();
function trackerFor(rollupId: string): RollupTracker {
  let t = trackers.get(rollupId);
  if (!t) {
    const env = { chainId, rollupId };
    t = new RollupTracker(env, chainSource(rdk.rest, env, ep.rest), new InboxArchive(env, join(dataDir, `${rollupId}.inbox.jsonl`)));
    trackers.set(rollupId, t);
    log("watch", { rollupId, archived: t.archive.head, ...(t.archive.repaired && { repaired: "dropped a torn last line; it is fetched again" }) });
  }
  return t;
}
async function rollupIds(): Promise<string[]> {
  if (rollupArg !== "all") return rollupArg.split(",");
  return (await rdk.rest.listRollups()).filter((r) => r.executionVm === "qledger-v1" && r.status !== "stopped").map((r) => r.rollupId);
}

const is404 = (e: unknown): boolean => (e as { status?: unknown }).status === 404 || /HTTP 404|not found/i.test((e as Error).message ?? "");
/** When each batch may be tried again (ms). */
const retryAt = new Map<string, number>();
/** The gas a batch's challenge needs, once a simulate has told us. */
const gasNeeded = new Map<string, number>();
const backoff = (id: string, attempt: number) => retryAt.set(id, Date.now() + backoffMs(attempt));

/**
 * Challenge one invalid batch, one attempt at a time. A batch is settled (never tried again) only on
 * what the chain shows: the challenge was upheld, the batch is no longer `submitted` (rejected,
 * finalized or replaced), or `checkQledgerFraud` says the chain would refuse the proof. Everything
 * transient (network errors, CheckTx refusals such as insufficient funds, an unconfirmed send) is
 * retried with backoff for as long as the batch can still be challenged, so neither a short RPC outage
 * nor an empty balance (topped up later) gives a fraud away. Out of gas: the real tx is simulated to
 * learn its gas, instead of doubling a guess and paying for every miss.
 */
async function maybeChallenge(rollupId: string, t: RollupTracker, batch: LiveBatch, j: Judgement, via: string, detectedAt: number): Promise<void> {
  if (!challenger || j.kind !== "invalid" || batch.status !== "submitted") return;
  const id = `${rollupId}:${batchKey(batch)}`;
  if (challenged.has(id) || inFlight.has(id) || Date.now() < (retryAt.get(id) ?? 0)) return;
  const attempt = (attempts.get(id) ?? 0) + 1;
  attempts.set(id, attempt);
  inFlight.add(id);
  let again = false;
  try {
    // The backup waits first; any retry looks again. What does the chain say about this batch now?
    if (challengeDelayMs > 0 && attempt === 1) await sleep(challengeDelayMs);
    if (challengeDelayMs > 0 || attempt > 1) {
      let now;
      try {
        now = await rdk.rest.getBatch(rollupId, batch.batchIndex);
      } catch (e) {
        if (!is404(e)) {
          log("challenge-deferred", { rollupId, batch: batch.batchIndex, attempt, reason: `could not read the batch: ${(e as Error).message.slice(0, 160)}` });
          backoff(id, attempt);
          return;
        }
      }
      const d = currentBatchDecision(batch, now);
      if (d.action === "settle") {
        log("challenge-skipped", { rollupId, batch: batch.batchIndex, attempt, reason: d.reason });
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
    const gas = gasNeeded.get(id);
    const sent = await challenger.send(rollupId, c, entries, gas ? { gas } : {});
    log("challenge-sent", { rollupId, batch: batch.batchIndex, via, tx: sent.hash, attempt, gas: sent.gas, feeUqor: sent.feeUqor, gasPrice, proofBytes: c.proof.length, msSinceDetected: Date.now() - detectedAt });
    const r = await challenger.outcome(sent.hash);
    if (!r) {
      log("challenge-unconfirmed", { rollupId, batch: batch.batchIndex, tx: sent.hash });
      backoff(id, attempt);
      return;
    }
    log("challenge-result", { rollupId, batch: batch.batchIndex, tx: sent.hash, code: r.code, height: r.height, gasUsed: String(r.gasUsed), ...(r.code !== 0 && { rawLog: r.rawLog.slice(0, 240) }) });
    const outcome = challengeResultDecision(r);
    if (outcome === "upheld") {
      log("challenge-upheld", { rollupId, batch: batch.batchIndex, tx: sent.hash, height: r.height });
      settle(id);
    } else if (outcome === "out-of-gas") {
      const simulated = await challenger.simulateChallenge(rollupId, c).catch(() => undefined);
      const next = simulated ? Math.ceil(simulated * 1.3) : Math.min(sent.gas * 2, 50_000_000);
      gasNeeded.set(id, next);
      log("challenge-gas", { rollupId, batch: batch.batchIndex, ranOutAt: sent.gas, simulated, next });
      again = true;
    } else if (outcome === "lost") {
      log("challenge-skipped", { rollupId, batch: batch.batchIndex, attempt, reason: r.rawLog.slice(0, 160) });
      settle(id);
    } else {
      backoff(id, attempt);
    }
  } catch (e) {
    log("challenge-failed", { rollupId, batch: batch.batchIndex, attempt, code: (e as { code?: number }).code, message: (e as Error).message.slice(0, 240) });
    backoff(id, attempt);
  } finally {
    inFlight.delete(id);
  }
  if (again) await maybeChallenge(rollupId, t, batch, j, `${via}+gas`, detectedAt);
}

let sawInvalid = false;
async function pass(): Promise<void> {
  const tip = await rdk.getChainTip();
  const pending: Promise<void>[] = [];
  for (const rollupId of await rollupIds()) {
    let t: RollupTracker;
    let tracked;
    try {
      t = trackerFor(rollupId);
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
    // Instant exits come after challenges and never hold up a pass. Only batches whose every unfinalized
    // ancestor is valid too: a rollback would otherwise bring the same withdrawal back as a new exit.
    const attestable = attestableBatches(tracked);
    for (const { batch, judgement } of tracked) {
      if (judgement.kind === "valid" && judgement.withdrawals?.length && attestable.has(batchKey(batch))) {
        const a = maybeAttest(rollupId, batch, judgement.withdrawals);
        if (once) pending.push(a);
      }
    }
  }
  if (once) await Promise.all(pending);
}

/** The fast path: a tx touching a watched rollup was just committed. */
function onTx(rollupId: string, kind: "batch" | "post", e: TxEvent): void {
  let t: RollupTracker;
  try {
    t = trackerFor(rollupId);
  } catch (err) {
    log("error", { rollupId, via: "ws", message: (err as Error).message.slice(0, 200) });
    return;
  }
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
log("start", { mode, rollup: rollupArg, dataDir, follow, intervalMs, gasPrice, challengeDelayMs, watchtower: account?.cosmos, ...(exitVault && { exitVault, exitRollup, exitMarginSec, evmChainId }) });
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
