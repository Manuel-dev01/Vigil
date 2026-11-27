/**
 * Read what the browser watchtower needs from the node, over the page's one websocket: every batch
 * submission, the batch list, the anchors, every inbox entry, the upheld fraud proofs, the paid
 * withdrawals and the deposit pool. Reads only; the client it uses (chain.ts) answers GET routes alone.
 *
 * Submissions are read before the batch list, and the batch list before the inbox, so every batch
 * read refers only to entries the inbox read will hold. The deposit pool is read after the inbox and
 * the paid withdrawals after the pool (see below).
 */
import { EMPTY_INBOX_ACC, fetchQledgerEntries, type QledgerEntry, type RestClient } from "@qorechain/rdk";
// The repository's public archive of every inbox entry (scripts/inbox-archive.ts). Fetched only if the
// node cannot serve an entry, and used only if the chain's accumulator then confirms it.
import archiveUrl from "../../../../data/inbox/vigil-pay-1.jsonl?url";
import { chain } from "../chain.ts";
import { CHAIN_ID, ROLLUP } from "../config.ts";
import { entriesWithArchive, executedFrom, fraudsFrom, parseArchive, submissionsFrom, type TxResponse } from "./chain-data.ts";
import type { AnchorLite, BatchRecord, Entry, ReplayInput } from "./core.ts";
import { wireHex } from "./hex.ts";

const env = { chainId: CHAIN_ID, rollupId: ROLLUP };

export interface ReadInfo {
  input: ReplayInput;
  /** Wall time of the reads, in milliseconds. */
  readMs: number;
  /** How many leading entries came from the committed archive (0: all from the chain). */
  archived: number;
  /** Why the transaction search for submissions failed, if it did. */
  submissionsError?: string;
}

const asEntries = (from: number, es: QledgerEntry[]): Entry[] => es.map((e, i) => ({ sequence: from + 1 + i, height: Number(e.height), poster: e.poster, payload: e.payload }));

async function inboxEntries(rest: RestClient, head: number, headAcc: string): Promise<{ entries: Entry[]; archived: number }> {
  if (head === 0) return { entries: [], archived: 0 };
  try {
    // Each entry from the transaction that posted it, all checked against the chain's accumulator at the head.
    return { entries: asEntries(0, await fetchQledgerEntries(rest, { ...env, from: 0, to: head, accFrom: EMPTY_INBOX_ACC })), archived: 0 };
  } catch (first) {
    let rows;
    try {
      const res = await fetch(archiveUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rows = parseArchive(await res.text(), env);
    } catch {
      throw first;
    }
    if (rows.length === 0) throw first;
    return entriesWithArchive(env, rows, head, headAcc, async (from, accFrom) => asEntries(from, await fetchQledgerEntries(rest, { ...env, from, to: head, accFrom })));
  }
}

export async function readReplayInput(step: (what: string) => void): Promise<ReadInfo> {
  const t0 = performance.now();
  const { rdk } = await chain();
  const rest = rdk.rest;
  step("the rollup and its batch submissions");
  const { layerId } = await rest.getRollup(ROLLUP);
  let submissionsError: string | undefined;
  const [submitTxs, fraudTxs] = await Promise.all([
    rest.searchTxs(`batch_submitted.rollup_id='${ROLLUP}'`).catch((e: unknown) => {
      submissionsError = e instanceof Error ? e.message : String(e);
      return undefined;
    }),
    rest.searchTxs(`rdk_fraud_upheld.rollup_id='${ROLLUP}'`),
  ]);
  step("the batch list");
  const records: BatchRecord[] = (await rest.listBatches(ROLLUP)).map((b) => ({
    batchIndex: b.batchIndex,
    inboxStart: b.inboxStart,
    inboxEnd: b.inboxEnd,
    prevStateRoot: b.prevStateRoot,
    stateRoot: b.stateRoot,
    withdrawalsRoot: b.withdrawalsRoot,
    dataHash: b.dataHash,
    status: b.status,
    submittedAt: b.submittedAt,
  }));
  const [anchors, inbox] = await Promise.all([rest.getAnchors(layerId), rest.getInbox(ROLLUP)]);
  const head = Number(inbox.headSequence);
  step(`${head} inbox entries, from the transactions that posted them`);
  const headAcc = wireHex(inbox.headAcc);
  const { entries, archived } = await inboxEntries(rest, head, headAcc);
  // The pool after the inbox, and paid withdrawals after the pool: a deposit or a payment that lands
  // while the page reads can then only show as a surplus, never as a shortfall.
  step("the deposit pool and the withdrawals paid on L1");
  const { depositPool } = await rest.getRollup(ROLLUP);
  const executedTxs = await rest.searchTxs(`rdk_withdrawal_executed.rollup_id='${ROLLUP}'`);
  return {
    input: {
      env,
      entries,
      headAcc,
      records,
      submissions: submitTxs ? submissionsFrom(submitTxs as TxResponse[], ROLLUP) : undefined,
      anchors: anchors.map((a): AnchorLite => ({ layerHeight: a.layerHeight, stateRoot: a.stateRoot, mainChainHeight: a.mainChainHeight })),
      frauds: fraudsFrom(fraudTxs as TxResponse[], ROLLUP),
      executed: executedFrom(executedTxs as TxResponse[], ROLLUP),
      depositPool,
    },
    readMs: Math.round(performance.now() - t0),
    archived,
    ...(submissionsError && { submissionsError }),
  };
}
