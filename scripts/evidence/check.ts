/**
 * Judge one EVIDENCE row against what the node returned for its transaction. Pure: no network.
 */
import { decodeEventLog, parseAbi, type Hex } from "viem";
import type { EventClaim, LogClaim, RowExpect } from "./expect.ts";
import type { Fetched } from "./fetch.ts";
import type { TxRow } from "./ledger.ts";

export type Status = "verified" | "mismatch" | "not found" | "error";

export interface Check {
  what: string;
  ok: boolean;
  expected?: string;
  actual?: string;
}

export interface RowResult {
  n: number;
  kind: TxRow["kind"];
  hash: string;
  status: Status;
  /** False when expect.ts lists nothing for this row, so only the generic checks ran. */
  claimsListed: boolean;
  checks: Check[];
  /** Why the row could not be judged (not found, or the request failed). */
  note?: string;
}

/** The events of Vigil's contracts that EVIDENCE rows cite (see contracts/src). */
export const EVENTS_ABI = parseAbi([
  "event Attested(uint64 indexed layerHeight, bytes32 indexed stateRoot, address indexed by)",
  "event Fronted(bytes32 indexed exitId, address indexed payout, uint64 batchIndex, uint64 withdrawalIndex, uint256 paid, uint256 fee)",
  "event Settled(address indexed payout, uint256 repaid, uint256 stillOwed)",
  "event Probe(uint256 number, uint256[] depths, bytes32[] hashes, bool historyCallOk, bytes historyReturn)",
]);

// ------------------------------------------------------------------ value matching

/**
 * Match a value as the ledger writes it. `abcd1234…wxyz` (the ledger's abbreviation) matches any
 * value with that start and end; anything else must be equal.
 */
export function matchesAbbrev(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const i = expected.indexOf("…");
  if (i < 0) return expected === actual;
  const head = expected.slice(0, i);
  const tail = expected.slice(i + 1);
  return actual.length >= head.length + tail.length && actual.startsWith(head) && actual.endsWith(tail);
}

// ------------------------------------------------------------------ native transactions

interface Attr {
  key: string;
  value: string;
}
interface TxEvent {
  type: string;
  attributes: Attr[];
}
interface TxResponse {
  height: string;
  code: number;
  codespace?: string;
  raw_log?: string;
  timestamp: string;
  gas_used: string;
  gas_wanted: string;
  events: TxEvent[];
}
interface NativeBody {
  tx?: { body?: { messages?: { "@type": string }[] }; auth_info?: { fee?: { amount?: { denom: string; amount: string }[] } } };
  tx_response?: TxResponse;
}

const describeAttrs = (attrs: Record<string, string | null> = {}) =>
  Object.entries(attrs)
    .map(([k, v]) => (v === null ? `no ${k}` : `${k}=${v}`))
    .join(", ");

function eventMatches(e: TxEvent, attrs: Record<string, string | null> = {}): boolean {
  return Object.entries(attrs).every(([k, v]) => {
    const a = e.attributes.find((x) => x.key === k);
    return v === null ? a === undefined : matchesAbbrev(v, a?.value);
  });
}

export function checkEvent(events: TxEvent[], claim: EventClaim): Check {
  const same = events.filter((e) => e.type === claim.type);
  if (claim.absent) {
    return { what: `no ${claim.type} event`, ok: same.length === 0, ...(same.length ? { actual: `${same.length} found` } : {}) };
  }
  const what = `event ${claim.type}`;
  const expected = describeAttrs(claim.attrs) || "present";
  if (same.some((e) => eventMatches(e, claim.attrs))) return { what, ok: true, expected };
  const keys = Object.keys(claim.attrs ?? {});
  const actual =
    same.length === 0
      ? "no such event"
      : same
          .map((e) => keys.map((k) => `${k}=${e.attributes.find((a) => a.key === k)?.value ?? "(absent)"}`).join(", "))
          .join(" | ");
  return { what, ok: false, expected, actual };
}

const msgName = (t: string) => t.slice(t.lastIndexOf(".") + 1);

function judgeNative(row: TxRow, x: RowExpect, body: NativeBody): Check[] {
  const t = body.tx_response;
  if (!t) return [{ what: "transaction", ok: false, expected: "a tx_response", actual: "none in the answer" }];
  const checks: Check[] = [];
  const eq = (what: string, expected: string | number, actual: string | number | undefined) => {
    const ok = String(expected) === String(actual);
    checks.push({ what, ok, expected: String(expected), ...(ok ? {} : { actual: String(actual ?? "(none)") }) });
  };

  eq("height", row.height, Number(t.height));
  eq("date (UTC)", row.date, t.timestamp?.slice(0, 10));
  if (x.failure) {
    eq("result", `failed, ${x.failure.codespace} code ${x.failure.code}`, `${t.code === 0 ? "succeeded" : "failed"}, ${t.codespace || "sdk"} code ${t.code}`);
    if (x.failure.rawLog) {
      const ok = (t.raw_log ?? "").includes(x.failure.rawLog);
      checks.push({ what: "log", ok, expected: `contains "${x.failure.rawLog}"`, ...(ok ? {} : { actual: t.raw_log ?? "(none)" }) });
    }
  } else {
    eq("result", "succeeded (code 0)", t.code === 0 ? "succeeded (code 0)" : `failed, ${t.codespace || "sdk"} code ${t.code}`);
  }
  if (x.msgs) eq("messages", x.msgs.join(", "), (body.tx?.body?.messages ?? []).map((m) => msgName(m["@type"])).join(", "));
  if (x.gasUsed !== undefined) eq("gas used", x.gasUsed, Number(t.gas_used));
  if (x.gasWanted !== undefined) eq("gas limit", x.gasWanted, Number(t.gas_wanted));
  if (x.feeUqor !== undefined) {
    const fee = body.tx?.auth_info?.fee?.amount?.find((c) => c.denom === "uqor")?.amount;
    eq("fee (uqor)", x.feeUqor, fee === undefined ? undefined : Number(fee));
  }
  for (const c of x.events ?? []) checks.push(checkEvent(t.events ?? [], c));
  return checks;
}

// ------------------------------------------------------------------ EVM transactions

interface EvmLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockTimestamp?: Hex;
}
interface EvmReceipt {
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
  from: string;
  contractAddress: string | null;
  logs: EvmLog[];
}

type Decoded = { address: string; eventName: string; args: Record<string, unknown> };

function decodeLogs(logs: EvmLog[]): Decoded[] {
  const out: Decoded[] = [];
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: EVENTS_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
      out.push({ address: l.address.toLowerCase(), eventName: d.eventName, args: d.args as unknown as Record<string, unknown> });
    } catch {
      // a log from some other contract or event: not one a claim names
    }
  }
  return out;
}

const showArg = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));
const describeLog = (c: LogClaim) => {
  const args = Object.entries(c.args ?? {}).map(([k, v]) => `${k}=${showArg(v)}`);
  return `${c.event}${args.length ? `(${args.join(", ")})` : ""}${c.test ? `: ${c.test.says}` : ""}`;
};

function argMatches(expected: bigint | string, actual: unknown): boolean {
  if (typeof expected === "bigint") return typeof actual === "bigint" && actual === expected;
  return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
}

export function checkLog(decoded: Decoded[], claim: LogClaim): Check {
  const what = `log ${claim.event} from ${claim.address}`;
  const expected = describeLog(claim);
  const same = decoded.filter((d) => d.eventName === claim.event && d.address === claim.address.toLowerCase());
  const ok = same.some(
    (d) => Object.entries(claim.args ?? {}).every(([k, v]) => argMatches(v, d.args[k])) && (claim.test ? claim.test.ok(d.args) : true),
  );
  if (ok) return { what, ok, expected };
  const actual =
    same.length === 0
      ? "no such log"
      : same.map((d) => Object.keys(claim.args ?? {}).map((k) => `${k}=${showArg(d.args[k])}`).join(", ") || "different values").join(" | ");
  return { what, ok: false, expected, actual };
}

function judgeEvm(row: TxRow, x: RowExpect, r: EvmReceipt): Check[] {
  const checks: Check[] = [];
  const eq = (what: string, expected: string | number, actual: string | number | undefined) => {
    const ok = String(expected) === String(actual);
    checks.push({ what, ok, expected: String(expected), ...(ok ? {} : { actual: String(actual ?? "(none)") }) });
  };
  eq("height", row.height, Number(BigInt(r.blockNumber)));
  // This endpoint's receipts carry the block's time only in their logs (`blockTimestamp`).
  const ts = r.logs.find((l) => l.blockTimestamp)?.blockTimestamp;
  if (ts) eq("date (UTC)", row.date, new Date(Number(BigInt(ts)) * 1000).toISOString().slice(0, 10));
  eq("result", "succeeded (status 1)", r.status === "0x1" ? "succeeded (status 1)" : `reverted (status ${r.status})`);
  if (x.contract) eq("contract created", x.contract.toLowerCase(), r.contractAddress?.toLowerCase());
  if (x.from) eq("sender", x.from.toLowerCase(), r.from.toLowerCase());
  if (x.gasUsed !== undefined) eq("gas used", x.gasUsed, Number(BigInt(r.gasUsed)));
  const decoded = decodeLogs(r.logs);
  for (const c of x.logs ?? []) checks.push(checkLog(decoded, c));
  return checks;
}

// ------------------------------------------------------------------ one row

const isTransient = (f: Fetched) => f.httpStatus === 0 || f.httpStatus === 429 || f.httpStatus >= 500;
const brief = (body: unknown) => (typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200);

export function judgeRow(row: TxRow, expect: RowExpect | undefined, f: Fetched): RowResult {
  const base = { n: row.n, kind: row.kind, hash: row.hash, claimsListed: expect !== undefined };
  const x = expect ?? {};
  if (isTransient(f)) return { ...base, status: "error", checks: [], note: `HTTP ${f.httpStatus || "error"}: ${brief(f.body)}` };

  if (row.kind === "native") {
    const body = f.body as NativeBody & { code?: number; message?: string };
    const message = typeof f.body === "string" ? f.body : (body?.message ?? "");
    if (f.httpStatus === 404 || (f.httpStatus !== 200 && /not found/i.test(message))) {
      return { ...base, status: "not found", checks: [], note: "the node does not return this transaction (it may no longer index it)" };
    }
    if (f.httpStatus !== 200 || !body?.tx_response) {
      return { ...base, status: "error", checks: [], note: `HTTP ${f.httpStatus}: ${brief(f.body)}` };
    }
    const checks = judgeNative(row, x, body);
    return { ...base, status: checks.every((c) => c.ok) ? "verified" : "mismatch", checks };
  }

  const rpc = f.body as { result?: EvmReceipt | null; error?: { message?: string } };
  if (f.httpStatus !== 200 || rpc?.error || rpc?.result === undefined) {
    return { ...base, status: "error", checks: [], note: `HTTP ${f.httpStatus}: ${brief(rpc?.error ?? f.body)}` };
  }
  if (rpc.result === null) {
    return { ...base, status: "not found", checks: [], note: "the EVM endpoint returns no receipt for this transaction" };
  }
  const checks = judgeEvm(row, x, rpc.result);
  return { ...base, status: checks.every((c) => c.ok) ? "verified" : "mismatch", checks };
}
