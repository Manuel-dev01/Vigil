/**
 * The browser watchtower's pure core: replay every batch a qledger-v1 rollup was ever sent, from its
 * inbox, and judge each one the way our hosted watchtowers do. No network and no DOM, so it runs in a
 * Web Worker (worker.ts) and in the tests.
 *
 * Every hash, tree, execution step and fraud proof comes from @qorechain/rdk, through the watchtower's
 * own check (packages/qledger-watchtower/src/check.ts). Batches are judged against the honest state
 * their `prevStateRoot` names and keyed by every field they publish, never by index alone: when a fraud
 * proof is upheld the chain drops the batch and the next one reuses its index (THREAT_MODEL F3).
 *
 * Nothing here signs or sends anything. The only proof it builds is returned as bytes.
 */
import {
  EMPTY_INBOX_ACC,
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  QLEDGER_KIND_TRANSFER,
  QLEDGER_WITHDRAWAL_COUNTER_ID,
  QledgerLedger,
  QledgerPartialTree,
  decodeQledgerTx,
  executeQledger,
  hexToBytes,
  qledgerAccountId,
  qledgerAccumulate,
  type QledgerEntry,
  type QledgerWithdrawal,
} from "@qorechain/rdk";
import { buildChallenge, checkBatch, type Field, type PublishedBatch, type RollupEnv } from "@vigil/qledger-watchtower/check";
import { matchExecuted } from "../executed.ts";
import { hex, wireHex } from "./hex.ts";

export type { Field, PublishedBatch, RollupEnv };

/** One inbox entry, `sequence` from 1, as read from the transaction that posted it. */
export interface Entry {
  sequence: number;
  height: number;
  poster: string;
  payload: Uint8Array;
}

/** A batch record the chain still keeps (its batch list). */
export interface BatchRecord extends PublishedBatch {
  status: string;
  /** The block it was submitted at. */
  submittedAt: number;
}

/** A batch as its submitting transaction published it (from the node's transaction index). */
export interface Submission extends PublishedBatch {
  height: number;
  tx: string;
  sequencer: string;
}

export interface AnchorLite {
  layerHeight: number;
  stateRoot: string;
  /** The block of the transaction that carried it (the batch's own submission, for Keel's batches). */
  mainChainHeight: number;
}

/** An upheld fraud proof (`rdk_fraud_upheld`). */
export interface FraudLite {
  batchIndex: number;
  height: number;
  tx: string;
  challenger: string;
  submitter: string;
}

/** A withdrawal paid on L1 (`rdk_withdrawal_executed`). */
export interface ExecutedLite {
  batchIndex: number;
  withdrawalIndex: number;
  recipient: string;
  amount: bigint;
  height: number;
  tx: string;
}

export interface ReplayInput {
  env: RollupEnv;
  /** Every entry from sequence 1 to the inbox head, in order. */
  entries: Entry[];
  /** The chain's inbox accumulator at the head, as the node reports it. */
  headAcc: string;
  records: BatchRecord[];
  /** Every batch submission found in the node's transaction index; undefined when the search failed. */
  submissions: Submission[] | undefined;
  anchors: AnchorLite[];
  frauds: FraudLite[];
  executed: ExecutedLite[];
  /** uqor deposited into the rollup and not withdrawn, as the node reports it. */
  depositPool: string;
}

export type Where = "kept" | "pruned" | "rolled back" | "missing";

export type Verdict =
  /** Re-executed here; every published field matches. */
  | "reproduced"
  /** Re-executed here; at least one published field differs. */
  | "differs"
  /** Built on a state root that only a wrong batch produced. */
  | "descends from a wrong batch"
  /** Its parent state is not one this replay reached. */
  | "unknown parent"
  /** Its inbox range runs past the entries read. */
  | "entries missing";

export interface BatchRow {
  key: string;
  batchIndex: number;
  where: Where;
  /** The chain's record status for a kept batch; otherwise the same as `where`. */
  status: string;
  /** The block it was submitted at, when known. */
  height: number | undefined;
  tx: string | undefined;
  sequencer: string | undefined;
  inboxStart: number;
  inboxEnd: number;
  published: { prevStateRoot: string; stateRoot: string; withdrawalsRoot: string; dataHash: string };
  verdict: Verdict;
  mismatches: Field[];
  /** What an honest batch over the same inputs publishes (when it was re-executed). */
  honest: { stateRoot: string; withdrawalsRoot: string; dataHash: string } | undefined;
  /** The ML-DSA-87 anchor carried by the same transaction, if any, and whether its root is the one re-executed here. */
  anchor: { stateRoot: string; matches: boolean } | undefined;
  /** For a batch that differs: the fraud proof built here, decided as the chain decides (`checkQledgerFraud`). */
  challenge: { proofBytes: number; wins: boolean } | undefined;
  /** The upheld challenge that removed it, for a rolled-back batch. */
  fraud: FraudLite | undefined;
  withdrawals: number;
  /** Valid transfers between two different accounts, for the tamper demo. */
  transfers: TransferInfo[];
}

export interface TransferInfo {
  sequence: number;
  from: string;
  to: string;
  amount: string;
  /** The sender's balance just before it: the most a forged amount can be. */
  max: string;
}

export interface Owed {
  batchIndex: number | undefined;
  index: string;
  recipient: string;
  amount: string;
}

export interface Solvency {
  /** Sum of every L2 balance after all inbox entries (the withdrawal counter slot excluded). */
  balances: string;
  /** Withdrawals committed or pending that the chain has not paid yet. */
  unpaid: string;
  owed: string;
  pool: string;
  /** pool - owed, signed. */
  surplus: string;
  accounts: number;
  paidWithdrawals: number;
  unpaidList: Owed[];
  /** Entries after the last kept batch, executed here as the next batch would. */
  pendingEntries: number;
}

export interface ReplayResult {
  rows: BatchRow[];
  counts: { kept: number; keptReproduced: number; pruned: number; prunedReproduced: number; rolledBack: number; rolledBackCaught: number; other: number };
  /** Time spent re-executing and judging, in this thread. */
  ms: number;
  entries: number;
  submissionsRead: boolean;
  /** The state root lookups are checked against: the latest kept batch with an anchor that matches the replay. */
  lookupRoot: { root: string; batchIndex: number } | undefined;
  /** The head of the honest chain of kept batches. */
  latest: { root: string; batchIndex: number } | undefined;
  /** Undefined when the latest kept batch was not reproduced: there is then no honest state to count. */
  solvency: Solvency | undefined;
  accounts: { id: string; balance: string; nonce: string }[];
}

const norm = (s: string): string => s.toLowerCase().replace(/^0x/, "");

/**
 * A published batch's identity: every field it publishes. The same rule as the hosted watchtower's
 * `batchKey` (tracker.ts), kept here so the browser bundle does not pull in the tracker.
 */
export const batchKey = (b: PublishedBatch): string =>
  [b.batchIndex, norm(b.prevStateRoot), `${b.inboxStart}-${b.inboxEnd}`, norm(b.stateRoot), norm(b.withdrawalsRoot), norm(b.dataHash)].join(":");

export const toEntry = (e: Entry): QledgerEntry => ({ height: BigInt(e.height), poster: e.poster, payload: e.payload });

/** The chain's inbox accumulator after each sequence, from 0 (empty) to the last entry. */
export function accumulators(env: RollupEnv, entries: Entry[]): string[] {
  const out = [hex(EMPTY_INBOX_ACC)];
  entries.forEach((e, i) => {
    if (e.sequence !== i + 1) throw new Error(`inbox entries are not contiguous: position ${i + 1} holds entry ${e.sequence}`);
    out.push(hex(qledgerAccumulate({ ...env, from: i, accFrom: out[i]!, entries: [toEntry(e)] })));
  });
  return out;
}

/** Valid transfers between two different accounts in `entries`, applied on a copy of `parent`. */
function transfersIn(env: RollupEnv, parent: QledgerLedger, entries: Entry[]): TransferInfo[] {
  const l = parent.clone();
  const out: TransferInfo[] = [];
  for (const e of entries) {
    const tx = e.poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX) ? undefined : decodeQledgerTx(e.payload);
    const from = tx ? qledgerAccountId(tx.publicKey, tx.scheme) : undefined;
    const before = from ? l.get(from) : { balance: 0n, nonce: 0n };
    executeQledger(env, l, [toEntry(e)]);
    if (!tx || !from || tx.kind !== QLEDGER_KIND_TRANSFER || !tx.to) continue;
    // Applied (the nonce moved) and not to itself (a self-transfer changes no balance).
    if (l.get(from).nonce === before.nonce + 1n && hex(from) !== hex(tx.to))
      out.push({ sequence: e.sequence, from: hex(from), to: hex(tx.to), amount: tx.amount.toString(), max: before.balance.toString() });
  }
  return out;
}

/** Everything the worker keeps after a replay, for lookups and the tamper demo. */
export interface Session {
  env: RollupEnv;
  entries: Entry[];
  acc: string[];
  /** Honest ledgers by state root. */
  states: Map<string, QledgerLedger>;
  rows: BatchRow[];
  result: ReplayResult;
}

/**
 * Re-execute every batch in `input` and judge it. Kept batches are compared with their record in the
 * chain's batch list; batches the chain no longer lists are compared with what their own submission
 * published, and, where the chain pruned the record, with the ML-DSA-87 anchor the same transaction
 * carried.
 */
export function replay(input: ReplayInput, now: () => number = () => performance.now()): Session {
  const t0 = now();
  const { env } = input;
  const acc = accumulators(env, input.entries);
  const head = input.entries.length;
  if (acc[head] !== norm(input.headAcc)) {
    throw new Error(`the ${head} inbox entries read do not fold to the chain's inbox accumulator (${short(acc[head]!)} here, ${short(norm(input.headAcc))} on chain)`);
  }

  // ---- which batches exist, and where each stands
  type Item = { b: PublishedBatch; where: Where; status: string; height: number | undefined; tx: string | undefined; sequencer: string | undefined };
  const items = new Map<string, Item>();
  const recordAt = new Map<number, BatchRecord>();
  for (const r of input.records) {
    const b = clean(r);
    recordAt.set(b.batchIndex, r);
    items.set(batchKey(b), { b, where: "kept", status: r.status, height: r.submittedAt || undefined, tx: undefined, sequencer: undefined });
  }
  const minKept = Math.min(Infinity, ...input.records.map((r) => r.batchIndex));
  for (const s of input.submissions ?? []) {
    const b = clean(s);
    const k = batchKey(b);
    const known = items.get(k);
    if (known) {
      known.height = s.height;
      known.tx = s.tx;
      known.sequencer = s.sequencer;
      continue;
    }
    const rec = recordAt.get(b.batchIndex);
    const upheld = input.frauds.some((f) => f.batchIndex === b.batchIndex && f.height > s.height);
    // The chain lists another batch at this index, or a fraud proof at this index came later: rolled back.
    // No record at an index below every kept one: the chain pruned a finalized record.
    const where: Where = rec || upheld ? "rolled back" : b.batchIndex < minKept ? "pruned" : "missing";
    items.set(k, { b, where, status: where, height: s.height, tx: s.tx, sequencer: s.sequencer });
  }
  const ordered = [...items.values()].sort((x, y) => (x.height ?? Infinity) - (y.height ?? Infinity) || x.b.batchIndex - y.b.batchIndex);

  // ---- judge in chain order, each against the honest state its parent root names
  const empty = new QledgerLedger();
  const states = new Map<string, QledgerLedger>([[hex(empty.root()), empty]]);
  const invalidRoots = new Set<string>();
  const rows: BatchRow[] = [];
  const committed: { item: Item; paid: QledgerWithdrawal[] }[] = [];
  for (const it of ordered) {
    const b = it.b;
    const anchor = anchorFor(input.anchors, b, it.height);
    const row: BatchRow = {
      key: batchKey(b),
      batchIndex: b.batchIndex,
      where: it.where,
      status: it.status,
      height: it.height,
      tx: it.tx,
      sequencer: it.sequencer,
      inboxStart: b.inboxStart,
      inboxEnd: b.inboxEnd,
      published: { prevStateRoot: b.prevStateRoot, stateRoot: b.stateRoot, withdrawalsRoot: b.withdrawalsRoot, dataHash: b.dataHash },
      verdict: "unknown parent",
      mismatches: [],
      honest: undefined,
      anchor: anchor ? { stateRoot: wireHex(anchor.stateRoot), matches: false } : undefined,
      challenge: undefined,
      fraud: it.where === "rolled back" ? fraudFor(input.frauds, b.batchIndex, it.height) : undefined,
      withdrawals: 0,
      transfers: [],
    };
    rows.push(row);
    if (b.inboxEnd > head || b.inboxStart < 0 || b.inboxEnd < b.inboxStart) {
      row.verdict = "entries missing";
      continue;
    }
    const parent = states.get(b.prevStateRoot);
    if (!parent) {
      row.verdict = invalidRoots.has(b.prevStateRoot) ? "descends from a wrong batch" : "unknown parent";
      if (row.verdict === "descends from a wrong batch") invalidRoots.add(b.stateRoot);
      continue;
    }
    const range = input.entries.slice(b.inboxStart, b.inboxEnd);
    const entries = range.map(toEntry);
    const v = checkBatch(env, parent, acc[b.inboxStart]!, acc[b.inboxEnd]!, entries, b);
    if (!states.has(v.honest.stateRoot)) states.set(v.honest.stateRoot, v.next);
    row.honest = { stateRoot: v.honest.stateRoot, withdrawalsRoot: v.honest.withdrawalsRoot, dataHash: v.honest.dataHash };
    row.withdrawals = v.honest.withdrawals;
    row.mismatches = v.mismatches;
    if (row.anchor) row.anchor.matches = row.anchor.stateRoot === v.honest.stateRoot;
    if (v.valid) {
      row.verdict = "reproduced";
      row.transfers = transfersIn(env, parent, range);
      if (it.where === "kept" || it.where === "pruned") committed.push({ item: it, paid: v.honest.paid });
    } else {
      row.verdict = "differs";
      invalidRoots.add(b.stateRoot);
      const c = buildChallenge(env, parent, acc[b.inboxStart]!, entries, b);
      row.challenge = { proofBytes: c.proof.length, wins: c.wins };
    }
  }

  // ---- the honest chain of kept batches, and the ledger at its head
  const keptRows = rows.filter((r) => r.where === "kept" || r.where === "pruned");
  const lastKept = [...keptRows].sort((x, y) => x.batchIndex - y.batchIndex).at(-1);
  const latest = lastKept && lastKept.verdict === "reproduced" ? { root: lastKept.published.stateRoot, batchIndex: lastKept.batchIndex } : undefined;
  const anchoredRow = [...keptRows].sort((x, y) => y.batchIndex - x.batchIndex).find((r) => r.verdict === "reproduced" && r.anchor?.matches);
  const lookupRoot = anchoredRow ? { root: anchoredRow.published.stateRoot, batchIndex: anchoredRow.batchIndex } : undefined;

  const solvency = latest || keptRows.length === 0 ? solvencyOf(input, states, latest, lastKept?.inboxEnd ?? 0, committed) : undefined;
  const counts = {
    kept: rows.filter((r) => r.where === "kept").length,
    keptReproduced: rows.filter((r) => r.where === "kept" && r.verdict === "reproduced").length,
    pruned: rows.filter((r) => r.where === "pruned").length,
    prunedReproduced: rows.filter((r) => r.where === "pruned" && r.verdict === "reproduced" && r.anchor?.matches !== false).length,
    rolledBack: rows.filter((r) => r.where === "rolled back").length,
    rolledBackCaught: rows.filter((r) => r.where === "rolled back" && r.verdict === "differs" && r.challenge?.wins).length,
    other: rows.filter((r) => r.where === "missing").length,
  };
  const ledger = latest ? states.get(latest.root) : undefined;
  const accounts = (ledger?.accounts() ?? [])
    .filter((a) => hex(a.id) !== hex(QLEDGER_WITHDRAWAL_COUNTER_ID))
    .map((a) => ({ id: hex(a.id), balance: a.balance.toString(), nonce: a.nonce.toString() }));
  const result: ReplayResult = {
    rows,
    counts,
    ms: Math.round(now() - t0),
    entries: head,
    submissionsRead: input.submissions !== undefined,
    lookupRoot,
    latest,
    solvency,
    accounts,
  };
  return { env, entries: input.entries, acc, states, rows, result };
}

/**
 * What the rollup owes on L2 against what the chain holds for it. Owed: every balance after all inbox
 * entries (pending ones executed as the next batch would), plus every withdrawal committed or pending
 * that has no matching L1 payment. Held: the deposit pool as the node reports it.
 */
function solvencyOf(
  input: ReplayInput,
  states: Map<string, QledgerLedger>,
  latest: { root: string; batchIndex: number } | undefined,
  consumed: number,
  committed: { item: { b: PublishedBatch; height: number | undefined }; paid: QledgerWithdrawal[] }[],
): Solvency {
  const base = latest ? states.get(latest.root) : undefined;
  const ledger = (base ?? new QledgerLedger()).clone();
  const pending = input.entries.slice(consumed);
  const pendingPaid = executeQledger(input.env, ledger, pending.map(toEntry)).withdrawals;
  const counter = hex(QLEDGER_WITHDRAWAL_COUNTER_ID);
  const accts = ledger.accounts().filter((a) => hex(a.id) !== counter);
  const balances = accts.reduce((n, a) => n + a.balance, 0n);
  const unpaidList: Owed[] = [];
  let paidCount = 0;
  for (const { item, paid } of committed) {
    for (const w of paid) {
      const hit = matchExecuted(input.executed, {
        batchIndex: item.b.batchIndex,
        withdrawalIndex: Number(w.index),
        recipientQor1: w.recipient,
        amountUqor: w.amount,
        batch: { status: "kept", sameRoot: true, submittedHeight: item.height },
      });
      if (hit) paidCount++;
      else unpaidList.push({ batchIndex: item.b.batchIndex, index: w.index.toString(), recipient: w.recipient, amount: w.amount.toString() });
    }
  }
  for (const w of pendingPaid) unpaidList.push({ batchIndex: undefined, index: w.index.toString(), recipient: w.recipient, amount: w.amount.toString() });
  const unpaid = unpaidList.reduce((n, w) => n + BigInt(w.amount), 0n);
  const owed = balances + unpaid;
  const pool = BigInt(input.depositPool.replace(/uqor$/, "") || "0");
  return {
    balances: balances.toString(),
    unpaid: unpaid.toString(),
    owed: owed.toString(),
    pool: pool.toString(),
    surplus: (pool - owed).toString(),
    accounts: accts.length,
    paidWithdrawals: paidCount,
    unpaidList,
    pendingEntries: pending.length,
  };
}

export interface Lookup {
  id: string;
  balance: string;
  nonce: string;
  root: string;
  batchIndex: number;
  /** Non-empty siblings in the witness (the rest are empty subtrees). */
  siblings: number;
}

/**
 * An account's balance and nonce, opened by a witness from the honest ledger and checked against the
 * state root of the latest batch whose ML-DSA-87 anchor matches the replay (`QledgerPartialTree` throws
 * if the witness does not hash to that root).
 */
export function lookup(s: Session, account: string): Lookup {
  const id = norm(account.trim());
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("an L2 account id is 64 hex digits (32 bytes)");
  const at = s.result.lookupRoot;
  const ledger = at && s.states.get(at.root);
  if (!at || !ledger) throw new Error("no anchored batch was reproduced, so there is no root to check against");
  const w = ledger.witness(hexToBytes(id));
  const opened = new QledgerPartialTree(hexToBytes(at.root), [w]).get(hexToBytes(id));
  return { id, balance: opened.balance.toString(), nonce: opened.nonce.toString(), root: at.root, batchIndex: at.batchIndex, siblings: w.siblings.length };
}

export interface Forgery {
  batchIndex: number;
  sequence: number;
  realAmount: string;
  forgedAmount: string;
  honestRoot: string;
  forgedRoot: string;
  /** The fraud proof against the forged claim, hex, and the chain's own rule run here. */
  proofHex: string;
  wins: boolean;
  /** The same proof against the batch as the chain holds it: an honest batch, so it must lose. */
  winsAgainstReal: boolean;
}

/**
 * The tamper demo, entirely local: pretend the batch recorded one transfer as `forgedAmount` instead
 * of the amount its sender signed (the sender pays it and the recipient receives it). Its state root
 * diverges from re-execution, and the fraud proof built from the honest parent state wins against the
 * forged claim, as the chain would decide it. Nothing is signed or sent.
 */
export function forge(s: Session, key: string, sequence: number, forgedAmount: bigint): Forgery {
  const row = s.rows.find((r) => r.key === key);
  if (!row || row.verdict !== "reproduced" || !row.honest) throw new Error("pick a batch that was reproduced here");
  const t = row.transfers.find((x) => x.sequence === sequence);
  if (!t) throw new Error(`entry ${sequence} is not a transfer between two accounts in batch ${row.batchIndex}`);
  const parent = s.states.get(row.published.prevStateRoot);
  if (!parent) throw new Error("the batch's parent state is not known");
  if (forgedAmount < 0n) throw new Error("an amount cannot be negative");
  const real = BigInt(t.amount);
  if (forgedAmount === real) throw new Error("that is the signed amount; change it to forge the batch");

  const range = s.entries.slice(row.inboxStart, row.inboxEnd);
  const at = range.findIndex((e) => e.sequence === sequence);
  const l = parent.clone();
  executeQledger(s.env, l, range.slice(0, at).map(toEntry));
  const from = hexToBytes(t.from);
  const to = hexToBytes(t.to);
  const before = l.get(from);
  if (forgedAmount > before.balance) throw new Error(`the sender held ${before.balance} uqor before this transfer; a forged amount above that cannot be written to the ledger`);
  executeQledger(s.env, l, [toEntry(range[at]!)]);
  const recipient = l.get(to);
  // The forgery: the sender pays, and the recipient receives, the forged amount instead of the signed one.
  l.set(from, before.balance - forgedAmount, l.get(from).nonce);
  l.set(to, recipient.balance - real + forgedAmount, recipient.nonce);
  executeQledger(s.env, l, range.slice(at + 1).map(toEntry));
  const forgedRoot = hex(l.root());

  const entries = range.map(toEntry);
  const accFrom = s.acc[row.inboxStart]!;
  const real0: PublishedBatch = { batchIndex: row.batchIndex, inboxStart: row.inboxStart, inboxEnd: row.inboxEnd, ...row.published };
  const forged = buildChallenge(s.env, parent, accFrom, entries, { ...real0, stateRoot: forgedRoot });
  const honest = buildChallenge(s.env, parent, accFrom, entries, real0);
  return {
    batchIndex: row.batchIndex,
    sequence,
    realAmount: t.amount,
    forgedAmount: forgedAmount.toString(),
    honestRoot: row.honest.stateRoot,
    forgedRoot,
    proofHex: hex(forged.proof),
    wins: forged.wins,
    winsAgainstReal: honest.wins,
  };
}

/** The command a challenger would run for `batchIndex` with `proofHex`. Printed, never run: `--generate-only` writes an unsigned file. */
export function challengeCommand(rollupId: string, chainId: string, batchIndex: number, proofHex: string): string {
  return [
    `qorechaind tx rdk challenge-batch ${rollupId} ${batchIndex} \\`,
    `  --proof ${proofHex} \\`,
    `  --from <your-key> --chain-id ${chainId} \\`,
    `  --gas 400000 --fees 40000uqor --generate-only > challenge.json`,
  ].join("\n");
}

// ---------------------------------------------------------------- helpers

const short = (h: string): string => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h);

/** Published fields as lowercase hex, whatever form the node used. */
function clean(b: PublishedBatch): PublishedBatch {
  return {
    batchIndex: b.batchIndex,
    inboxStart: b.inboxStart,
    inboxEnd: b.inboxEnd,
    prevStateRoot: wireHex(b.prevStateRoot),
    stateRoot: wireHex(b.stateRoot),
    withdrawalsRoot: wireHex(b.withdrawalsRoot),
    dataHash: wireHex(b.dataHash),
  };
}

/**
 * The anchor a batch carried: its layer height is the batch index, and it rode in the same transaction
 * (same block) when that block is known. Without a block, an anchor with the same root counts.
 */
function anchorFor(anchors: AnchorLite[], b: PublishedBatch, height: number | undefined): AnchorLite | undefined {
  const own = anchors.filter((a) => a.layerHeight === b.batchIndex);
  if (height !== undefined) return own.find((a) => a.mainChainHeight === height);
  return own.find((a) => wireHex(a.stateRoot) === b.stateRoot);
}

/** The first upheld challenge at this index after the batch was submitted. */
function fraudFor(frauds: FraudLite[], batchIndex: number, height: number | undefined): FraudLite | undefined {
  return frauds.filter((f) => f.batchIndex === batchIndex && (height === undefined || f.height > height)).sort((x, y) => x.height - y.height)[0];
}
