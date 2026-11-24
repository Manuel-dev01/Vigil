/**
 * Instant exits on vigil-pay-1, read from the chain at runtime.
 *
 * The InstantExitVault (contracts/src/InstantExitVault.sol) lives on QoreChain's EVM lane; it is read
 * with free eth_calls and its history with eth_getLogs. The watchtowers' attestations are inbox entries
 * of the rollup, read back over the node's websocket and checked against the chain's inbox accumulator.
 * Every attestation signature is checked by the chain's own pqcVerify precompile (a free eth_call)
 * against the key the vault itself reads for that member through pqcKeyStatus.
 *
 * The exit message and attestation layouts are copied from packages/qledger-watchtower/src/exits.ts,
 * which the page cannot import (it pulls in the full SDK). For every fronted exit the page compares its
 * copy of the message with the vault's own exitMessage(), byte for byte.
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
import { CHAIN_ID, KNOWN, ROLLUP, chain, rpc } from "./chain.ts";
import { ethCall, evmRpc } from "./evm.ts";

// ------------------------------------------------------------ the watchtower's formats (pure)

export const EXIT_DOMAIN = "vigil/instant-exit/v1/exit";
export const ATTEST_MAGIC = "vigil/instant-exit/v1/attest";
export const ML_DSA_87_SIG_LEN = 4627;
export const ML_DSA_87_PUBKEY_LEN = 2592;

export interface ExitTarget {
  /** EVM chain id (9800 on qorechain-diana). */
  evmChainId: number;
  /** The InstantExitVault address, 0x-prefixed. */
  vault: string;
  chainId: string;
  rollupId: string;
}

export interface ExitClaim {
  batchIndex: number;
  /** The batch's state root, 64 hex. */
  stateRoot: string;
  withdrawalIndex: number;
  amountUqor: bigint;
  /** The withdrawal's recipient, 20 bytes as 40 hex (no 0x). */
  recipient: string;
  /** Unix seconds after which the vault refuses to front it. */
  deadline: number;
}

export interface SignedClaim {
  claim: ExitClaim;
  signature: Uint8Array;
}

export interface Attestation {
  /** 0x-prefixed. */
  vault: string;
  /** The signing member's 20-byte address, 40 hex (no 0x). */
  member: string;
  claims: SignedClaim[];
}

const enc = new TextEncoder();
const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

function u64(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}

function fixedHex(h: string, bytes: number, what: string): Uint8Array {
  const s = norm(h);
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s)) throw new Error(`${what} must be ${bytes} bytes of hex`);
  return hexToBytes(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The bytes a quorum member signs for `c`; equal to InstantExitVault.exitMessage:
 *   "vigil/instant-exit/v1/exit" | u64be evmChainId | vault (20) | u64be len | chainId | u64be len | rollupId
 *   | u64be batchIndex | stateRoot (32) | u64be withdrawalIndex | u64be amountUqor | recipient (20) | u64be deadline
 */
export function exitMessage(t: ExitTarget, c: ExitClaim): Uint8Array {
  const chainId = enc.encode(t.chainId);
  const rollup = enc.encode(t.rollupId);
  return concat([
    enc.encode(EXIT_DOMAIN),
    u64(t.evmChainId),
    fixedHex(t.vault, 20, "vault"),
    u64(chainId.length),
    chainId,
    u64(rollup.length),
    rollup,
    u64(c.batchIndex),
    fixedHex(c.stateRoot, 32, "stateRoot"),
    u64(c.withdrawalIndex),
    u64(c.amountUqor),
    fixedHex(c.recipient, 20, "recipient"),
    u64(c.deadline),
  ]);
}

const CLAIM_LEN = 8 + 32 + 8 + 8 + 20 + 8 + ML_DSA_87_SIG_LEN;

/**
 * Parse an inbox payload; undefined if it is not an exit attestation (most entries are not):
 *   ATTEST_MAGIC | vault (20) | member (20) | u16be n | n × (u64 batchIndex | stateRoot 32 | u64 withdrawalIndex
 *   | u64 amountUqor | recipient 20 | u64 deadline | signature 4627)
 */
export function decodeAttestation(bytes: Uint8Array): Attestation | undefined {
  const magic = enc.encode(ATTEST_MAGIC);
  const head = magic.length + 20 + 20 + 2;
  if (bytes.length < head + CLAIM_LEN) return undefined;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = magic.length;
  const vault = `0x${bytesToHex(bytes.subarray(o, o + 20))}`;
  o += 20;
  const member = bytesToHex(bytes.subarray(o, o + 20));
  o += 20;
  const n = dv.getUint16(o);
  o += 2;
  if (bytes.length !== head + n * CLAIM_LEN) return undefined;
  const claims: SignedClaim[] = [];
  for (let k = 0; k < n; k++) {
    const batchIndex = Number(dv.getBigUint64(o));
    const stateRoot = bytesToHex(bytes.subarray(o + 8, o + 40));
    const withdrawalIndex = Number(dv.getBigUint64(o + 40));
    const amountUqor = dv.getBigUint64(o + 48);
    const recipient = bytesToHex(bytes.subarray(o + 56, o + 76));
    const deadline = Number(dv.getBigUint64(o + 76));
    const signature = bytes.slice(o + 84, o + 84 + ML_DSA_87_SIG_LEN);
    claims.push({ claim: { batchIndex, stateRoot, withdrawalIndex, amountUqor, recipient, deadline }, signature });
    o += CLAIM_LEN;
  }
  return { vault, member, claims };
}

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
/** 1 uqor (the rollup's withdrawal unit) is 10^12 wei of the same balance on the EVM side. */
export const WEI_PER_UQOR = 1_000_000_000_000n;

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
  /** Whether this member signed the same claim (amount, recipient, deadline) as the one shown. */
  sameClaim: boolean;
  check: SigCheck;
}

export interface BatchInfo {
  index: number;
  /** The chain's status, or "pruned" when the record is gone (finalized records are deleted after ~7 days). */
  status: string;
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
  validSigners: number;
  /** The page's exit message against the vault's exitMessage() for the fronted payout. */
  messageCheck: { same: boolean; bytes: number } | { error: string } | undefined;
  fronted: FrontedView | undefined;
  settlements: SettledView[];
  /** A Settled event after the front left the payout owing nothing. */
  repaid: boolean;
  owedNow: bigint | undefined;
  executed: ExecutedView | undefined;
}

export interface ExitsState {
  vault: VaultState;
  exits: ExitView[];
  inbox: { head: number; read: number; accumulatorOk: boolean | undefined; attestations: number };
  challengeWindowSec: number | undefined;
  logs: { from: number; to: number; requests: number };
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

/** Logs already read: the vault's history only grows, so each refresh scans only the new blocks. */
const logScan = { next: 0, logs: new Map<string, RawLog>() };

async function vaultLogs(vault: Hex, deployBlock: number): Promise<{ logs: RawLog[]; to: number }> {
  const latest = Number(await evmRpc<Hex>("eth_blockNumber", []));
  const from = Math.max(logScan.next, deployBlock);
  const ranges: [number, number][] = [];
  for (let a = from; a <= latest; a += LOG_SPAN + 1) ranges.push([a, Math.min(a + LOG_SPAN, latest)]);
  const out: RawLog[][] = [];
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < ranges.length) {
      const k = i++;
      const [a, b] = ranges[k]!;
      out[k] = await twice(() => evmRpc<RawLog[]>("eth_getLogs", [{ address: vault, fromBlock: toHex(a), toBlock: toHex(b) }]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOG_CONCURRENCY, ranges.length) }, worker));
  for (const chunk of out) for (const l of chunk ?? []) logScan.logs.set(`${l.transactionHash}:${l.logIndex}`, l);
  // Rescan the last few blocks next time, in case the endpoint had not indexed them yet.
  logScan.next = Math.max(from, latest - 4);
  const logs = [...logScan.logs.values()].sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || Number(x.logIndex) - Number(y.logIndex));
  return { logs, to: latest };
}

const blockTimes = new Map<number, Promise<number>>();
const evmBlockTime = (n: number): Promise<number> =>
  cached(blockTimes, n, async () => Number((await evmRpc<{ timestamp: Hex }>("eth_getBlockByNumber", [toHex(n), false])).timestamp));

const senders = new Map<string, Promise<Hex | undefined>>();
const txSender = (hash: Hex): Promise<Hex | undefined> =>
  cached(senders, hash, async () => (await evmRpc<{ from?: Hex } | null>("eth_getTransactionByHash", [hash]))?.from);

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
const uqor = (s: string | undefined): bigint => BigInt((s ?? "0").replace(/uqor$/, "") || "0");

/**
 * Every inbox entry of the rollup, from the transactions that posted them, and whether together they
 * reproduce the chain's inbox accumulator at the head (so none is missing, changed or out of order).
 */
async function readInbox(rdk: RdkClient): Promise<{ entries: InboxEntry[]; head: number; accumulatorOk: boolean | undefined }> {
  const inbox = await rdk.rest.getInbox(ROLLUP);
  const head = Number(inbox.headSequence);
  const [posts, deposits] = await Promise.all([search(rdk, `rdk_data_posted.rollup_id='${ROLLUP}'`), search(rdk, `rdk_rollup_deposit.rollup_id='${ROLLUP}'`)]);
  const bySeq = new Map<number, InboxEntry>();
  for (const t of posts) {
    const msgs = (t.tx?.body?.messages ?? []).filter((m) => m["@type"] === "/qorechain.rdk.v1.MsgPostRollupData");
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_data_posted") continue;
      const a = attrs(ev);
      const seq = Number(a["sequence"] ?? 0);
      if (a["rollup_id"] !== ROLLUP || seq < 1 || seq > head) continue;
      const m = msgs.find((x) => String(x["poster"]) === a["poster"] && bytesToHex(postedDataHash(base64ToBytes(String(x["data"] ?? "")))) === lower(a["data_hash"] ?? ""));
      if (!m) continue;
      bySeq.set(seq, { sequence: seq, height: Number(t.height ?? 0), time: unix(t.timestamp), tx: t.txhash ?? "", poster: a["poster"] ?? "", payload: base64ToBytes(String(m["data"])) });
    }
  }
  for (const t of deposits) {
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_rollup_deposit") continue;
      const a = attrs(ev);
      const seq = Number(a["sequence"] ?? 0);
      if (a["rollup_id"] !== ROLLUP || seq < 1 || seq > head) continue;
      bySeq.set(seq, {
        sequence: seq,
        height: Number(t.height ?? 0),
        time: unix(t.timestamp),
        tx: t.txhash ?? "",
        poster: QLEDGER_DEPOSIT_POSTER_PREFIX + (a["depositor"] ?? ""),
        payload: encodeQledgerDeposit(hexToBytes(a["account"] ?? ""), uqor(a["amount"])),
      });
    }
  }
  const entries = [...bySeq.values()].sort((x, y) => x.sequence - y.sequence);
  let accumulatorOk: boolean | undefined;
  if (entries.length === head && head > 0) {
    const acc = qledgerAccumulate({ chainId: CHAIN_ID, rollupId: ROLLUP, from: 0, accFrom: EMPTY_INBOX_ACC, entries });
    accumulatorOk = bytesToHex(acc) === bytesToHex(decodeWireBytes(inbox.headAcc));
  }
  return { entries, head, accumulatorOk };
}

/** Withdrawals the chain has paid on L1 (MsgExecuteWithdrawal), from the rdk_withdrawal_executed event. */
async function executedWithdrawals(rdk: RdkClient): Promise<(ExecutedView & { batchIndex: number; withdrawalIndex: number })[]> {
  const out: (ExecutedView & { batchIndex: number; withdrawalIndex: number })[] = [];
  for (const t of await search(rdk, `rdk_withdrawal_executed.rollup_id='${ROLLUP}'`)) {
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_withdrawal_executed") continue;
      const a = attrs(ev);
      if (a["rollup_id"] !== ROLLUP) continue;
      const msg = (t.tx?.body?.messages ?? []).find(
        (m) => m["@type"] === "/qorechain.rdk.v1.MsgExecuteWithdrawal" && String(m["batch_index"]) === a["batch_index"] && String(m["withdrawal_index"]) === a["withdrawal_index"],
      );
      out.push({
        batchIndex: Number(a["batch_index"]),
        withdrawalIndex: Number(a["withdrawal_index"]),
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
      const u = coins.filter((c) => c.denom === "uqor").reduce((n, c) => n + BigInt(c.amount), 0n);
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

async function batchInfo(rdk: RdkClient, i: number, claimRoot: string | undefined, windowSec: number | undefined, anchors: Promise<AnchorView[]>): Promise<BatchInfo> {
  let record: BatchView | undefined;
  try {
    record = await rdk.rest.getBatch(ROLLUP, i);
  } catch (e) {
    // The chain deletes a finalized batch's record after its retention window (about 7 days): a 404 means pruned.
    if ((e as { status?: unknown }).status !== 404) throw e;
  }
  const own = (await anchors).filter((a) => a.layerHeight === i);
  if (record) {
    const root = bytesToHex(decodeWireBytes(record.stateRoot));
    const [tx, finalizedTime] = await Promise.all([
      batchTx(rdk, i, record.submittedAt).catch(() => undefined),
      record.finalizedAt ? blockTimeL1(record.finalizedAt).catch(() => undefined) : undefined,
    ]);
    return {
      index: i,
      status: record.status,
      root,
      sameRoot: claimRoot ? root === claimRoot : undefined,
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
  // Pruned: its anchor (same transaction as the submission) still carries the root, block and time.
  const a = own.find((x) => !claimRoot || lower(x.stateRoot) === claimRoot) ?? own[0];
  const root = a ? lower(a.stateRoot) : undefined;
  return {
    index: i,
    status: "pruned",
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
  const key = await read<Hex>(v, "keyOf", [address]).catch(() => undefined);
  return { address: getAddress(address), qor1: toQor1(address), key, keyBytes: key ? (key.length - 2) / 2 : 0 };
}

const exitIdOf = (batchIndex: number, stateRoot: string, withdrawalIndex: number): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }, { type: "uint64" }], [BigInt(batchIndex), `0x${stateRoot}`, BigInt(withdrawalIndex)]));

export async function loadExits(): Promise<ExitsState> {
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
    executedWithdrawals(rdk),
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
    const [time, from] = await Promise.all([evmBlockTime(block), txSender(l.transactionHash).catch(() => undefined)]);
    return { tx: l.transactionHash, block, logIndex: Number(l.logIndex), time, from };
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

  // ---- attestations in the inbox, grouped by exit (batch, state root, withdrawal index)
  const groups = new Map<string, { claim: ExitClaim; atts: { memberIndex: number; entry: InboxEntry; s: SignedClaim }[] }>();
  let attestations = 0;
  for (const entry of inbox.entries) {
    const a = decodeAttestation(entry.payload);
    if (!a || lower(a.vault) !== lower(v)) continue;
    const memberIndex = members.findIndex((m) => norm(m.address) === a.member);
    if (memberIndex < 0) continue;
    attestations++;
    for (const s of a.claims) {
      const k = `${s.claim.batchIndex}:${s.claim.stateRoot}:${s.claim.withdrawalIndex}`;
      const g = groups.get(k) ?? { claim: s.claim, atts: [] };
      if (!g.atts.some((x) => x.memberIndex === memberIndex)) g.atts.push({ memberIndex, entry, s });
      groups.set(k, g);
    }
  }
  const byId = new Map<Hex, { claim: ExitClaim | undefined; atts: { memberIndex: number; entry: InboxEntry; s: SignedClaim }[]; batchIndex: number; withdrawalIndex: number }>();
  for (const g of groups.values()) {
    byId.set(exitIdOf(g.claim.batchIndex, g.claim.stateRoot, g.claim.withdrawalIndex), { ...g, batchIndex: g.claim.batchIndex, withdrawalIndex: g.claim.withdrawalIndex });
  }
  for (const f of fronts) if (!byId.has(f.exitId)) byId.set(f.exitId, { claim: undefined, atts: [], batchIndex: f.batchIndex, withdrawalIndex: f.withdrawalIndex });

  const withdrawals = inbox.entries.flatMap((entry) => {
    const q = decodeQledgerTx(entry.payload);
    return q && q.kind === QLEDGER_KIND_WITHDRAW && q.recipient ? [{ entry, q }] : [];
  });
  const owedNow = new Map<Hex, Promise<bigint | undefined>>();

  const exits = await Promise.all(
    [...byId.entries()].map(async ([id, g]): Promise<ExitView> => {
      const claim = g.claim;
      const recipientQor1 = claim ? toQor1(`0x${claim.recipient}`) : undefined;
      const fronted = fronts.find((f) => lower(f.exitId) === lower(id));

      const batchP = batchInfo(rdk, g.batchIndex, claim?.stateRoot, windowSec, anchorsP).catch(() => undefined);
      const attsP = Promise.all(
        g.atts.map(async ({ memberIndex, entry, s }): Promise<AttestationView> => {
          const m = members[memberIndex]!;
          const sameClaim = !!claim && s.claim.amountUqor === claim.amountUqor && s.claim.recipient === claim.recipient && s.claim.deadline === claim.deadline;
          const check: SigCheck =
            m.keyBytes !== ML_DSA_87_PUBKEY_LEN || !m.key
              ? { valid: undefined, ms: 0, error: m.key === undefined ? "the member's key could not be read" : "the vault reports no usable ML-DSA-87 key for this member" }
              : await pqcVerify(m.key, s.signature, exitMessage(target, s.claim)).catch((e: unknown) => ({ valid: undefined, ms: 0, error: String(e instanceof Error ? e.message : e) }));
          return { member: m, memberIndex, entry, claim: s.claim, sameClaim, check };
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
              .catch((e: unknown) => ({ error: String(e instanceof Error ? e.message : e) }))
          : Promise.resolve(undefined);
      const owedP = fronted ? cached(owedNow, fronted.payout, () => read<bigint>(v, "owed", [fronted.payout]).catch(() => undefined)) : Promise.resolve(undefined);
      const [batch, atts, messageCheck, owed] = await Promise.all([batchP, attsP, messageP, owedP]);

      // The L2 withdrawal: in the batch's inbox range when the record says it, to the claim's recipient, for its amount.
      const firstAttestation = Math.min(...atts.map((a) => a.entry.sequence));
      const w = claim
        ? withdrawals
            .filter(
              ({ entry, q }) =>
                q.recipient === recipientQor1 &&
                q.amount === claim.amountUqor &&
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

      const settlements = fronted ? settles.filter((s) => s.payout === fronted.payout && order(s, fronted) > 0) : [];
      return {
        id,
        batchIndex: g.batchIndex,
        withdrawalIndex: g.withdrawalIndex,
        claim,
        recipientQor1,
        withdrawal,
        batch,
        attestations: atts.sort((x, y) => x.entry.sequence - y.entry.sequence),
        validSigners: atts.filter((a) => a.check.valid === true && a.sameClaim).length,
        messageCheck,
        fronted,
        settlements,
        repaid: settlements.some((s) => s.stillOwed === 0n),
        owedNow: owed,
        executed: executed.find((x) => x.batchIndex === g.batchIndex && x.withdrawalIndex === g.withdrawalIndex),
      };
    }),
  );
  exits.sort((x, y) => y.batchIndex - x.batchIndex || y.withdrawalIndex - x.withdrawalIndex);

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
    inbox: { head: inbox.head, read: inbox.entries.length, accumulatorOk: inbox.accumulatorOk, attestations },
    challengeWindowSec: windowSec,
    logs: { from: Number(d.block), to: scan.to, requests: Math.ceil((scan.to - Number(d.block) + 1) / (LOG_SPAN + 1)) },
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
  const h = s.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{40}$/.test(h)) return { ok: false, error: "That is not a 20-byte hex address (0x and 40 hex digits)." };
  return { ok: true, address: getAddress(`0x${h.toLowerCase()}`) };
}

export interface ExitAddress {
  payout: Hex;
  payoutQor1: string;
  exit: Hex;
  exitQor1: string;
  owed: bigint;
  holds: bigint;
}

export async function exitAddressFor(payout: Hex): Promise<ExitAddress> {
  const d = VAULT_DEPLOYMENT;
  if (!d) throw new Error("deployments/diana.json has no InstantExitVault");
  const v = getAddress(d.address);
  const [exit, owed] = await Promise.all([read<Hex>(v, "exitAddressOf", [payout]), read<bigint>(v, "owed", [payout])]);
  const holds = BigInt(await evmRpc<Hex>("eth_getBalance", [exit, "latest"]));
  return { payout, payoutQor1: toQor1(payout), exit: getAddress(exit), exitQor1: toQor1(exit), owed, holds };
}

/** Wei as QOR, every significant digit kept. */
export function qorWei(wei: bigint): string {
  const neg = wei < 0n;
  const n = neg ? -wei : wei;
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} QOR`;
}
