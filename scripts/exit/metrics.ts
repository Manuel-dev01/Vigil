/**
 * Every instant exit, measured from the chain, written to docs/exits-metrics.json. Read-only: free
 * eth_calls, eth_getLogs and receipts on the EVM endpoint, REST GETs on the node. No key is loaded.
 *
 *   pnpm --filter @vigil/scripts exit:metrics [--out <file>] [--rps 1]
 *
 * It scans the InstantExitVault's logs from its deploy block (at most 10,000 blocks per eth_getLogs,
 * the endpoint's limit), and for every Fronted exit reads:
 *   - the front() receipt (gas used, sender) and its block time;
 *   - the batch record (submitted time, status, state root; the challenge window from the rollup);
 *   - the L2 withdrawal in the batch's inbox range (the shared inbox reader, checked against the chain's
 *     accumulator, with the committed archive for pruned entries) and the time of its block. Withdrawals
 *     are numbered in inbox order, so the k-th front (by withdrawal index) of one payout and amount in a
 *     batch is matched with the k-th such withdrawal in its range;
 *   - the Settled logs, attributed to exits first in, first out per payout (apps/web/src/settle.ts).
 * The rows and the summary come from apps/web/src/ledger.ts, the code the Exits page runs.
 *
 * Every request goes out one at a time, at most --rps per second (default 1): the public endpoints sit
 * behind a shared rate limit that our live services also use.
 */
import "../lib/net.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QLEDGER_KIND_WITHDRAW, bytesToHex, createRdkClient, decodeQledgerTx, decodeWireBytes, hexToBech32, hexToBytes, isRestNotFound, type BatchView } from "@qorechain/rdk";
import { TESTNET, restGet } from "@vigil/core";
import { openInboxReader } from "@vigil/core/inbox";
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Hex } from "viem";
// The vault's exit id, pinned to the id the vault emitted for batch 18 in packages/sentinel/test/judge.test.ts.
import { exitIdOf } from "../../packages/sentinel/src/exits.ts";
import { SMALL_SAMPLE, ledgerRows, ledgerSummary, type LedgerExit, type LedgerRow, type Spread } from "../../apps/web/src/ledger.ts";
import { attributeRepayments } from "../../apps/web/src/settle.ts";
import { REPO_ROOT } from "../lib/env.ts";

const args = process.argv.slice(2);
const opt = (f: string): string | undefined => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const out = resolve(opt("--out") ?? resolve(REPO_ROOT, "docs/exits-metrics.json"));
const rps = Number(opt("--rps") ?? "1");
if (!(rps > 0 && rps <= 4)) throw new Error("--rps must be above 0 and at most 4");

// ------------------------------------------------------------------ one request at a time
let requests = 0;
{
  const inner = globalThis.fetch;
  const gapMs = 1000 / rps;
  let next = 0;
  let queue: Promise<void> = Promise.resolve();
  globalThis.fetch = ((...a: Parameters<typeof fetch>) => {
    const turn = queue.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      next = Date.now() + gapMs;
      requests++;
    });
    queue = turn;
    return turn.then(() => inner(...a));
  }) as typeof fetch;
}

const LOG_SPAN = 10_000n;
const WEI_PER_UQOR = 1_000_000_000_000n;
const rollupId = "vigil-pay-1";
const env = { chainId: TESTNET.chainId, rollupId };

const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/diana.json"), "utf8")) as { InstantExitVault?: { address: Hex; block: string } };
const d = deployments.InstantExitVault;
if (!d) throw new Error("no InstantExitVault in deployments/diana.json");
const vault = getAddress(d.address);
const pub = createPublicClient({ transport: http(TESTNET.evmRpc, { timeout: 60_000, retryCount: 2, retryDelay: 2_000 }) });
const rdk = createRdkClient({ network: "testnet" });

const EVENTS = [
  parseAbiItem("event Fronted(bytes32 indexed exitId, address indexed payout, uint64 batchIndex, uint64 withdrawalIndex, uint256 paid, uint256 fee)"),
  parseAbiItem("event Settled(address indexed payout, uint256 repaid, uint256 stillOwed)"),
] as const;
const VIEWS = parseAbi(["function exitAddressOf(address payout) view returns (address)"]);

const iso = (t: number | undefined): string | undefined => (t ? new Date(t * 1000).toISOString().replace(".000Z", "Z") : undefined);
const qorOf = (wei: bigint | undefined): string | undefined => {
  if (wei === undefined) return undefined;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${wei / 10n ** 18n}${frac ? `.${frac}` : ""}`;
};

// ------------------------------------------------------------------ the vault's history
const rollup = await rdk.rest.getRollup(rollupId);
const windowSec = rollup.challengeWindowSec ?? 3600;
const latest = await pub.getBlockNumber();
const fromBlock = BigInt(d.block);
type Front = { exitId: Hex; payout: Hex; batchIndex: number; withdrawalIndex: number; paid: bigint; fee: bigint; tx: Hex; block: number; logIndex: number };
type Settle = { payout: Hex; repaid: bigint; tx: Hex; block: number; logIndex: number };
const fronts: Front[] = [];
const settles: Settle[] = [];
let spans = 0;
for (let a = fromBlock; a <= latest; a += LOG_SPAN + 1n) {
  const b = a + LOG_SPAN > latest ? latest : a + LOG_SPAN;
  spans++;
  const logs = await pub.getLogs({ address: vault, events: EVENTS, fromBlock: a, toBlock: b });
  for (const l of logs) {
    const at = { tx: l.transactionHash!, block: Number(l.blockNumber), logIndex: l.logIndex! };
    if (l.eventName === "Fronted") {
      const x = l.args;
      fronts.push({ exitId: x.exitId!, payout: getAddress(x.payout!), batchIndex: Number(x.batchIndex), withdrawalIndex: Number(x.withdrawalIndex), paid: x.paid!, fee: x.fee!, ...at });
    } else if (l.eventName === "Settled") {
      settles.push({ payout: getAddress(l.args.payout!), repaid: l.args.repaid!, ...at });
    }
  }
}
console.log(`vault ${vault}: EVM blocks ${fromBlock} to ${latest} in ${spans} eth_getLogs; ${fronts.length} fronted, ${settles.length} settled`);

const blockTimes = new Map<number, number>();
async function evmTime(block: number): Promise<number> {
  if (!blockTimes.has(block)) blockTimes.set(block, Number((await pub.getBlock({ blockNumber: BigInt(block) })).timestamp));
  return blockTimes.get(block)!;
}
const l1Times = new Map<number, number>();
async function l1Time(height: number): Promise<number> {
  if (!l1Times.has(height)) {
    const b = await restGet<{ block: { header: { time: string } } }>(`/cosmos/base/tendermint/v1beta1/blocks/${height}`);
    l1Times.set(height, Math.floor(Date.parse(b.block.header.time) / 1000));
  }
  return l1Times.get(height)!;
}

const repayments = attributeRepayments(
  fronts.map((f) => ({ id: f.exitId.toLowerCase(), payout: f.payout, block: f.block, logIndex: f.logIndex, owed: f.paid + f.fee })),
  settles,
);

// ------------------------------------------------------------------ each exit
const reader = openInboxReader(env, { log: (event, fields) => console.log(`  inbox: ${event}`, JSON.stringify(fields)) });
const batches = new Map<number, BatchView | null>();
const exitAddresses = new Map<string, string>();
const exits: (LedgerExit & { payout: Hex; sweepTx: string | undefined; frontBlock: number })[] = [];

for (const f of fronts) {
  const rcpt = await pub.getTransactionReceipt({ hash: f.tx });
  const paidAt = await evmTime(f.block);
  if (!batches.has(f.batchIndex)) {
    try {
      batches.set(f.batchIndex, await rdk.rest.getBatch(rollupId, f.batchIndex));
    } catch (e) {
      if (!isRestNotFound(e)) throw e;
      batches.set(f.batchIndex, null);
    }
  }
  const b = batches.get(f.batchIndex) ?? undefined;
  const root = b ? bytesToHex(decodeWireBytes(b.stateRoot)).toLowerCase() : undefined;
  const sameExit = root !== undefined && exitIdOf(f.batchIndex, root, f.withdrawalIndex).toLowerCase() === f.exitId.toLowerCase();
  const status = !b ? "missing" : sameExit ? b.status : "replaced";

  // The L2 withdrawal: in the batch's inbox range, to the payout's exit address, for the exit's amount;
  // the k-th such withdrawal for the k-th front of this payout and amount in the batch.
  let postedAt: number | undefined;
  const amountUqor = (f.paid + f.fee) / WEI_PER_UQOR;
  const rank = fronts.filter((g) => g.batchIndex === f.batchIndex && g.payout === f.payout && g.paid + g.fee === f.paid + f.fee && g.withdrawalIndex < f.withdrawalIndex).length;
  if (b && sameExit && b.inboxEnd > b.inboxStart) {
    let ea = exitAddresses.get(f.payout);
    if (!ea) {
      ea = hexToBech32(await pub.readContract({ address: vault, abi: VIEWS, functionName: "exitAddressOf", args: [f.payout] }), "qor");
      exitAddresses.set(f.payout, ea);
    }
    const entries = await reader.read(b.inboxStart, b.inboxEnd);
    const matches = entries.filter((e) => {
      try {
        const q = decodeQledgerTx(hexToBytes(e.payloadHex));
        return !!q && q.kind === QLEDGER_KIND_WITHDRAW && q.recipient === ea && q.amount === amountUqor;
      } catch {
        return false;
      }
    });
    const w = matches[rank];
    if (w) postedAt = await l1Time(w.height);
  }
  const r = repayments.get(f.exitId.toLowerCase());
  const repaidAt = r?.completedBy ? await evmTime(r.completedBy.block) : undefined;
  exits.push({
    id: f.exitId,
    batchIndex: f.batchIndex,
    withdrawalIndex: f.withdrawalIndex,
    amountUqor,
    postedAt,
    batchAt: b?.submittedTime || undefined,
    finalFrom: b?.submittedTime ? b.submittedTime + windowSec : undefined,
    paidAt,
    repaidAt,
    paidWei: f.paid,
    feeWei: f.fee,
    frontGas: rcpt.gasUsed,
    frontTx: f.tx,
    batchStatus: status,
    payout: f.payout,
    sweepTx: r?.completedBy?.tx,
    frontBlock: f.block,
  });
}

// ------------------------------------------------------------------ the file
const now = Math.floor(Date.now() / 1000);
const rows = ledgerRows(exits, now);
const s = ledgerSummary(rows);
const spreadOut = (x: Spread | undefined) => (x ? { n: x.n, median: x.median, min: x.min, max: x.max } : null);
const rowOut = (r: LedgerRow) => {
  const e = exits.find((x) => x.id === r.id)!;
  return {
    batchIndex: r.batchIndex,
    withdrawalIndex: r.withdrawalIndex,
    exitId: r.id,
    amountQor: qorOf(r.amountUqor === undefined ? undefined : r.amountUqor * WEI_PER_UQOR),
    payout: e.payout,
    batchStatus: r.batchStatus,
    postedAt: iso(r.postedAt) ?? null,
    batchAt: iso(r.batchAt) ?? null,
    paidAt: iso(r.paidAt) ?? null,
    couldBeFinalAt: iso(r.finalFrom) ?? null,
    repaidAt: iso(r.repaidAt) ?? null,
    postToPaidSec: r.postToPaidSec ?? null,
    batchToPaidSec: r.batchToPaidSec ?? null,
    aheadOfFinalitySec: r.aheadOfFinalitySec ?? null,
    repaidAfterSec: r.repaidAfterSec ?? null,
    repaidAfterFinalSec: r.repaidAfterFinalSec ?? null,
    outcome: r.outcome,
    paidQor: qorOf(r.paidWei),
    feeQor: qorOf(r.feeWei),
    frontGas: r.frontGas === undefined ? null : Number(r.frontGas),
    frontTx: r.frontTx,
    frontEvmBlock: e.frontBlock,
    sweepTx: e.sweepTx ?? null,
  };
};

const doc = {
  what: "Every instant exit the InstantExitVault has fronted on vigil-pay-1, read from the chain by scripts/exit/metrics.ts. Times are block times as the node reports them.",
  readAt: iso(now),
  chain: { chainId: TESTNET.chainId, evmChainId: TESTNET.evmChainId, rollupId, vault, challengeWindowSec: windowSec },
  scan: { fromEvmBlock: Number(fromBlock), toEvmBlock: Number(latest), getLogsRequests: spans, requests },
  sample: s.n < SMALL_SAMPLE ? `small: ${s.n} fronted exit${s.n === 1 ? "" : "s"}` : `${s.n} fronted exits`,
  summary: {
    fronted: s.n,
    postToPaidSec: spreadOut(s.postToPaid),
    batchToPaidSec: spreadOut(s.batchToPaid),
    aheadOfFinalitySec: spreadOut(s.aheadOfFinality),
    repaidAfterSec: spreadOut(s.repaidAfter),
    frontGas: spreadOut(s.frontGas),
    repaid: s.repaid,
    pending: s.pending,
    overdue: s.overdue,
    frontedOnRejectedBatch: s.owed,
    owedByExitAddressQor: qorOf(s.owedWei),
    feesEarnedQor: qorOf(s.feesWei),
    paidQor: qorOf(s.paidWei),
    latestPaidAt: iso(s.latestPaidAt) ?? null,
  },
  exits: rows.map(rowOut),
  notes: [
    "postToPaid: from the block of the L2 withdrawal's post to the EVM block of front(). batchToPaid: from the batch's submission block. aheadOfFinality: from front() to the earliest time the batch could be final (submitted time plus the challenge window).",
    "repaidAfter: from front() to the sweep() that completed the vault's repayment for this exit (repayments are attributed first in, first out per payout, as on the Exits page).",
    "Only fronted exits are rows. An attested exit that nobody fronted is paid in full after finality and does not appear here.",
    "frontedOnRejectedBatch: exits fronted against a batch that was then rejected or replaced; the exit address then owes the vault, and its later withdrawals repay that first (THREAT_MODEL §14). feesEarned: fees on exits the vault has been repaid for.",
    "Recompute: pnpm --filter @vigil/scripts exit:metrics",
  ],
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}: ${s.n} exits, ${requests} requests at most ${rps}/s`);
for (const r of rows) {
  console.log(`  batch ${r.batchIndex} w${r.withdrawalIndex}: post→paid ${r.postToPaidSec ?? "?"} s, batch→paid ${r.batchToPaidSec ?? "?"} s, ahead of finality ${r.aheadOfFinalitySec ?? "?"} s, repaid after ${r.repaidAfterSec ?? "?"} s, gas ${r.frontGas ?? "?"}, ${r.outcome}`);
}
