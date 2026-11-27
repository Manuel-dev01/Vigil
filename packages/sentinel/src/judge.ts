/**
 * The sentinel's own re-execution of every vigil-pay-1 batch, with the watchtower's pure core
 * (packages/qledger-watchtower/src/check.ts, imported, not copied). It sends nothing and holds no key: it
 * only tells a human when a batch does not reproduce and nobody has had it removed (rules.ts).
 *
 * Live batches (every status but "rejected") are judged in index order, each against the honest state
 * after the one before it, so a batch built on a bad one is flagged too. A verdict is kept while the batch
 * publishes the same fields; when the chain's list changes (a challenge upheld, an index reused), the
 * batches from the first change on are judged again.
 *
 * When the chain has pruned the records of the first batches, the inbox entries before the first record it
 * still holds are executed in one go (the state after an entry does not depend on how entries were cut into
 * batches, as Keel's sync also relies on) and checked against that record's parent root. If they do not
 * reach it, nothing is judged: the sentinel cannot tell fraud from a history it cannot see.
 */
import { QledgerLedger, bytesToHex, executeQledger, type QledgerEntry, type QledgerWithdrawal } from "@qorechain/rdk";
import { EMPTY_ACC, toEntry, type InboxReader } from "@vigil/core/inbox";
import { checkBatch, type Field, type PublishedBatch, type RollupEnv } from "../../qledger-watchtower/src/check.ts";

/** A batch as the chain lists it (hex fields; the REST client's BatchView fits). */
export interface ChainBatch extends PublishedBatch {
  status: string;
  /** Unix seconds of the submission block (0 when the node does not say). */
  submittedTime: number;
}

/** Inbox entries `from+1 .. to`, with the chain-proven inbox accumulators at `from` and `to` (hex). */
export interface EntrySource {
  read(from: number, to: number): Promise<{ entries: QledgerEntry[]; accFrom: string; accTo: string }>;
}

export type VerdictKind = "valid" | "invalid" | "unjudged";

export interface Verdict {
  batchIndex: number;
  stateRoot: string;
  status: string;
  submittedTime: number;
  kind: VerdictKind;
  /** Fields that differ from re-execution (invalid only). */
  mismatches: Field[];
  /** The honest execution's withdrawals (valid only): who the batch pays, and how much. */
  withdrawals: QledgerWithdrawal[];
  /** Why it was not judged (unjudged only). */
  reason?: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/^0x/, "");
const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

/** Every field a batch publishes: an index alone is reused after an upheld challenge. */
export const batchKey = (b: PublishedBatch): string =>
  [b.batchIndex, norm(b.prevStateRoot), `${b.inboxStart}-${b.inboxEnd}`, norm(b.stateRoot), norm(b.withdrawalsRoot), norm(b.dataHash)].join(":");

interface Judged {
  key: string;
  verdict: Omit<Verdict, "status" | "submittedTime">;
  /** The honest state after this batch: the parent of the next. */
  after: QledgerLedger;
}

export class BatchJudge {
  private judged: Judged[] = [];
  private seed: { inboxEnd: number; state: QledgerLedger } | undefined;

  constructor(
    readonly env: RollupEnv,
    private readonly source: EntrySource,
  ) {}

  /** Judge every live batch not judged yet; returns a verdict for each, in index order. */
  async sync(batches: readonly ChainBatch[]): Promise<Verdict[]> {
    const live = batches.filter((b) => b.status !== "rejected").sort((a, b) => a.batchIndex - b.batchIndex);
    if (live.length === 0) return [];
    // Keep verdicts up to the first batch whose fields changed (or that moved), judge the rest again.
    let keep = 0;
    while (keep < this.judged.length && keep < live.length && this.judged[keep]!.key === batchKey(live[keep]!)) keep++;
    this.judged = this.judged.slice(0, keep);

    for (let i = keep; i < live.length; i++) {
      const b = live[i]!;
      const parent = i === 0 ? await this.start(b) : this.judged[i - 1]!.after;
      if (typeof parent === "string") {
        // Nothing before this batch can be reproduced, so nothing from here on is judged.
        return live.map((x) => ({ ...this.base(x), kind: "unjudged" as const, mismatches: [], withdrawals: [], reason: parent }));
      }
      const { entries, accFrom, accTo } = await this.source.read(b.inboxStart, b.inboxEnd);
      const v = checkBatch(this.env, parent, accFrom, accTo, entries, b);
      this.judged.push({
        key: batchKey(b),
        verdict: { batchIndex: b.batchIndex, stateRoot: norm(b.stateRoot), kind: v.valid ? "valid" : "invalid", mismatches: v.mismatches, withdrawals: v.valid ? v.honest.paid : [] },
        after: v.next,
      });
    }
    return live.map((b, i) => ({ ...this.judged[i]!.verdict, status: b.status, submittedTime: b.submittedTime }));
  }

  private base(b: ChainBatch): Pick<Verdict, "batchIndex" | "stateRoot" | "status" | "submittedTime"> {
    return { batchIndex: b.batchIndex, stateRoot: norm(b.stateRoot), status: b.status, submittedTime: b.submittedTime };
  }

  /** The honest state before the first listed batch, or why there is none. */
  private async start(first: ChainBatch): Promise<QledgerLedger | string> {
    if (first.inboxStart === 0) return new QledgerLedger();
    if (this.seed?.inboxEnd !== first.inboxStart) {
      const { entries } = await this.source.read(0, first.inboxStart);
      const state = new QledgerLedger();
      executeQledger(this.env, state, entries);
      this.seed = { inboxEnd: first.inboxStart, state };
    }
    if (hex(this.seed.state.root()) !== norm(first.prevStateRoot)) {
      return `the inbox entries before batch ${first.batchIndex} (the first batch the chain still lists) do not reproduce its parent root`;
    }
    return this.seed.state;
  }
}

/** Entries from the shared inbox reader (@vigil/core/inbox): each checked against the chain's accumulator. */
export function readerSource(reader: InboxReader): EntrySource {
  return {
    async read(from, to) {
      const rows = await reader.read(from, to);
      const accFrom = from === 0 ? EMPTY_ACC : await reader.accAt(from);
      if (accFrom === undefined) throw new Error(`no chain-proven inbox accumulator at ${from}`);
      return { entries: rows.map(toEntry), accFrom, accTo: rows.at(-1)?.acc ?? accFrom };
    },
  };
}

