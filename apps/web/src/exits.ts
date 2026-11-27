/**
 * Instant exits on vigil-pay-1, read from the chain at runtime.
 *
 * The InstantExitVault (contracts/src/InstantExitVault.sol) lives on QoreChain's EVM lane; it is read
 * with free eth_calls and its history with eth_getLogs, both from evm-testnet.qore.host. The watchtowers'
 * attestations are inbox entries of the rollup, read back over the node's websocket and checked against
 * the chain's inbox accumulator. Neither endpoint proves its answers.
 *
 * What runs in the browser: each attestation is accepted only if the chain says its member posted it and
 * its ML-DSA-87 signature verifies here (attest.ts), against the member's key, whose SHA-256 is pinned in
 * the page (config.ts). The chain's pqcVerify precompile is asked too, with an eth_call, as a second check
 * and to show what the vault itself would decide. The exit message is compared byte for byte with the
 * vault's exitMessage(), exit addresses are derived here from the pinned ExitAddress code, and the
 * vault's repayments are attributed to exits first in, first out (settle.ts).
 */
import {
  EMPTY_INBOX_ACC,
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  QLEDGER_KIND_WITHDRAW,
  base64ToBytes,
  bech32ToHex,
  bytesToHex,
  decodeQledgerTx,
  decodeWireBytes,
  encodeQledgerDeposit,
  hexToBech32,
  hexToBytes,
  isCanonicalQorAddress,
  postedDataHash,
  qledgerAccountId,
  qledgerAccumulate,
  verifyQledgerTx,
  type AnchorView,
  type BatchView,
  type RdkClient,
} from "@qorechain/rdk";
import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Abi, type Hex } from "viem";
import deployments from "../../../deployments/diana.json";
import { ML_DSA_87_PUBKEY_LEN, bytesOf, exitMessage, groupByExit, screenAttestations, type AcceptedClaim, type ExitClaim, type ExitTarget, type Rejection } from "./attest.ts";
import { chain, isNotFound } from "./chain.ts";
import { CHAIN_ID, KNOWN, ROLLUP } from "./config.ts";
import { ethCall, evmRpc } from "./evm.ts";
import { matchExecuted } from "./executed.ts";
import { exitAddressOf, parseHexAddress } from "./exit-address.ts";
import { keyPin, type KeyPin } from "./keys.ts";
import { explainMissingBatch, type MissingBatch } from "./pruned.ts";
import { rpc } from "./rpc.ts";
import { attributeRepayments, type Repayment } from "./settle.ts";

export { ML_DSA_87_PUBKEY_LEN, exitMessage } from "./attest.ts";
export type { ExitClaim, ExitTarget } from "./attest.ts";

// ------------------------------------------------------------ the vault on the EVM lane

interface VaultDeployment {
  address: Hex;
  deployTx: Hex;
  block: string;
  rollupId: string;
}
export const VAULT_DEPLOYMENT = (deployments as { InstantExitVault?: VaultDeployment }).InstantExitVault;

/** QoreChain's ML-DSA-87 verification precompile (FIPS 204 pure mode, empty context). */
export const PQC_VERIFY: Hex = "0x0000000000000000000000000000000000000a01";
/** The EVM endpoint refuses eth_getLogs whose [from, to] block distance is over 10,000. */
export const LOG_SPAN = 10_000;
const LOG_CONCURRENCY = 6;
const LOG_ATTEMPTS = 3;
/** 1 uqor (the rollup's withdrawal unit) is 10^12 wei of the same balance on the EVM side. */
export const WEI_PER_UQOR = 1_000_000_000_000n;
/** How many exits the page builds in full at first; "show more" raises it. */
export const EXITS_PAGE = 20;

const vaultAbi = parseAbi([
  "struct Exit { uint64 batchIndex; bytes32 stateRoot; uint64 withdrawalIndex; uint64 amountUqor; address payout; uint64 deadline; }",
  "function chainId() view returns (string)",
  "function rollupId() view returns (string)",
  "function quorum() view returns (address[])",
  "function threshold() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function lp() view returns (address)",
  "function available() view returns (uint256)",
  "function totalOwed() view returns (uint256)",
  "function owed(address) view returns (uint256)",
  "function keyOf(address account) view returns (bytes)",
  "function exitAddressOf(address payout) view returns (address)",
  "function exitMessage(Exit e) view returns (bytes)",
  "event Fronted(bytes32 indexed exitId, address indexed payout, uint64 batchIndex, uint64 withdrawalIndex, uint256 paid, uint256 fee)",
  "event Settled(address indexed payout, uint256 repaid, uint256 stillOwed)",
  "event Deposited(address indexed from, uint256 amount)",
  "event LiquidityWithdrawn(uint256 indexed nonce, address indexed to, uint256 amount)",
]);
const pqcAbi = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);

async function read<T>(to: Hex, functionName: string, args: readonly unknown[] = []): Promise<T> {
  const abi = vaultAbi as Abi;
  const data = encodeFunctionData({ abi, functionName, args });
  return decodeFunctionResult({ abi, functionName, data: await ethCall(to, data) }) as T;
}

export const toQor1 = (hex: string): string => hexToBech32(hex, "qor");
const lower = (h: string): string => h.toLowerCase();
const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A known name for an account, given as qor1 or 0x. */
export function nameOf(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  if (addr.startsWith("qor1")) return KNOWN[addr];
  try {
    return KNOWN[toQor1(addr)];
  } catch {
    return undefined;
  }
}

/** Retry a read once before giving up (public endpoints drop the odd request). */
async function twice<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    return f();
  }
}

/** Cache a promise by key; a rejected one is dropped so the next refresh asks again. */
function cached<K, V>(m: Map<K, Promise<V>>, k: K, f: () => Promise<V>): Promise<V> {
  let p = m.get(k);
  if (!p) {
    p = f();
    m.set(k, p);
    p.catch(() => m.delete(k));
  }
  return p;
}

// ------------------------------------------------------------ what the page shows

export interface Member {
  address: Hex;
  qor1: string;
  /** The ML-DSA-87 key the vault reads with keyOf (pqcKeyStatus), or undefined if it could not be read. */
  key: Hex | undefined;
  /** Key length in bytes (2592 = registered, ML-DSA-87, possession proven); 0 = not usable. */
  keyBytes: number;
  /** The key against the SHA-256 pinned in this page, once read. */
  pin: KeyPin | undefined;
}

/** Liquidity in (a bank send or an EVM transfer to the vault) or out (an LP withdrawal; `wei` negative, `from` is the recipient). */
export interface Funding {
  tx: string;
  height: number;
  time: number;
  from: string;
  wei: bigint;
  via: "bank send" | "EVM transfer" | "LP withdrawal";
}

export interface VaultState {
  address: Hex;
  qor1: string;
  deployTx: Hex;
  deployBlock: number;
  chainId: string;
  rollupId: string;
  evmChainId: number;
  members: Member[];
  threshold: number;
  feeBps: number;
  lp: Member;
  lpIsCreator: boolean;
  available: bigint;
  totalOwed: bigint;
  frontedCount: number;
  feesEarned: bigint;
  funding: Funding[];
}

export interface InboxEntry {
  sequence: number;
  height: number;
  /** Unix seconds. */
  time: number;
  tx: string;
  poster: string;
  payload: Uint8Array;
}

export interface SigCheck {
  /** The precompile's answer; undefined if it could not be asked or answered with no data. */
  valid: boolean | undefined;
  ms: number;
  error?: string;
}

export interface AttestationView {
  member: Member;
  memberIndex: number;
  entry: InboxEntry;
  claim: ExitClaim;
  /** Whether this is the claim shown for the exit (amount, recipient, deadline all equal). */
  sameClaim: boolean;
  /** ML-DSA-87 checked in this browser: true, or undefined when the member's key could not be read. */
  local: true | undefined;
  /** The chain's pqcVerify precompile, asked with an eth_call. */
  pqc: SigCheck;
}

export interface BatchInfo {
  index: number;
  /**
   * The chain's status; "pruned" when the record is gone and pruning explains it; "missing" when it is
   * gone and pruning does not explain it; "replaced" when the chain's batch at this index has another
   * root (the attested batch was rejected and its index reused).
   */
  status: string;
  final: boolean;
  missing: MissingBatch | undefined;
  /** The chain's state root for the batch (from the record, or from its anchor when pruned), 64 hex. */
  root: string | undefined;
  sameRoot: boolean | undefined;
  submittedHeight: number | undefined;
  /** Unix seconds. */
  submittedTime: number | undefined;
  /** Earliest time the batch could be final: submitted time plus the challenge window. */
  finalFrom: number | undefined;
  finalizedHeight: number | undefined;
  finalizedTime: number | undefined;
  tx: string | undefined;
  inboxStart: number | undefined;
  inboxEnd: number | undefined;
  anchored: boolean;
}

export interface WithdrawalView {
  entry: InboxEntry;
  amount: bigint;
  recipient: string;
  /** The L2 account (SHA-256 of its ML-DSA-44 key), 64 hex. */
  account: string;
  signatureValid: boolean;
}

export interface EvmEvent {
  tx: Hex;
  block: number;
  logIndex: number;
  time: number;
  from: Hex | undefined;
  /** Gas the transaction used, from its receipt (undefined if the receipt could not be read). */
  gasUsed: bigint | undefined;
}

export interface FrontedView extends EvmEvent {
  exitId: Hex;
  payout: Hex;
  batchIndex: number;
  withdrawalIndex: number;
  paid: bigint;
  fee: bigint;
}

export interface SettledView extends EvmEvent {
  payout: Hex;
  repaid: bigint;
  stillOwed: bigint;
}

export interface ExecutedView {
  tx: string;
  height: number;
  time: number;
  submitter: string;
  recipient: string;
  amount: bigint;
}

export interface ExitView {
  id: Hex;
  batchIndex: number;
  withdrawalIndex: number;
  /** The claim the quorum signed; undefined only for a fronted exit whose attestations are not in the inbox. */
  claim: ExitClaim | undefined;
  recipientQor1: string | undefined;
  withdrawal: WithdrawalView | undefined;
  batch: BatchInfo | undefined;
  attestations: AttestationView[];
  /** Members whose signature on the shown claim verified here (and pqcVerify did not refute). */
  validSigners: number;
  /** The page's exit message against the vault's exitMessage() for the fronted payout. */
  messageCheck: { same: boolean; bytes: number } | { error: string } | undefined;
  fronted: FrontedView | undefined;
  /** This exit's share of the payout's repayments, first in first out. */
  repayment: Repayment<SettledView> | undefined;
  owedNow: bigint | undefined;
  executed: ExecutedView | undefined;
  /** Set when this exit could not be read; the rest of the page is unaffected. */
  error?: string;
}

export interface Checks {
  /** Local ML-DSA-87 on accepted claims: verified, and kept unverified because the key could not be read. */
  local: { verified: number; unchecked: number };
  /** pqcVerify answers for those claims. */
  pqc: { valid: number; invalid: number; unanswered: number };
  /** Member and LP keys against the pinned SHA-256. */
  keys: { match: number; mismatch: number; unread: number };
}

export interface LogScan {
  from: number;
  to: number;
  /** eth_getLogs requests this refresh (and since the page opened). */
  requests: number;
  totalRequests: number;
  /** Block ranges that failed after retries; asked again next refresh. */
  gaps: [number, number][];
}

export interface ExitsState {
  vault: VaultState;
  exits: ExitView[];
  /** All exits found (cards beyond `exits` are built on "show more"). */
  totalExits: number;
  inbox: {
    head: number;
    read: number;
    accumulatorOk: boolean | undefined;
    /** New entries read this refresh (0 when nothing changed). */
    fetched: number;
    /** Attestation posts accepted, and the ones rejected by reason. */
    accepted: number;
    rejected: { reason: Rejection; count: number; example: string }[];
  };
  checks: Checks;
  challengeWindowSec: number | undefined;
  logs: LogScan;
  loadedAt: number;
}

// ------------------------------------------------------------ EVM reads

interface RawLog {
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

/** Logs already read, and the first block not yet read without a gap: each refresh reads only new blocks. */
const logScan = { next: 0, logs: new Map<string, RawLog>(), totalRequests: 0 };

async function getLogs(vault: Hex, a: number, b: number): Promise<{ logs: RawLog[] | undefined; requests: number }> {
  let requests = 0;
  for (let attempt = 0; attempt < LOG_ATTEMPTS; attempt++) {
    if (attempt) await sleep(500 * 3 ** (attempt - 1));
    requests++;
    try {
      return { logs: await evmRpc<RawLog[]>("eth_getLogs", [{ address: vault, fromBlock: toHex(a), toBlock: toHex(b) }]), requests };
    } catch {
      // retried below; a range that keeps failing is reported as a gap, not as a failed page
    }
  }
  return { logs: undefined, requests };
}

async function vaultLogs(vault: Hex, deployBlock: number): Promise<{ logs: RawLog[]; scan: LogScan }> {
  const latest = Number(await twice(() => evmRpc<Hex>("eth_blockNumber", [])));
  const from = Math.max(logScan.next, deployBlock);
  const ranges: [number, number][] = [];
  for (let a = from; a <= latest; a += LOG_SPAN + 1) ranges.push([a, Math.min(a + LOG_SPAN, latest)]);
  const ok: boolean[] = [];
  let i = 0;
  let requests = 0;
  const worker = async (): Promise<void> => {
    while (i < ranges.length) {
      const k = i++;
      const [a, b] = ranges[k]!;
      const r = await getLogs(vault, a, b);
      requests += r.requests;
      ok[k] = !!r.logs;
      for (const l of r.logs ?? []) logScan.logs.set(`${l.transactionHash}:${l.logIndex}`, l);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, ranges.length) }, worker));
  logScan.totalRequests += requests;
  const gaps = ranges.filter((_, k) => !ok[k]);
  // The cursor stops at the first gap; otherwise it re-reads the last few blocks next time, in case the
  // endpoint had not indexed them yet.
  logScan.next = gaps.length ? gaps[0]![0] : Math.max(from, latest - 4);
  const logs = [...logScan.logs.values()].sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || Number(x.logIndex) - Number(y.logIndex));
  return { logs, scan: { from: deployBlock, to: latest, requests, totalRequests: logScan.totalRequests, gaps } };
}

const blockTimes = new Map<number, Promise<number>>();
const evmBlockTime = (n: number): Promise<number> =>
  cached(blockTimes, n, async () => Number((await twice(() => evmRpc<{ timestamp: Hex }>("eth_getBlockByNumber", [toHex(n), false]))).timestamp));

/**
 * The sender and gas used of a vault transaction, from its receipt: one request per transaction, as the
 * sender alone took before. A receipt the endpoint does not have yet is asked again next refresh.
 */
const receipts = new Map<string, Promise<{ from: Hex | undefined; gasUsed: bigint | undefined }>>();
const txReceipt = (hash: Hex): Promise<{ from: Hex | undefined; gasUsed: bigint | undefined }> =>
  cached(receipts, hash, async () => {
    const r = await evmRpc<{ from?: Hex; gasUsed?: Hex } | null>("eth_getTransactionReceipt", [hash]);
    if (!r) throw new Error(`no receipt for ${hash} yet`);
    return { from: r.from, gasUsed: r.gasUsed ? BigInt(r.gasUsed) : undefined };
  });

const sigChecks = new Map<Hex, Promise<SigCheck>>();

/** Ask the chain's pqcVerify precompile, with a free eth_call. */
function pqcVerify(pubkey: Hex, signature: Uint8Array, message: Uint8Array): Promise<SigCheck> {
  const data = encodeFunctionData({ abi: pqcAbi, functionName: "pqcVerify", args: [pubkey, toHex(signature), toHex(message)] });
  return cached(sigChecks, keccak256(data), async () => {
    const t0 = performance.now();
    const ret = await twice(() => ethCall(PQC_VERIFY, data));
    const ms = Math.round(performance.now() - t0);
    // An inactive precompile answers with success and no data; only a 32-byte word is an answer.
    if (ret.length !== 66) return { valid: undefined, ms, error: `the precompile answered ${(ret.length - 2) / 2} bytes, not a verdict` };
    return { valid: decodeFunctionResult({ abi: pqcAbi, functionName: "pqcVerify", data: ret }), ms };
  });
}

const messageChecks = new Map<string, Promise<Hex>>();
/** Local ML-DSA-87 verdicts, by key and signed bytes (see screenAttestations). */
const localVerdicts = new Map<string, boolean>();

// ------------------------------------------------------------ chain reads over the websocket

interface TxResponse {
  txhash?: string;
  height?: string;
  timestamp?: string;
  code?: number;
  tx?: { body?: { messages?: Record<string, unknown>[] } } | null;
  events?: { type: string; attributes?: { key: string; value: string }[] }[];
}

const attrs = (ev: { attributes?: { key: string; value: string }[] }): Record<string, string> =>
  Object.fromEntries((ev.attributes ?? []).map((a) => [a.key, a.value]));
const search = async (rdk: RdkClient, q: string): Promise<TxResponse[]> => ((await rdk.rest.searchTxs(q)) as TxResponse[]).filter((t) => (t.code ?? 0) === 0);
const unix = (iso: string | undefined): number => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);
const uqor = (s: string | undefined): bigint => {
  const t = (s ?? "0").replace(/uqor$/, "") || "0";
  return /^\d+$/.test(t) ? BigInt(t) : 0n;
};
const seqOf = (s: string | undefined): number => {
  const n = Number(s ?? 0);
  return Number.isSafeInteger(n) ? n : 0;
};

/** Inbox entries in (have, head], from the transactions that posted them, at or after `sinceHeight`. */
async function inboxEntries(rdk: RdkClient, have: number, head: number, sinceHeight: number): Promise<InboxEntry[]> {
  const since = sinceHeight > 0 ? ` AND tx.height>=${sinceHeight}` : "";
  const [posts, deposits] = await Promise.all([search(rdk, `rdk_data_posted.rollup_id='${ROLLUP}'${since}`), search(rdk, `rdk_rollup_deposit.rollup_id='${ROLLUP}'${since}`)]);
  const bySeq = new Map<number, InboxEntry>();
  for (const t of posts) {
    const msgs = (t.tx?.body?.messages ?? []).filter((m) => m["@type"] === "/qorechain.rdk.v1.MsgPostRollupData");
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_data_posted") continue;
      const a = attrs(ev);
      const seq = seqOf(a["sequence"]);
      if (a["rollup_id"] !== ROLLUP || seq <= have || seq > head) continue;
      const m = msgs.find((x) => String(x["poster"]) === a["poster"] && bytesToHex(postedDataHash(base64ToBytes(String(x["data"] ?? "")))) === lower(a["data_hash"] ?? ""));
      if (!m) continue;
      bySeq.set(seq, { sequence: seq, height: Number(t.height ?? 0), time: unix(t.timestamp), tx: t.txhash ?? "", poster: a["poster"] ?? "", payload: base64ToBytes(String(m["data"])) });
    }
  }
  for (const t of deposits) {
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_rollup_deposit") continue;
      const a = attrs(ev);
      const seq = seqOf(a["sequence"]);
      if (a["rollup_id"] !== ROLLUP || seq <= have || seq > head) continue;
      try {
        bySeq.set(seq, {
          sequence: seq,
          height: Number(t.height ?? 0),
          time: unix(t.timestamp),
          tx: t.txhash ?? "",
          poster: QLEDGER_DEPOSIT_POSTER_PREFIX + (a["depositor"] ?? ""),
          payload: encodeQledgerDeposit(hexToBytes(a["account"] ?? ""), uqor(a["amount"])),
        });
      } catch {
        // a deposit event the page cannot re-encode; the accumulator check then reports the gap
      }
    }
  }
  return [...bySeq.values()].sort((x, y) => x.sequence - y.sequence);
}

/** Entries read so far, checked against the chain's accumulator; each refresh reads only newer ones. */
let inboxCache: { entries: InboxEntry[]; acc: Uint8Array; lastHeight: number } | undefined;

/**
 * Every inbox entry of the rollup, and whether together they reproduce the chain's inbox accumulator at
 * the head (so none is missing, changed or out of order). After the first read, only entries past the
 * last one read are fetched, and the accumulator is folded on from where it was.
 */
async function readInbox(rdk: RdkClient): Promise<{ entries: InboxEntry[]; head: number; accumulatorOk: boolean | undefined; fetched: number }> {
  const inbox = await rdk.rest.getInbox(ROLLUP);
  const head = Number(inbox.headSequence);
  const headAcc = lower(bytesToHex(decodeWireBytes(inbox.headAcc)));
  let c = inboxCache;
  if (c && c.entries.length > head) c = inboxCache = undefined; // the chain reports fewer entries than were read: start over
  const have = c?.entries.length ?? 0;
  if (c && head === have) return { entries: c.entries, head, accumulatorOk: lower(bytesToHex(c.acc)) === headAcc, fetched: 0 };
  const fresh = await inboxEntries(rdk, have, head, c?.lastHeight ?? 0);
  const entries = [...(c?.entries ?? []), ...fresh];
  const contiguous = entries.length === head && entries.every((e, i) => e.sequence === i + 1);
  let accumulatorOk: boolean | undefined;
  if (contiguous && head > 0) {
    const acc = qledgerAccumulate({ chainId: CHAIN_ID, rollupId: ROLLUP, from: have, accFrom: c?.acc ?? EMPTY_INBOX_ACC, entries: fresh });
    accumulatorOk = lower(bytesToHex(acc)) === headAcc;
    // Keep only what the chain's accumulator vouches for; anything else is read from scratch next time.
    inboxCache = accumulatorOk ? { entries, acc, lastHeight: Math.max(...entries.map((e) => e.height)) } : undefined;
  }
  return { entries, head, accumulatorOk, fetched: fresh.length };
}

type Executed = ExecutedView & { batchIndex: number; withdrawalIndex: number };

/** Withdrawals the chain has paid on L1 (MsgExecuteWithdrawal), from the rdk_withdrawal_executed event. */
async function executedWithdrawals(rdk: RdkClient): Promise<Executed[]> {
  const out: Executed[] = [];
  for (const t of await search(rdk, `rdk_withdrawal_executed.rollup_id='${ROLLUP}'`)) {
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_withdrawal_executed") continue;
      const a = attrs(ev);
      if (a["rollup_id"] !== ROLLUP) continue;
      const msg = (t.tx?.body?.messages ?? []).find(
        (m) => m["@type"] === "/qorechain.rdk.v1.MsgExecuteWithdrawal" && String(m["batch_index"]) === a["batch_index"] && String(m["withdrawal_index"]) === a["withdrawal_index"],
      );
      out.push({
        batchIndex: seqOf(a["batch_index"]),
        withdrawalIndex: seqOf(a["withdrawal_index"]),
        tx: t.txhash ?? "",
        height: Number(t.height ?? 0),
        time: unix(t.timestamp),
        submitter: String(msg?.["submitter"] ?? ""),
        recipient: a["recipient"] ?? "",
        amount: uqor(a["amount"]),
      });
    }
  }
  return out;
}

/** Bank sends into the vault's qor1 address (how the LP funds it: one balance, two views). */
async function bankFunding(rdk: RdkClient, vaultQor1: string): Promise<Funding[]> {
  const out: Funding[] = [];
  for (const t of await search(rdk, `transfer.recipient='${vaultQor1}'`)) {
    for (const m of t.tx?.body?.messages ?? []) {
      if (m["@type"] !== "/cosmos.bank.v1beta1.MsgSend" || m["to_address"] !== vaultQor1) continue;
      const coins = (m["amount"] as { denom: string; amount: string }[] | undefined) ?? [];
      const u = coins.filter((c) => c.denom === "uqor").reduce((n, c) => n + uqor(c.amount), 0n);
      if (u > 0n) out.push({ tx: t.txhash ?? "", height: Number(t.height ?? 0), time: unix(t.timestamp), from: String(m["from_address"]), wei: u * WEI_PER_UQOR, via: "bank send" });
    }
  }
  return out;
}

const headerTimes = new Map<number, Promise<number>>();
const blockTimeL1 = (height: number): Promise<number> =>
  cached(headerTimes, height, async () => unix((await rpc.call<{ header: { time: string } }>("header", { height: String(height) })).header.time));

const batchTxs = new Map<string, Promise<string | undefined>>();
const batchTx = (rdk: RdkClient, i: number, height: number): Promise<string | undefined> =>
  cached(batchTxs, `${i}:${height}`, async () => {
    for (const t of await search(rdk, `batch_submitted.rollup_id='${ROLLUP}' AND tx.height=${height}`)) {
      if ((t.events ?? []).some((ev) => ev.type === "batch_submitted" && attrs(ev)["batch_index"] === String(i))) return t.txhash;
    }
    return undefined;
  });

async function batchInfo(rdk: RdkClient, i: number, claimRoot: string | undefined, windowSec: number | undefined, anchors: Promise<AnchorView[]>, creator: string): Promise<BatchInfo> {
  let record: BatchView | undefined;
  try {
    record = await rdk.rest.getBatch(ROLLUP, i);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const own = (await anchors).filter((a) => a.layerHeight === i);
  if (record) {
    const root = lower(bytesToHex(decodeWireBytes(record.stateRoot)));
    const sameRoot = claimRoot ? root === claimRoot : undefined;
    const [tx, finalizedTime] = await Promise.all([
      batchTx(rdk, i, record.submittedAt).catch(() => undefined),
      record.finalizedAt ? blockTimeL1(record.finalizedAt).catch(() => undefined) : undefined,
    ]);
    const status = sameRoot === false ? "replaced" : record.status;
    return {
      index: i,
      status,
      final: status === "finalized",
      missing: undefined,
      root,
      sameRoot,
      submittedHeight: record.submittedAt,
      submittedTime: record.submittedTime || undefined,
      finalFrom: record.submittedTime && windowSec ? record.submittedTime + windowSec : undefined,
      finalizedHeight: record.finalizedAt || undefined,
      finalizedTime,
      tx,
      inboxStart: record.inboxStart,
      inboxEnd: record.inboxEnd,
      anchored: own.some((a) => lower(a.stateRoot) === root),
    };
  }
  // No record. Its own anchor (same transaction as the submission) still carries the root, block and time;
  // whether pruning explains the gap, and so whether the batch is final, is checked as for a receipt.
  const a = own.find((x) => !claimRoot || lower(x.stateRoot) === claimRoot) ?? own[0];
  const missing = await explainMissingBatch(rdk, ROLLUP, i, a, creator);
  const root = a ? lower(a.stateRoot) : undefined;
  return {
    index: i,
    status: missing.pruned ? "pruned" : "missing",
    final: missing.final,
    missing,
    root,
    sameRoot: root && claimRoot ? root === claimRoot : undefined,
    submittedHeight: a?.mainChainHeight,
    submittedTime: a?.anchoredAt || undefined,
    finalFrom: a?.anchoredAt && windowSec ? a.anchoredAt + windowSec : undefined,
    finalizedHeight: undefined,
    finalizedTime: undefined,
    tx: a ? await batchTx(rdk, i, a.mainChainHeight).catch(() => undefined) : undefined,
    inboxStart: undefined,
    inboxEnd: undefined,
    anchored: !!a,
  };
}

// ------------------------------------------------------------ the whole picture

interface VaultConfig {
  chainId: string;
  rollupId: string;
  evmChainId: number;
  members: Hex[];
  threshold: number;
  feeBps: number;
  lp: Hex;
}
let configPromise: Promise<VaultConfig> | undefined;

/** The vault's immutable settings, read once. */
function vaultConfig(v: Hex): Promise<VaultConfig> {
  configPromise ??= (async () => {
    const [chainId, rollupId, members, threshold, feeBps, lp, evmChainId] = await Promise.all([
      read<string>(v, "chainId"),
      read<string>(v, "rollupId"),
      read<readonly Hex[]>(v, "quorum"),
      read<bigint>(v, "threshold"),
      read<number>(v, "feeBps"),
      read<Hex>(v, "lp"),
      evmRpc<Hex>("eth_chainId", []),
    ]);
    return { chainId, rollupId, evmChainId: Number(evmChainId), members: [...members], threshold: Number(threshold), feeBps: Number(feeBps), lp };
  })();
  configPromise.catch(() => (configPromise = undefined));
  return configPromise;
}

async function member(v: Hex, address: Hex): Promise<Member> {
  const key = await twice(() => read<Hex>(v, "keyOf", [address])).catch(() => undefined);
  const qor1 = toQor1(address);
  const keyBytes = key ? (key.length - 2) / 2 : 0;
  return { address: getAddress(address), qor1, key, keyBytes, pin: key && keyBytes === ML_DSA_87_PUBKEY_LEN ? keyPin(qor1, key) : undefined };
}

const exitIdOf = (batchIndex: number, stateRoot: string, withdrawalIndex: number): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }, { type: "uint64" }], [BigInt(batchIndex), `0x${stateRoot}`, BigInt(withdrawalIndex)]));

export async function loadExits(limit = EXITS_PAGE): Promise<ExitsState> {
  const d = VAULT_DEPLOYMENT;
  if (!d) throw new Error("deployments/diana.json has no InstantExitVault");
  const v = getAddress(d.address);
  const vaultQor1 = toQor1(v);
  const { rdk } = await chain();

  const rollupP = rdk.rest.getRollup(ROLLUP);
  const anchorsP = rollupP.then((r) => rdk.rest.getAnchors(r.layerId)).catch(() => [] as AnchorView[]);
  const [cfg, rollup, inbox, scan, executed, bank, available, totalOwed] = await Promise.all([
    vaultConfig(v),
    rollupP,
    readInbox(rdk),
    vaultLogs(v, Number(d.block)),
    executedWithdrawals(rdk).catch(() => [] as Executed[]),
    bankFunding(rdk, vaultQor1).catch(() => [] as Funding[]),
    read<bigint>(v, "available"),
    read<bigint>(v, "totalOwed"),
  ]);
  const [members, lp] = await Promise.all([Promise.all(cfg.members.map((m) => member(v, m))), member(v, cfg.lp)]);
  const target: ExitTarget = { evmChainId: cfg.evmChainId, vault: v, chainId: cfg.chainId, rollupId: cfg.rollupId };
  const windowSec = rollup.challengeWindowSec;

  // ---- the vault's events
  const evm = async (l: RawLog): Promise<EvmEvent> => {
    const block = Number(l.blockNumber);
    const [time, rcpt] = await Promise.all([evmBlockTime(block).catch(() => 0), txReceipt(l.transactionHash).catch(() => undefined)]);
    return { tx: l.transactionHash, block, logIndex: Number(l.logIndex), time, from: rcpt?.from, gasUsed: rcpt?.gasUsed };
  };
  const fronts: FrontedView[] = [];
  const settles: SettledView[] = [];
  const funding: Funding[] = [...bank];
  const decode = (l: RawLog) => {
    try {
      return decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      return undefined; // not one of the vault's events
    }
  };
  await Promise.all(
    scan.logs.map(async (l) => {
      const ev = decode(l);
      if (!ev) return;
      if (ev.eventName === "Fronted") {
        const a = ev.args;
        fronts.push({ ...(await evm(l)), exitId: a.exitId, payout: getAddress(a.payout), batchIndex: Number(a.batchIndex), withdrawalIndex: Number(a.withdrawalIndex), paid: a.paid, fee: a.fee });
      } else if (ev.eventName === "Settled") {
        settles.push({ ...(await evm(l)), payout: getAddress(ev.args.payout), repaid: ev.args.repaid, stillOwed: ev.args.stillOwed });
      } else if (ev.eventName === "Deposited") {
        const e = await evm(l);
        funding.push({ tx: e.tx, height: e.block, time: e.time, from: toQor1(ev.args.from), wei: ev.args.amount, via: "EVM transfer" });
      } else if (ev.eventName === "LiquidityWithdrawn") {
        const e = await evm(l);
        funding.push({ tx: e.tx, height: e.block, time: e.time, from: toQor1(ev.args.to), wei: -ev.args.amount, via: "LP withdrawal" });
      }
    }),
  );
  const order = (x: EvmEvent, y: EvmEvent) => x.block - y.block || x.logIndex - y.logIndex;
  fronts.sort(order);
  settles.sort(order);
  funding.sort((x, y) => x.height - y.height);
  const repayments = attributeRepayments(
    fronts.map((f) => ({ id: lower(f.exitId), payout: f.payout, block: f.block, logIndex: f.logIndex, owed: f.paid + f.fee })),
    settles,
  );

  // ---- attestations: screened (poster, member, local ML-DSA-87), then grouped by exit and full claim.
  // A key that differs from the one pinned in the page is not used: its signatures stay unverified (and flagged).
  const quorumKeys = members.map((m) => {
    const usable = !!m.key && m.keyBytes === ML_DSA_87_PUBKEY_LEN && m.pin?.status !== "mismatch";
    return { address: lower(m.address).replace(/^0x/, ""), qor1: m.qor1, key: usable && m.key ? bytesOf(m.key) : undefined, ...(usable && m.pin ? { keyId: m.pin.sha256 } : {}) };
  });
  const screened = screenAttestations(inbox.entries, target, quorumKeys, localVerdicts);
  const groups = groupByExit(screened.accepted);

  type Candidate = { id: Hex; batchIndex: number; withdrawalIndex: number; headline?: AcceptedClaim<InboxEntry>[]; others: AcceptedClaim<InboxEntry>[]; claim?: ExitClaim };
  const candidates = new Map<string, Candidate>();
  for (const g of groups.values()) {
    const c = g.headline.claim;
    let id: Hex;
    try {
      id = exitIdOf(c.batchIndex, c.stateRoot, c.withdrawalIndex);
    } catch {
      continue; // unreachable for screened claims; never let one exit break the page
    }
    candidates.set(lower(id), { id, batchIndex: c.batchIndex, withdrawalIndex: c.withdrawalIndex, headline: g.headline.atts, others: g.others.flatMap((o) => o.atts), claim: c });
  }
  for (const f of fronts) {
    if (!candidates.has(lower(f.exitId))) candidates.set(lower(f.exitId), { id: f.exitId, batchIndex: f.batchIndex, withdrawalIndex: f.withdrawalIndex, others: [] });
  }
  const all = [...candidates.values()].sort((x, y) => y.batchIndex - x.batchIndex || y.withdrawalIndex - x.withdrawalIndex);

  const withdrawals = inbox.entries.flatMap((entry) => {
    try {
      const q = decodeQledgerTx(entry.payload);
      return q && q.kind === QLEDGER_KIND_WITHDRAW && q.recipient ? [{ entry, q }] : [];
    } catch {
      return [];
    }
  });
  const owedNow = new Map<Hex, Promise<bigint | undefined>>();
  const checks: Checks = { local: { verified: 0, unchecked: 0 }, pqc: { valid: 0, invalid: 0, unanswered: 0 }, keys: { match: 0, mismatch: 0, unread: 0 } };
  for (const m of [...members, lp]) {
    if (!m.pin) checks.keys.unread++;
    else if (m.pin.status === "mismatch") checks.keys.mismatch++;
    else if (m.pin.status === "match") checks.keys.match++;
  }

  const build = async (cand: Candidate): Promise<ExitView> => {
    const { id, claim } = cand;
    const fronted = fronts.find((f) => lower(f.exitId) === lower(id));
    const recipientQor1 = claim ? toQor1(`0x${claim.recipient}`) : fronted ? toQor1(exitAddressOf(v, fronted.payout)) : undefined;
    const batchP = batchInfo(rdk, cand.batchIndex, claim?.stateRoot, windowSec, anchorsP, rollup.creator).catch(() => undefined);
    const shown = [...(cand.headline ?? []), ...cand.others];
    const attsP = Promise.all(
      shown.map(async (a): Promise<AttestationView> => {
        const m = members[a.memberIndex]!;
        const sameClaim = !!claim && a.claim.amountUqor === claim.amountUqor && a.claim.recipient === claim.recipient && a.claim.deadline === claim.deadline;
        const pqc: SigCheck =
          m.keyBytes !== ML_DSA_87_PUBKEY_LEN || !m.key
            ? { valid: undefined, ms: 0, error: m.key === undefined ? "the member's key could not be read" : "the vault reports no usable ML-DSA-87 key for this member" }
            : await pqcVerify(m.key, a.signature, exitMessage(target, a.claim)).catch((e: unknown) => ({ valid: undefined, ms: 0, error: errText(e) }));
        return { member: m, memberIndex: a.memberIndex, entry: a.post, claim: a.claim, sameClaim, local: a.localValid, pqc };
      }),
    );
    const messageP =
      fronted && claim
        ? cached(messageChecks, `${id}:${fronted.payout}`, () =>
            read<Hex>(v, "exitMessage", [
              {
                batchIndex: BigInt(claim.batchIndex),
                stateRoot: `0x${claim.stateRoot}`,
                withdrawalIndex: BigInt(claim.withdrawalIndex),
                amountUqor: claim.amountUqor,
                payout: fronted.payout,
                deadline: BigInt(claim.deadline),
              },
            ]),
          )
            .then((onChain) => {
              const ours = toHex(exitMessage(target, claim));
              return { same: lower(onChain) === lower(ours), bytes: (ours.length - 2) / 2 };
            })
            .catch((e: unknown) => ({ error: errText(e) }))
        : Promise.resolve(undefined);
    const owedP = fronted ? cached(owedNow, fronted.payout, () => read<bigint>(v, "owed", [fronted.payout]).catch(() => undefined)) : Promise.resolve(undefined);
    const [batch, atts, messageCheck, owed] = await Promise.all([batchP, attsP, messageP, owedP]);
    for (const a of atts) {
      if (a.local) checks.local.verified++;
      else checks.local.unchecked++;
      if (a.pqc.valid === true) checks.pqc.valid++;
      else if (a.pqc.valid === false) checks.pqc.invalid++;
      else checks.pqc.unanswered++;
    }

    // The L2 withdrawal: in the batch's inbox range when the record says it, to the exit's recipient, for its amount.
    const amount = claim?.amountUqor ?? (fronted ? (fronted.paid + fronted.fee) / WEI_PER_UQOR : undefined);
    const firstAttestation = Math.min(...atts.map((a) => a.entry.sequence));
    const w =
      recipientQor1 && amount !== undefined
        ? withdrawals
            .filter(
              ({ entry, q }) =>
                q.recipient === recipientQor1 &&
                q.amount === amount &&
                (batch?.inboxStart !== undefined && batch.inboxEnd !== undefined ? entry.sequence > batch.inboxStart && entry.sequence <= batch.inboxEnd : entry.sequence < firstAttestation),
            )
            .at(-1)
        : undefined;
    const withdrawal: WithdrawalView | undefined = w && {
      entry: w.entry,
      amount: w.q.amount,
      recipient: w.q.recipient ?? "",
      account: bytesToHex(qledgerAccountId(w.q.publicKey, w.q.scheme)),
      signatureValid: verifyQledgerTx(w.q, CHAIN_ID, ROLLUP),
    };

    const attestations = atts.sort((x, y) => Number(y.sameClaim) - Number(x.sameClaim) || x.entry.sequence - y.entry.sequence);
    return {
      id,
      batchIndex: cand.batchIndex,
      withdrawalIndex: cand.withdrawalIndex,
      claim,
      recipientQor1,
      withdrawal,
      batch,
      attestations,
      validSigners: new Set(attestations.filter((a) => a.sameClaim && a.local === true && a.pqc.valid !== false).map((a) => a.memberIndex)).size,
      messageCheck,
      fronted,
      repayment: fronted ? repayments.get(lower(fronted.exitId)) : undefined,
      owedNow: owed,
      executed: matchExecuted(executed, { batchIndex: cand.batchIndex, withdrawalIndex: cand.withdrawalIndex, recipientQor1, amountUqor: amount, batch }),
    };
  };

  // Each exit is read on its own: one that fails shows its error, and the others are unaffected.
  const exits = await Promise.all(
    all.slice(0, limit).map((cand) =>
      build(cand).catch(
        (e: unknown): ExitView => ({
          id: cand.id,
          batchIndex: cand.batchIndex,
          withdrawalIndex: cand.withdrawalIndex,
          claim: cand.claim,
          recipientQor1: undefined,
          withdrawal: undefined,
          batch: undefined,
          attestations: [],
          validSigners: 0,
          messageCheck: undefined,
          fronted: undefined,
          repayment: undefined,
          owedNow: undefined,
          executed: undefined,
          error: errText(e),
        }),
      ),
    ),
  );

  const rejected = new Map<Rejection, { reason: Rejection; count: number; example: string }>();
  for (const r of screened.rejected) {
    const x = rejected.get(r.reason) ?? { reason: r.reason, count: 0, example: `entry #${r.post.sequence}: ${r.detail}` };
    x.count++;
    rejected.set(r.reason, x);
  }

  return {
    vault: {
      address: v,
      qor1: vaultQor1,
      deployTx: d.deployTx,
      deployBlock: Number(d.block),
      chainId: cfg.chainId,
      rollupId: cfg.rollupId,
      evmChainId: cfg.evmChainId,
      members,
      threshold: cfg.threshold,
      feeBps: cfg.feeBps,
      lp,
      lpIsCreator: lp.qor1 === rollup.creator,
      available,
      totalOwed,
      frontedCount: fronts.length,
      feesEarned: fronts.reduce((n, f) => n + f.fee, 0n),
      funding,
    },
    exits,
    totalExits: all.length,
    inbox: {
      head: inbox.head,
      read: inbox.entries.length,
      accumulatorOk: inbox.accumulatorOk,
      fetched: inbox.fetched,
      accepted: new Set(screened.accepted.map((a) => a.post.sequence)).size,
      rejected: [...rejected.values()],
    },
    checks,
    challengeWindowSec: windowSec,
    logs: scan.scan,
    loadedAt: Date.now(),
  };
}

// ------------------------------------------------------------ the exit-address tool

/** A payout given as qor1… or 0x… (or bare 40 hex), as a checksummed 0x address; or why not. */
export function parsePayout(input: string): { ok: true; address: Hex } | { ok: false; error: string } {
  const s = input.trim();
  if (!s) return { ok: false, error: "Enter a qor1… or 0x… address." };
  if (s.startsWith("qor1")) {
    if (!isCanonicalQorAddress(s)) return { ok: false, error: "That is not a valid qor1 account address (canonical, lowercase, 20 bytes)." };
    return { ok: true, address: getAddress(bech32ToHex(s)) };
  }
  return parseHexAddress(s);
}

export interface ExitAddress {
  payout: Hex;
  payoutQor1: string;
  exit: Hex;
  exitQor1: string;
  /** The vault's exitAddressOf() gave the same address (undefined: it could not be asked). */
  vaultAgrees: true | undefined;
  vaultError?: string;
  owed: bigint | undefined;
  holds: bigint | undefined;
}

/**
 * The exit address for `payout`, derived here from the pinned ExitAddress code and cross-checked with the
 * vault's own exitAddressOf(). Throws, showing neither, if the two disagree.
 */
export async function exitAddressFor(payout: Hex): Promise<ExitAddress> {
  const d = VAULT_DEPLOYMENT;
  if (!d) throw new Error("deployments/diana.json has no InstantExitVault");
  const v = getAddress(d.address);
  const local = exitAddressOf(v, payout);
  const [onChain, owed, holds] = await Promise.all([
    read<Hex>(v, "exitAddressOf", [payout]).then(
      (a) => ({ a }),
      (e: unknown) => ({ e: errText(e) }),
    ),
    read<bigint>(v, "owed", [payout]).catch(() => undefined),
    evmRpc<Hex>("eth_getBalance", [local, "latest"])
      .then((h) => BigInt(h))
      .catch(() => undefined),
  ]);
  if ("a" in onChain && getAddress(onChain.a) !== local) {
    throw new Error(`the vault's exitAddressOf() answered ${getAddress(onChain.a)}, but this page derives ${local} from the pinned ExitAddress code. They must agree, so neither is shown.`);
  }
  return {
    payout,
    payoutQor1: toQor1(payout),
    exit: local,
    exitQor1: toQor1(local),
    vaultAgrees: "a" in onChain ? true : undefined,
    ...("e" in onChain ? { vaultError: onChain.e } : {}),
    owed,
    holds,
  };
}

/** Wei as QOR, every significant digit kept. */
export function qorWei(wei: bigint): string {
  const neg = wei < 0n;
  const n = neg ? -wei : wei;
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} QOR`;
}
