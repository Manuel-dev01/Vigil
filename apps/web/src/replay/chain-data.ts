/**
 * What the browser watchtower reads, parsed from the node's answers: batch submissions, upheld fraud
 * proofs and paid withdrawals from transaction searches, and the repository's inbox archive. Pure, so
 * the tests run it on recorded answers. Every value here is as the node reports it; the replay
 * (core.ts) decides what it proves.
 */
import { EMPTY_INBOX_ACC, bytesToHex, hexToBytes, qledgerAccumulate } from "@qorechain/rdk";
import type { Entry, ExecutedLite, FraudLite, RollupEnv, Submission } from "./core.ts";
import { wireHex } from "./hex.ts";

/** One `tx_responses` item, in the shape the REST gateway (and `restOverWs`) returns. */
export interface TxResponse {
  txhash?: string;
  height?: string;
  code?: number;
  tx?: { body?: { messages?: Record<string, unknown>[] } } | null;
  events?: { type: string; attributes?: { key: string; value: string }[] }[];
}

const attrs = (ev: { attributes?: { key: string; value: string }[] }): Record<string, string> =>
  Object.fromEntries((ev.attributes ?? []).map((a) => [a.key, a.value]));

/** A non-negative safe integer from a chain string, or undefined. */
const int = (s: unknown): number | undefined => {
  const n = typeof s === "number" ? s : /^\d+$/.test(String(s ?? "")) ? Number(s) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
const uqor = (s: string | undefined): bigint | undefined => {
  const t = (s ?? "").replace(/uqor$/, "");
  return /^\d+$/.test(t) ? BigInt(t) : undefined;
};

/**
 * Every batch `rollupId` received in these transactions, as its `MsgSubmitBatch` published it. The
 * inbox start comes from the chain's `rdk_inbox_consumed` event in the same transaction. Failed
 * transactions and messages for other rollups are skipped.
 */
export function submissionsFrom(txs: TxResponse[], rollupId: string): Submission[] {
  const out: Submission[] = [];
  for (const t of txs) {
    if ((t.code ?? 0) !== 0) continue;
    const height = int(t.height);
    if (height === undefined) continue;
    const starts = new Map<number, number>();
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_inbox_consumed") continue;
      const a = attrs(ev);
      const i = int(a["batch_index"]);
      const s = int(a["inbox_start"]);
      if (a["rollup_id"] === rollupId && i !== undefined && s !== undefined) starts.set(i, s);
    }
    for (const m of t.tx?.body?.messages ?? []) {
      if (m["@type"] !== "/qorechain.rdk.v1.MsgSubmitBatch" || m["rollup_id"] !== rollupId) continue;
      const batchIndex = int(m["batch_index"]);
      const inboxEnd = int(m["inbox_end"]);
      const inboxStart = batchIndex === undefined ? undefined : starts.get(batchIndex);
      if (batchIndex === undefined || inboxEnd === undefined || inboxStart === undefined) continue;
      out.push({
        batchIndex,
        inboxStart,
        inboxEnd,
        prevStateRoot: wireHex(m["prev_state_root"] as string | null),
        stateRoot: wireHex(m["state_root"] as string | null),
        withdrawalsRoot: wireHex(m["withdrawals_root"] as string | null),
        dataHash: wireHex(m["data_hash"] as string | null),
        height,
        tx: (t.txhash ?? "").toUpperCase(),
        sequencer: String(m["sequencer"] ?? ""),
      });
    }
  }
  return out;
}

/** Upheld fraud proofs on `rollupId` (`rdk_fraud_upheld`). */
export function fraudsFrom(txs: TxResponse[], rollupId: string): FraudLite[] {
  const out: FraudLite[] = [];
  for (const t of txs) {
    const height = int(t.height);
    if ((t.code ?? 0) !== 0 || height === undefined) continue;
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_fraud_upheld") continue;
      const a = attrs(ev);
      const batchIndex = int(a["batch_index"]);
      if (a["rollup_id"] !== rollupId || batchIndex === undefined) continue;
      out.push({ batchIndex, height, tx: (t.txhash ?? "").toUpperCase(), challenger: a["challenger"] ?? "", submitter: a["submitter"] ?? "" });
    }
  }
  return out.sort((x, y) => x.height - y.height);
}

/** Withdrawals of `rollupId` paid on L1 (`rdk_withdrawal_executed`). */
export function executedFrom(txs: TxResponse[], rollupId: string): ExecutedLite[] {
  const out: ExecutedLite[] = [];
  for (const t of txs) {
    const height = int(t.height);
    if ((t.code ?? 0) !== 0 || height === undefined) continue;
    for (const ev of t.events ?? []) {
      if (ev.type !== "rdk_withdrawal_executed") continue;
      const a = attrs(ev);
      const batchIndex = int(a["batch_index"]);
      const withdrawalIndex = int(a["withdrawal_index"]);
      const amount = uqor(a["amount"]);
      if (a["rollup_id"] !== rollupId || batchIndex === undefined || withdrawalIndex === undefined || amount === undefined) continue;
      out.push({ batchIndex, withdrawalIndex, recipient: a["recipient"] ?? "", amount, height, tx: (t.txhash ?? "").toUpperCase() });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the committed inbox archive

/** One row of `data/inbox/<rollup>.jsonl`: an entry and the inbox accumulator after it. */
export interface ArchiveRow {
  sequence: number;
  height: number;
  poster: string;
  payloadHex: string;
  acc: string;
}

/**
 * The archive's rows from sequence 1, in order, each with the accumulator the archive claims after it.
 * Stops at the first row that is malformed, out of sequence, or whose accumulator does not follow from
 * the rows before it. Rows returned here are still only the archive's word: `entriesWithArchive` uses
 * them only once the chain's own accumulator confirms them.
 */
export function parseArchive(text: string, env: RollupEnv): ArchiveRow[] {
  const rows: ArchiveRow[] = [];
  let acc = bytesToHex(EMPTY_INBOX_ACC).toLowerCase();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let r: Partial<ArchiveRow>;
    try {
      r = JSON.parse(line) as Partial<ArchiveRow>;
    } catch {
      break;
    }
    const ok =
      r.sequence === rows.length + 1 &&
      int(r.height) !== undefined &&
      typeof r.poster === "string" &&
      typeof r.payloadHex === "string" &&
      /^([0-9a-f]{2})*$/.test(r.payloadHex) &&
      typeof r.acc === "string";
    if (!ok) break;
    const next = bytesToHex(
      qledgerAccumulate({ ...env, from: rows.length, accFrom: acc, entries: [{ height: BigInt(r.height!), poster: r.poster!, payload: hexToBytes(r.payloadHex!) }] }),
    ).toLowerCase();
    if (next !== r.acc!.toLowerCase()) break;
    acc = next;
    rows.push(r as ArchiveRow);
  }
  return rows;
}

const rowEntry = (r: ArchiveRow): Entry => ({ sequence: r.sequence, height: r.height, poster: r.poster, payload: hexToBytes(r.payloadHex) });

/**
 * Inbox entries 1..`head` from the archive where it has them and from the chain after it, used only if
 * the whole run folds to the chain's accumulator at the head. Because each accumulator hashes the one
 * before it, that one match confirms every archived row. `fetchAfter(from, accFrom)` reads entries
 * `from+1 .. head` from the chain (the RDK's `fetchQledgerEntries`, which checks them against the
 * chain's accumulator at the head itself).
 */
export async function entriesWithArchive(
  env: RollupEnv,
  rows: ArchiveRow[],
  head: number,
  headAcc: string,
  fetchAfter: (from: number, accFrom: string) => Promise<Entry[]>,
): Promise<{ entries: Entry[]; archived: number }> {
  const archived = rows.slice(0, head);
  const accAt = archived.length ? archived[archived.length - 1]!.acc.toLowerCase() : bytesToHex(EMPTY_INBOX_ACC).toLowerCase();
  const rest = archived.length < head ? await fetchAfter(archived.length, accAt) : [];
  const entries = [...archived.map(rowEntry), ...rest];
  if (entries.length !== head || entries.some((e, i) => e.sequence !== i + 1)) throw new Error(`the archive and the chain gave ${entries.length} of the inbox's ${head} entries`);
  const folded = bytesToHex(
    qledgerAccumulate({ ...env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: entries.map((e) => ({ height: BigInt(e.height), poster: e.poster, payload: e.payload })) }),
  ).toLowerCase();
  if (folded !== headAcc.toLowerCase().replace(/^0x/, "")) throw new Error("the archived entries do not match the chain's inbox accumulator, so they were not used");
  return { entries, archived: archived.length };
}
