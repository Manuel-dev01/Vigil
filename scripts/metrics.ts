/**
 * Vigil in numbers, recomputed from the chain. Read-only; needs no key and writes nothing on chain.
 *
 * It reads vigil-pay-1 over the public REST endpoint and the EVM JSON-RPC endpoint, one request at a
 * time about a second apart (about 30 requests), plus the committed inbox archive. Then it writes:
 *   docs/metrics.json   the snapshot (the landing page shows its six-number strip)
 *   docs/METRICS.md     the full tables
 *   README.md           the numbers block between the metrics markers
 *
 *   pnpm --filter @vigil/scripts metrics [--dry-run]
 *   pnpm --filter @vigil/scripts metrics --render   # no network: rewrite the files from docs/metrics.json
 *
 * Transaction hashes it needs but cannot find by itself (the forged batches of the fraud drills, the
 * payslip rounds) come from EVIDENCE.md, and each one is read back from the chain.
 */
import "./lib/net.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RECEIPT_ALGORITHM,
  anchorSignBytesVersionFor,
  base64ToBytes,
  bytesToHex,
  createRdkClient,
  hexToBech32,
  qledgerWithdrawalsRoot,
  verifySettlementReceipt,
  type AnchorView,
  type BatchView,
  type FetchLike,
  type SettlementReceipt,
} from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { EMPTY_ACC, accumulate, committedArchivePath, readArchiveFile } from "@vigil/core/inbox";
import { isSealedEnvelope } from "@vigil/sealed/payslip";
import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData, parseAbi, toHex, type Abi, type Hex } from "viem";
import { REPO_ROOT } from "./lib/env.ts";
import {
  EMPLOYER,
  METRICS_SCHEMA,
  WATCHTOWERS,
  WEI_PER_UQOR,
  buildStrip,
  consumedTo,
  countBatches,
  daysBetween,
  exitRow,
  finalWithVerifiedAnchor,
  findWithdrawalPost,
  isoUtc,
  renderMarkdown,
  renderReadmeStrip,
  repaidPercent,
  replaceBlock,
  sealedBy,
  spentBy,
  standbyRows,
  type ExitRow,
  type FraudRow,
  type FrontIn,
  type PayslipRound,
  type Snapshot,
} from "./metrics/model.ts";

const ROLLUP = "vigil-pay-1";
const CHAIN_ID = TESTNET.chainId;
const dryRun = process.argv.includes("--dry-run");
const GAP_MS = 1_100;
const JSON_PATH = resolve(REPO_ROOT, "docs/metrics.json");

function writeAll(s: Snapshot): void {
  writeFileSync(JSON_PATH, JSON.stringify(s, null, 2) + "\n");
  writeFileSync(resolve(REPO_ROOT, "docs/METRICS.md"), renderMarkdown(s));
  const readmePath = resolve(REPO_ROOT, "README.md");
  writeFileSync(readmePath, replaceBlock(readFileSync(readmePath, "utf8"), renderReadmeStrip(s)));
  console.log("wrote docs/metrics.json, docs/METRICS.md and the README's numbers");
}

// Re-render from the committed snapshot (after a wording change), without reading the chain.
if (process.argv.includes("--render")) {
  const { strip: _old, ...saved } = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Snapshot;
  writeAll({ ...saved, strip: buildStrip(saved) });
  process.exit(0);
}

/** The forged batches of the two fraud drills (EVIDENCE 43 and 54), read back for their heights. */
const FORGED: { batchIndex: number; tx: string; drill: string; evidence: number[] }[] = [
  { batchIndex: 6, tx: "E3E71FB6BFE0A2102C9490A11F18205913926513DA524E225B59CB931DF7D11E", drill: "fraud drill 1", evidence: [43, 44] },
  { batchIndex: 8, tx: "6802887DBC277445377D70C1D2474AEC30ED3C00059F08943DF16DFB8E1D1A9A", drill: "fraud drill 2", evidence: [54, 55] },
];
/** Payslip rounds: the public payment and the sealed payslip that explains it. */
const ROUNDS: Omit<PayslipRound, "spentUqor" | "envelopeBytes">[] = [
  { period: "2026-11", paymentEntry: 5, envelopeEntry: 6, paymentTx: "73287A6BDDF3363C0D4BD8FEF9A428B7DC1D7A14386DB72ECAE5152432C58C22", envelopeTx: "0B70265B742B431607B01A423E1AF1CE5AA915C948373F5AFAED780753B18B9B", evidence: [35, 37] },
  { period: "2026-12", paymentEntry: 23, envelopeEntry: 24, paymentTx: "4C279045078423757280BFE453B112413AE2698E7E972FB6D18855B65051FD66", envelopeTx: "8ADA7C5E04F5A1CB66C3372A4DA3C8A81CD7B3094DFF0BED6D7A17F0068A1739", evidence: [114, 115] },
  { period: "2027-01", paymentEntry: 26, envelopeEntry: 27, paymentTx: "F82CF360FB8294E00872E0605EB7C3C3586A1F26CD0FF9A1760E50F6ABED6814", envelopeTx: "013F7B58409CF2FF39099F9CA301E4EEA82BC941EC8FA3DB89C8CF37B7F7B982", evidence: [121, 122] },
];

// ------------------------------------------------------------------ one request at a time

let requests = 0;
let nextAt = 0;
let queue: Promise<unknown> = Promise.resolve();
const baseFetch = globalThis.fetch;
const throttled = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const run = async (): Promise<Response> => {
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAt = Date.now() + GAP_MS;
    requests++;
    return baseFetch(input, init);
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}) as typeof fetch;
globalThis.fetch = throttled;

const rdk = createRdkClient({ network: "testnet", fetch: throttled as unknown as FetchLike });
const rest = rdk.rest;

async function evm<T>(method: string, params: unknown[]): Promise<T> {
  const res = await throttled(TESTNET.evmRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requests, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "error"}`);
  return body.result as T;
}
/** A block's height and time: from the EVM endpoint, or from REST if that endpoint no longer serves the block. */
const block = async (h: number | "latest"): Promise<{ height: number; time: number }> => {
  try {
    const b = await evm<{ number: Hex; timestamp: Hex } | null>("eth_getBlockByNumber", [h === "latest" ? "latest" : toHex(h), false]);
    if (b) return { height: Number(b.number), time: Number(b.timestamp) };
  } catch {
    // fall through to REST
  }
  const res = await throttled(`${TESTNET.rest}/cosmos/base/tendermint/v1beta1/blocks/${h}`);
  if (!res.ok) throw new Error(`block ${h}: HTTP ${res.status}`);
  const header = ((await res.json()) as { block?: { header?: { height?: string; time?: string } } }).block?.header;
  const time = Date.parse(header?.time ?? "");
  if (!header?.height || !Number.isFinite(time)) throw new Error(`block ${h}: no header`);
  return { height: Number(header.height), time: Math.floor(time / 1000) };
};
async function call<T>(abi: Abi, to: Hex, functionName: string, args: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args });
  const ret = await evm<Hex>("eth_call", [{ to, data }, "latest"]);
  return decodeFunctionResult({ abi, functionName, data: ret }) as T;
}

type TxRecord = { tx_response?: { height?: string; events?: { type: string; attributes?: { key: string; value: string }[] }[] } };
const log = (msg: string): void => console.log(msg);

// ------------------------------------------------------------------ the rollup, its batches and anchors

const deployments = JSON.parse(readFileSync(resolve(REPO_ROOT, "deployments/diana.json"), "utf8")) as {
  SettlementReceiptVerifier: { address: Hex };
  InstantExitVault: { address: Hex; block: string };
};
const verifierAbi = parseAbi(["function attestedCount() view returns (uint64)", "function highestHeight() view returns (uint64)", "function conflictCount() view returns (uint64)"]);
const vaultAbi = parseAbi([
  "function totalOwed() view returns (uint256)",
  "function exitAddressOf(address payout) view returns (address)",
  "event Fronted(bytes32 indexed exitId, address indexed payout, uint64 batchIndex, uint64 withdrawalIndex, uint256 paid, uint256 fee)",
]);

const tip = await block("latest");
log(`tip ${tip.height} at ${isoUtc(tip.time)}`);
const rollup = await rest.getRollup(ROLLUP);
const layerId = rollup.layerId || ROLLUP;
const created = await block(rollup.createdHeight);
const batches: BatchView[] = await rest.listBatches(ROLLUP);
const anchors: AnchorView[] = (await rest.getAnchors(layerId)).sort((a, b) => a.layerHeight - b.layerHeight);
log(`${batches.length} batches listed, ${anchors.length} anchors`);
for (const b of batches) log(`  batch ${b.batchIndex} ${b.status} at ${b.submittedAt}, inbox (${b.inboxStart}, ${b.inboxEnd}]`);

// The committed archive, checked link by link and then against the chain's commitment for its last entry.
const archive = readArchiveFile(committedArchivePath(ROLLUP));
if (archive.problem) throw new Error(`the committed archive is damaged: ${archive.problem}`);
const rows = archive.rows;
let acc = EMPTY_ACC;
for (const r of rows) {
  acc = accumulate({ chainId: CHAIN_ID, rollupId: ROLLUP }, acc, r);
  if (acc !== r.acc) throw new Error(`the committed archive does not chain at entry ${r.sequence}`);
}
const head = rows.at(-1)?.sequence ?? 0;
let confirmedByChain = false;
try {
  confirmedByChain = head > 0 && (await rest.getPostedData(ROLLUP, head)).inboxAcc.toLowerCase() === acc;
} catch {
  confirmedByChain = false;
}
log(`archive: ${rows.length} entries to ${head}, ${confirmedByChain ? "confirmed by the chain" : "NOT confirmed by the chain"}`);
const chainInboxEnd = consumedTo(batches);
if (chainInboxEnd > head) log(`WARNING: the chain's batches have consumed entries to ${chainInboxEnd}, beyond the archive's ${head}; refresh it with pnpm --filter @vigil/scripts inbox:archive`);

// Every anchor's ML-DSA-87 signature, checked here by the RDK (signature-only mode) against the key the node reports.
const creatorKey = (await rest.getPqcAccount(rollup.creator)).publicKey;
const byIndex = new Map(batches.map((b) => [b.batchIndex, b]));
const verified = new Set<number>();
const failed: number[] = [];
for (const a of anchors) {
  const receipt: SettlementReceipt = {
    version: 2,
    chainId: CHAIN_ID,
    rollupId: ROLLUP,
    layerId: a.layerId,
    batchIndex: a.layerHeight,
    creator: rollup.creator,
    algorithm: RECEIPT_ALGORITHM,
    stateRoot: a.stateRoot,
    layerHeight: a.layerHeight,
    validatorSetHash: a.validatorSetHash,
    mainChainHeight: a.mainChainHeight,
    anchoredAt: a.anchoredAt,
    pqcSignature: a.pqcSignature,
    batchStateRoot: byIndex.get(a.layerHeight)?.stateRoot ?? a.stateRoot,
    transactionCount: a.transactionCount,
    compressedStateProof: a.compressedStateProof,
  };
  const version = anchorSignBytesVersionFor(a.mainChainHeight, rdk.network.anchorSignV2Height);
  const v = await verifySettlementReceipt(receipt, { creatorPublicKey: creatorKey });
  if (v.checks.pqcSignature && v.signBytesVersion === version) verified.add(a.layerHeight);
  else failed.push(a.layerHeight);
}
log(`anchors verified: ${verified.size} of ${anchors.length}`);

const verifier = deployments.SettlementReceiptVerifier.address;
const attested = Number(await call<bigint>(verifierAbi, verifier, "attestedCount"));
const highest = Number(await call<bigint>(verifierAbi, verifier, "highestHeight"));
const conflicts = Number(await call<bigint>(verifierAbi, verifier, "conflictCount"));
log(`SettlementReceiptVerifier: ${attested} attested, highest ${highest}, ${conflicts} conflicts`);

// ------------------------------------------------------------------ fraud

const fraudTxs = (await rest.searchTxs(`rdk_fraud_upheld.rollup_id='${ROLLUP}'`)) as { height?: string; txhash?: string; events?: { type: string; attributes?: { key: string; value: string }[] }[] }[];
const upheld: FraudRow[] = [];
for (const t of fraudTxs) {
  for (const ev of t.events ?? []) {
    if (ev.type !== "rdk_fraud_upheld") continue;
    const a = Object.fromEntries((ev.attributes ?? []).map((x) => [x.key, x.value]));
    if (a["rollup_id"] !== ROLLUP) continue;
    const challenger = a["challenger"] ?? "";
    const slashed = /^\d+/.exec(a["slashed"] ?? "")?.[0];
    upheld.push({
      batchIndex: Number(a["batch_index"]),
      tx: t.txhash ?? "",
      height: Number(t.height ?? 0),
      challenger,
      ours: challenger in WATCHTOWERS,
      ...(slashed ? { slashedUqor: slashed } : {}),
      evidence: [],
    });
  }
}
for (const f of upheld) {
  const known = FORGED.find((x) => x.batchIndex === f.batchIndex);
  if (!known) continue;
  f.evidence = known.evidence;
  f.drill = known.drill;
  const h = Number(((await rest.getTx(known.tx)) as TxRecord).tx_response?.height ?? 0);
  if (h > 0 && h <= f.height) {
    f.forgedTx = known.tx;
    f.forgedHeight = h;
    f.blocksAfterBatch = f.height - h;
  }
}
upheld.sort((a, b) => a.height - b.height);
log(`fraud upheld: ${upheld.map((f) => `batch ${f.batchIndex} at ${f.height}${f.blocksAfterBatch !== undefined ? ` (+${f.blocksAfterBatch})` : ""}`).join("; ") || "none"}`);

// ------------------------------------------------------------------ instant exits

const vault = deployments.InstantExitVault.address;
const vaultBlock = Number(deployments.InstantExitVault.block);
const rootHex = (s: string): string => (/^(0x)?[0-9a-fA-F]{64}$/.test(s) ? s.replace(/^0x/, "").toLowerCase() : bytesToHex(base64ToBytes(s)).toLowerCase());
const emptyRoot = bytesToHex(qledgerWithdrawalsRoot(CHAIN_ID, ROLLUP, [])).toLowerCase();
const afterVault = batches.filter((b) => b.status !== "rejected" && b.submittedAt >= vaultBlock);
const anyEmpty = batches.some((b) => rootHex(b.withdrawalsRoot) === emptyRoot);
// A batch with no withdrawals carries the empty withdrawals root. If no batch matches it, the root's form
// is not what we expect, so every batch since the vault is searched instead.
const withWithdrawals = anyEmpty ? afterVault.filter((b) => rootHex(b.withdrawalsRoot) !== emptyRoot) : afterVault;
const [frontedTopic] = encodeEventTopics({ abi: vaultAbi, eventName: "Fronted" });
const fronts: FrontIn[] = [];
const seen = new Set<string>();
for (const b of withWithdrawals) {
  // An exit is fronted while its batch is not yet final: the watchtowers sign a deadline before finality.
  const to = Math.min(b.finalizedAt > 0 ? b.finalizedAt : tip.height, b.submittedAt + 9_999);
  const logs = await evm<{ topics: Hex[]; data: Hex; transactionHash: Hex; blockNumber: Hex; logIndex: Hex }[]>("eth_getLogs", [
    { address: vault, topics: [frontedTopic], fromBlock: toHex(b.submittedAt), toBlock: toHex(to) },
  ]);
  for (const l of logs) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ev = decodeEventLog({ abi: vaultAbi, eventName: "Fronted", topics: l.topics as [Hex, ...Hex[]], data: l.data });
    fronts.push({
      batchIndex: Number(ev.args.batchIndex),
      withdrawalIndex: Number(ev.args.withdrawalIndex),
      payout: ev.args.payout,
      paidWei: ev.args.paid,
      feeWei: ev.args.fee,
      tx: l.transactionHash,
      height: Number(l.blockNumber),
    });
  }
}
fronts.sort((a, b) => a.height - b.height);
const exitRows: ExitRow[] = [];
for (const f of fronts) {
  const b = byIndex.get(f.batchIndex);
  if (!b) continue;
  const exitAddress = await call<Hex>(vaultAbi, vault, "exitAddressOf", [f.payout]);
  const post = findWithdrawalPost(b, rows, hexToBech32(exitAddress, "qor"), (f.paidWei + f.feeWei) / WEI_PER_UQOR);
  const frontTime = (await block(f.height)).time;
  const postTime = post ? (await block(post.height)).time : undefined;
  exitRows.push(
    exitRow({
      front: f,
      batch: b,
      frontTime,
      ...(post && postTime !== undefined ? { post, postTime } : {}),
      ...(rollup.challengeWindowSec ? { challengeWindowSeconds: rollup.challengeWindowSec } : {}),
    }),
  );
}
const frontedUqor = fronts.reduce((s, f) => s + (f.paidWei + f.feeWei) / WEI_PER_UQOR, 0n);
const owedUqor = (await call<bigint>(vaultAbi, vault, "totalOwed")) / WEI_PER_UQOR;
log(`exits: ${exitRows.length} (searched batches ${withWithdrawals.map((b) => b.batchIndex).join(", ")}), owed ${owedUqor} uqor`);

// ------------------------------------------------------------------ payslips

const bySeq = new Map(rows.map((r) => [r.sequence, r]));
const sealedEntries = sealedBy(rows, EMPLOYER, (hex) => isSealedEnvelope(Buffer.from(hex, "hex")));
const rounds: PayslipRound[] = [];
for (const r of ROUNDS) {
  const round: PayslipRound = { ...r };
  const env = bySeq.get(r.envelopeEntry);
  if (env) round.envelopeBytes = env.payloadHex.length / 2;
  try {
    let spent = 0n;
    for (const [tx, entry] of [
      [r.paymentTx, r.paymentEntry],
      [r.envelopeTx, r.envelopeEntry],
    ] as const) {
      const poster = bySeq.get(entry)?.poster;
      const events = ((await rest.getTx(tx)) as TxRecord).tx_response?.events ?? [];
      if (!poster || events.length === 0) throw new Error(`no events for ${tx}`);
      spent += spentBy(events, poster);
    }
    round.spentUqor = String(spent);
  } catch (e) {
    log(`payslip round ${r.period}: ${(e as Error).message}`);
  }
  rounds.push(round);
}

// ------------------------------------------------------------------ write

const counts = countBatches(batches, anchors);
const base: Omit<Snapshot, "strip"> = {
  schema: METRICS_SCHEMA,
  rollupId: ROLLUP,
  chainId: CHAIN_ID,
  asOf: { height: tip.height, time: isoUtc(tip.time) },
  requests: 0,
  live: { createdHeight: rollup.createdHeight, createdTime: isoUtc(created.time), days: daysBetween(created.time, tip.time) },
  archive: { entries: rows.length, head, confirmedByChain, chainInboxEnd },
  batches: counts,
  anchors: {
    onChain: anchors.length,
    verified: verified.size,
    failed,
    finalWithVerifiedAnchor: finalWithVerifiedAnchor(batches, anchors, verified),
    attestedInSolidity: attested,
    highestAttested: highest,
    conflicts,
  },
  fraud: { upheld, fastPath: { seenAfterBlockSeconds: 1.6, judgedMs: 10, broadcastAfterMs: 254, evidence: 55 } },
  standby: standbyRows(batches, counts.unanchoredFinal, rows),
  exits: {
    rows: exitRows,
    frontedUqor: String(frontedUqor),
    owedUqor: String(owedUqor),
    repaidPercent: repaidPercent(frontedUqor, owedUqor),
    searchedBatches: withWithdrawals.map((b) => b.batchIndex),
  },
  payslips: { poster: EMPLOYER, sealedEntries, rounds },
};
base.requests = requests;
const snapshot: Snapshot = { ...base, strip: buildStrip(base) };

for (const i of snapshot.strip) log(`  ${i.value.padEnd(18)} ${i.label} (${i.note})`);
log(`${requests} read-only requests`);
if (!dryRun) writeAll(snapshot);
