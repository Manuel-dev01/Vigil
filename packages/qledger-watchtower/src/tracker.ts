/**
 * Follow one qledger-v1 rollup and judge every live batch.
 *
 * Honest states are kept by state root, not by batch index, because an index
 * can be reused: when a challenge is upheld the chain rejects that batch and
 * every later unfinalized one, rolls the inbox back, and the next submission
 * takes the same index again. A batch is judged against the honest state its
 * `prevStateRoot` names; a batch built on top of an invalid one is invalid too.
 */
import {
  EMPTY_INBOX_ACC,
  QledgerLedger,
  bytesToHex,
  base64ToBytes,
  fetchQledgerEntries,
  postedDataHash,
  qledgerAccumulate,
  type QledgerEntry,
  type RestClient,
} from "@qorechain/rdk";
import { InboxArchive, type ArchivedEntry } from "./archive.ts";
import { buildChallenge, checkBatch, type Challenge, type Field, type PublishedBatch, type RollupEnv } from "./check.ts";

export interface LiveBatch extends PublishedBatch {
  status: string;
  submittedAt: number;
}

/** Where batches and inbox entries come from: the chain, or recorded data in tests. */
export interface BatchSource {
  listBatches(): Promise<LiveBatch[]>;
  /** Entries `from+1 .. to`, each with the chain's accumulator after it. */
  fetchEntries(from: number, to: number, accFrom: string): Promise<ArchivedEntry[]>;
}

export type Judgement =
  | { kind: "valid" }
  | { kind: "invalid"; mismatches: Field[]; honestStateRoot: string; honestWithdrawalsRoot: string }
  | { kind: "descends-from-invalid"; parent: string }
  | { kind: "unknown-parent"; parent: string };

export interface TrackedBatch {
  batch: LiveBatch;
  judgement: Judgement;
}

const norm = (s: string): string => s.toLowerCase().replace(/^0x/, "");
const key = (b: PublishedBatch): string => `${b.batchIndex}:${norm(b.stateRoot)}:${b.inboxEnd}`;

export class RollupTracker {
  private readonly states = new Map<string, QledgerLedger>();
  private readonly invalidRoots = new Set<string>();
  private readonly judged = new Map<string, Judgement>();

  constructor(
    readonly env: RollupEnv,
    private readonly source: BatchSource,
    readonly archive: InboxArchive,
  ) {
    const empty = new QledgerLedger();
    this.states.set(bytesToHex(empty.root()).toLowerCase(), empty);
  }

  /** Pull new batches and entries, judge anything not judged yet, return every live batch. */
  async sync(): Promise<TrackedBatch[]> {
    const batches = (await this.source.listBatches()).filter((b) => b.status !== "rejected").sort((a, b) => a.batchIndex - b.batchIndex);
    const need = batches.reduce((m, b) => Math.max(m, b.inboxEnd), 0);
    if (need > this.archive.head) {
      const accFrom = this.archive.accAt(this.archive.head)!;
      this.archive.append(await this.source.fetchEntries(this.archive.head, need, accFrom));
    }
    return batches.map((b) => ({ batch: b, judgement: this.judge(b) }));
  }

  private judge(b: LiveBatch): Judgement {
    const k = key(b);
    const cached = this.judged.get(k);
    if (cached) return cached;
    const prev = norm(b.prevStateRoot);
    const parent = this.states.get(prev);
    let j: Judgement;
    if (!parent) {
      j = this.invalidRoots.has(prev) ? { kind: "descends-from-invalid", parent: prev } : { kind: "unknown-parent", parent: prev };
      if (j.kind === "descends-from-invalid") this.invalidRoots.add(norm(b.stateRoot));
    } else {
      const v = checkBatch(this.env, parent, this.archive.accAt(b.inboxStart)!, this.archive.accAt(b.inboxEnd)!, this.archive.range(b.inboxStart, b.inboxEnd), b);
      this.states.set(v.honest.stateRoot, v.next);
      if (v.valid) {
        j = { kind: "valid" };
      } else {
        this.invalidRoots.add(norm(b.stateRoot));
        j = { kind: "invalid", mismatches: v.mismatches, honestStateRoot: v.honest.stateRoot, honestWithdrawalsRoot: v.honest.withdrawalsRoot };
      }
    }
    // An unknown parent may become known later (e.g. a gap filled); do not cache it.
    if (j.kind !== "unknown-parent") this.judged.set(k, j);
    return j;
  }

  /** The judgement already reached for a batch, if any. */
  judgementFor(b: PublishedBatch): Judgement | undefined {
    return this.judged.get(key(b));
  }

  /** Build (and locally decide) the fraud proof for an invalid batch. */
  challenge(b: PublishedBatch): Challenge {
    const parent = this.states.get(norm(b.prevStateRoot));
    if (!parent) throw new Error(`no honest parent state for batch ${b.batchIndex}`);
    return buildChallenge(this.env, parent, this.archive.accAt(b.inboxStart)!, this.archive.range(b.inboxStart, b.inboxEnd), b);
  }
}

/**
 * One inbox post, found by its `rdk_data_posted` event, including posts made
 * through authz (`MsgExec` wrapping `MsgPostRollupData`, the gasless-relayer
 * pattern). RDK 0.9.0's `fetchQledgerEntries` does not look inside `MsgExec`
 * and fails on such posts. The payload is accepted only if its SHA-256
 * (`postedDataHash`) equals the chain's recorded data hash and it extends the
 * inbox accumulator to the chain's recorded value (`qledgerAccumulate`).
 */
async function fetchPostThroughEvents(rest: RestClient, restBase: string, env: RollupEnv, sequence: number, accFrom: string): Promise<QledgerEntry> {
  const pd = await rest.getPostedData(env.rollupId, sequence);
  const q = encodeURIComponent(`rdk_data_posted.rollup_id='${env.rollupId}' AND rdk_data_posted.sequence='${sequence}'`);
  const res = await fetch(`${restBase}/cosmos/tx/v1beta1/txs?query=${q}`);
  if (!res.ok) throw new Error(`post ${sequence}: tx search HTTP ${res.status}`);
  const body = (await res.json()) as { txs?: { body: { messages: unknown[] } }[] };
  const found: { poster: string; data: string }[] = [];
  const walk = (m: unknown): void => {
    if (!m || typeof m !== "object") return;
    const o = m as Record<string, unknown>;
    if (o["@type"] === "/qorechain.rdk.v1.MsgPostRollupData" && o["rollup_id"] === env.rollupId) found.push({ poster: String(o["poster"]), data: String(o["data"]) });
    if (Array.isArray(o["msgs"])) o["msgs"].forEach(walk); // authz MsgExec
  };
  for (const tx of body.txs ?? []) tx.body.messages.forEach(walk);
  for (const f of found) {
    const payload = base64ToBytes(f.data);
    if (bytesToHex(postedDataHash(payload)).toLowerCase() !== pd.dataHash.toLowerCase() || f.poster !== pd.poster) continue;
    const entry: QledgerEntry = { height: BigInt(pd.height), poster: pd.poster, payload };
    const acc = bytesToHex(qledgerAccumulate({ ...env, from: sequence - 1, accFrom, entries: [entry] })).toLowerCase();
    if (acc !== pd.inboxAcc.toLowerCase()) throw new Error(`post ${sequence}: payload matches its hash but not the inbox accumulator`);
    return entry;
  }
  throw new Error(`post ${sequence}: no message in its transaction matches the recorded data hash`);
}

/** A BatchSource backed by the chain's REST API (needs a node with tx indexing). */
export function chainSource(rest: RestClient, env: RollupEnv, restBase = "https://api-testnet.qore.host"): BatchSource {
  return {
    async listBatches() {
      return (await rest.listBatches(env.rollupId)).map((b) => ({
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
    },
    async fetchEntries(from, to, accFrom) {
      const out: ArchivedEntry[] = [];
      let acc = accFrom;
      for (let start = from; start < to; start += 64) {
        const end = Math.min(start + 64, to);
        // fetchQledgerEntries checks every entry against the chain's accumulator.
        let entries: QledgerEntry[];
        try {
          entries = await fetchQledgerEntries(rest, { ...env, from: start, to: end, accFrom: acc });
        } catch {
          // One post in the range is not readable by the RDK (e.g. posted through authz): go one by one.
          entries = [];
          let a = acc;
          for (let seq = start + 1; seq <= end; seq++) {
            let e: QledgerEntry;
            try {
              [e] = (await fetchQledgerEntries(rest, { ...env, from: seq - 1, to: seq, accFrom: a })) as [QledgerEntry];
            } catch {
              e = await fetchPostThroughEvents(rest, restBase, env, seq, a);
            }
            entries.push(e);
            a = bytesToHex(qledgerAccumulate({ ...env, from: seq - 1, accFrom: a, entries: [e] })).toLowerCase();
          }
        }
        entries.forEach((e, i) => {
          const sequence = start + i + 1;
          acc = bytesToHex(qledgerAccumulate({ ...env, from: sequence - 1, accFrom: acc, entries: [e] })).toLowerCase();
          out.push({ sequence, height: Number(e.height), poster: e.poster, payloadHex: bytesToHex(e.payload).toLowerCase(), acc });
        });
      }
      return out;
    },
  };
}

export const EMPTY_ACC = bytesToHex(EMPTY_INBOX_ACC).toLowerCase();
