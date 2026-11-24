/**
 * Read a qledger-v1 rollup's inbox entry by entry, by sequence.
 *
 * For each sequence the chain's posted-data commitment
 * (`/qorechain/rdk/v1/posted_data/{rollup}/{seq}`) gives the height, poster,
 * data hash and the inbox accumulator after the entry. The payload comes from
 * that block: a post's bytes are found in its transactions by their hash (in a
 * top-level `MsgPostRollupData` or in one sent inside another message), a
 * deposit's are rebuilt from its `rdk_rollup_deposit` event. Every entry is
 * checked against the chain's inbox accumulator, carried forward in memory, so
 * the cost of a read depends only on how many entries it covers, never on how
 * many the rollup has had.
 *
 * Once the chain prunes a commitment (after `posted_data_retention_blocks`),
 * the entry can only come from an archive (see archive.ts). Archived rows are
 * used only after a commitment the chain still holds confirms them: the
 * accumulator of a later retained entry, the inbox's head or consumed
 * accumulator, a retained checkpoint, or a batch's inbox range hash. Every
 * entry read from the chain is added to the archive, so a service that keeps
 * its archive never needs data the chain has pruned.
 */
import { QLEDGER_CHECKPOINT_INTERVAL, QLEDGER_DEPOSIT_POSTER_PREFIX, bytesToHex, encodeQledgerDeposit, hexToBytes, inboxRangeHash, postedDataHash, type QledgerEntry } from "@qorechain/rdk";
import { EMPTY_ACC, InboxArchive, accumulate, toEntry, type ArchivedEntry, type InboxEnv } from "./archive.ts";
import { findPayload } from "./protobuf.ts";
import type { InboxSource, PostedData } from "./source.ts";

export type InboxLog = (event: string, fields: Record<string, unknown>) => void;

/** The chain does not hold this entry's commitment (pruned, or not yet on the node asked) and no archive has it. */
export class PrunedEntryError extends Error {
  constructor(readonly sequence: number) {
    super(`inbox entry ${sequence} is no longer held by the chain (or not yet by this node) and no archive has it`);
    this.name = "PrunedEntryError";
  }
}

/** Chain data, or an archive, does not match the chain's inbox accumulator. */
export class InboxMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxMismatchError";
  }
}

/** An accumulator value and whether a chain commitment has proven it. */
interface Acc {
  value: string;
  trusted: boolean;
}

export interface ReadResult {
  entries: ArchivedEntry[];
  /** Sequences in the range that neither the chain nor a confirmed archive could supply (tolerant reads only). */
  missing: number[];
  /**
   * The read is final up to here: `to`, or less when the last entries are not
   * on the node yet (its inbox head is below them). Read again from here later.
   */
  through: number;
}

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");
/** How many retained checkpoints to probe when confirming an archive. */
const CHECKPOINT_PROBES = 8;
const BLOCK_CACHE = 8;

export class InboxReader {
  readonly archive: InboxArchive;
  /** Entries checked against the chain that the archive cannot take yet (it is not contiguous up to them). */
  private readonly known = new Map<number, ArchivedEntry>();
  /** Chain-proven accumulators at sequences with no entry in hand. */
  private readonly anchors = new Map<number, string>();
  private readonly log: InboxLog;
  /** The archive head when `confirmArchive` last ran. */
  private checkedAt = -1;
  /** Recent blocks, so entries posted in the same block cost one read. */
  private readonly blocks = new Map<number, Promise<Uint8Array[]>>();

  constructor(
    readonly env: InboxEnv,
    readonly source: InboxSource,
    opts: { archive?: InboxArchive; log?: InboxLog } = {},
  ) {
    this.archive = opts.archive ?? new InboxArchive(env);
    this.log = opts.log ?? (() => {});
  }

  /**
   * Entries `from+1 .. to`, each checked against the chain's inbox
   * accumulator. `rangeHash` is a batch's inbox commitment for exactly this
   * range, when the caller has one: it confirms archived rows without any
   * further read. Throws `PrunedEntryError` when an entry is gone from both the
   * chain and the archive, `InboxMismatchError` when anything contradicts the
   * chain.
   */
  async read(from: number, to: number, opts: { rangeHash?: string } = {}): Promise<ArchivedEntry[]> {
    return (await this.walk(from, to, false, opts.rangeHash)).entries;
  }

  /** `read`, as the RDK's entry type. */
  async entries(from: number, to: number, opts: { rangeHash?: string } = {}): Promise<QledgerEntry[]> {
    return (await this.read(from, to, opts)).map(toEntry);
  }

  /**
   * Whatever can still be read in `from+1 .. to`: entries neither the chain
   * nor a confirmed archive holds are listed in `missing` instead of failing
   * the read. After a gap, the next retained entry is anchored on the chain's
   * accumulator for it (its payload is still checked against the committed
   * hash). Retention is not assumed to be monotonic (checkpoints outlive the
   * posts around them). Missing entries at the very end of the range count as
   * pruned only if the node's inbox already holds them; otherwise `through`
   * stops before them, so a node that lags is read again rather than skipped.
   */
  async readAvailable(from: number, to: number): Promise<ReadResult> {
    return this.walk(from, to, true);
  }

  /** The chain-proven accumulator after `sequence`, or undefined if no source has it. */
  async accAt(sequence: number): Promise<string | undefined> {
    const a = await this.startAcc(sequence);
    return a?.trusted ? a.value : undefined;
  }

  /**
   * Confirm as much of the archive as one or two reads can: the commitment at
   * its last row, the inbox's head or consumed accumulator, then the newest
   * retained checkpoints below it. Returns the confirmed head.
   */
  async confirmArchive(): Promise<number> {
    const a = this.archive;
    if (a.head === a.confirmed || this.checkedAt === a.head) return a.confirmed;
    this.checkedAt = a.head;
    const top = a.head;
    const pd = await this.source.postedData(top);
    if (pd) {
      this.commit(top, pd.inboxAcc);
      return a.confirmed;
    }
    const inbox = await this.source.inbox();
    if (top === inbox.headSequence) this.commit(top, inbox.headAcc);
    else if (top === inbox.consumedSequence) this.commit(top, inbox.consumedAcc);
    if (a.confirmed >= top || a.head < top) return a.confirmed;
    const step = QLEDGER_CHECKPOINT_INTERVAL;
    for (let c = Math.floor(top / step) * step, n = 0; c > a.confirmed && c > 0 && n < CHECKPOINT_PROBES; c -= step, n++) {
      const cp = await this.source.postedData(c);
      if (cp) {
        this.commit(c, cp.inboxAcc);
        break;
      }
    }
    return a.confirmed;
  }

  // ------------------------------------------------------------------ internals

  private async walk(from: number, to: number, tolerant: boolean, rangeHash?: string): Promise<ReadResult> {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0) throw new Error(`bad inbox range ${from}..${to}`);
    if (to <= from) return { entries: [], missing: [], through: Math.max(from, to) };
    if (this.archive.confirmed < Math.min(to, this.archive.head) && from < this.archive.head) await this.confirmArchive();

    const start = await this.startAcc(from);
    if (!start && !tolerant) throw new PrunedEntryError(from);
    let prev = start;
    const out: ArchivedEntry[] = [];
    const missing: number[] = [];
    for (let s = from + 1; s <= to; s++) {
      const r = await this.step(s, prev);
      if (r) {
        out.push(r.entry);
        prev = r.acc;
        continue;
      }
      if (!tolerant) throw new PrunedEntryError(s);
      // Archived rows read before the gap can no longer be confirmed by chaining: leave them out too.
      while (out.length > 0 && !this.isTrusted(out.at(-1)!.sequence)) missing.push(out.pop()!.sequence);
      missing.push(s);
      prev = undefined;
    }

    if (prev && !prev.trusted) {
      const confirmed = await this.confirmTail(from, start, to, prev.value, rangeHash);
      if (!confirmed) {
        if (!tolerant) throw new InboxMismatchError(`archived inbox entries up to ${to} cannot be checked: no commitment the chain still holds covers them`);
        while (out.length > 0 && !this.isTrusted(out.at(-1)!.sequence)) missing.push(out.pop()!.sequence);
      }
    }
    missing.sort((x, y) => x - y);
    let through = to;
    const last = out.at(-1)?.sequence ?? from;
    const tail = missing.filter((m) => m > last);
    if (tail.length > 0 && (await this.source.inbox()).headSequence < tail[0]!) {
      through = tail[0]! - 1;
      missing.splice(missing.length - tail.length);
    }
    return { entries: out, missing, through };
  }

  /** Whether the entry at `s` has been checked against the chain. */
  private isTrusted(s: number): boolean {
    return s <= this.archive.confirmed || this.known.has(s);
  }

  /** The accumulator at `from` to start a read with, trusted or (from an unconfirmed archive row) not. */
  private async startAcc(from: number): Promise<Acc | undefined> {
    if (from === 0) return { value: EMPTY_ACC, trusted: true };
    const held = from <= this.archive.confirmed ? this.archive.accAt(from) : (this.known.get(from)?.acc ?? this.anchors.get(from));
    if (held) return { value: held, trusted: true };
    const pd = await this.source.postedData(from);
    if (pd) {
      this.commit(from, pd.inboxAcc);
      return { value: pd.inboxAcc, trusted: true };
    }
    const row = this.archive.accAt(from);
    if (row) return { value: row, trusted: false };
    const inbox = await this.source.inbox();
    if (from === inbox.consumedSequence) return { value: inbox.consumedAcc, trusted: true };
    if (from === inbox.headSequence) return { value: inbox.headAcc, trusted: true };
    return undefined;
  }

  /** Entry `s`, given the accumulator before it (undefined after a gap). Undefined if neither chain nor archive has it. */
  private async step(s: number, prev: Acc | undefined): Promise<{ entry: ArchivedEntry; acc: Acc } | undefined> {
    const held = s <= this.archive.confirmed ? this.archive.row(s) : this.known.get(s);
    if (held) {
      if (prev) this.chainOnto(prev, held, held.acc);
      return { entry: held, acc: { value: held.acc, trusted: true } };
    }

    const pd = await this.source.postedData(s);
    if (pd) {
      const entry = await this.fetchEntry(pd);
      if (prev) this.chainOnto(prev, entry, pd.inboxAcc);
      this.remember(entry);
      return { entry, acc: { value: entry.acc, trusted: true } };
    }

    const row = this.archive.row(s);
    if (!row) return undefined;
    if (prev && accumulate(this.env, prev.value, row) !== row.acc) {
      this.reject(`archived entry ${s} does not chain onto the accumulator before it`);
      throw new InboxMismatchError(`archived inbox entry ${s} does not chain onto the accumulator before it`);
    }
    return { entry: row, acc: { value: row.acc, trusted: false } };
  }

  /** Check that `entry` follows `prev` and gives the chain's accumulator `want`; a match proves `prev` too. */
  private chainOnto(prev: Acc, entry: ArchivedEntry, want: string): void {
    if (accumulate(this.env, prev.value, entry) === want) {
      if (!prev.trusted) this.commit(entry.sequence - 1, prev.value);
      return;
    }
    if (!prev.trusted) {
      this.reject(`the archived entries before ${entry.sequence} do not lead to the chain's inbox accumulator at ${entry.sequence}`);
      throw new InboxMismatchError(`the archived inbox entries before ${entry.sequence} do not match the chain's inbox accumulator`);
    }
    throw new InboxMismatchError(`inbox entry ${entry.sequence} of ${this.env.rollupId} does not match the chain's inbox accumulator`);
  }

  /**
   * The archived rows a read used are not confirmed yet: use the batch's range
   * hash if there is one, else read on past `to` until a chain commitment
   * confirms them (those entries are kept for later reads).
   */
  private async confirmTail(from: number, start: Acc | undefined, to: number, accTo: string, rangeHash?: string): Promise<boolean> {
    if (rangeHash && start) {
      const got = hex(inboxRangeHash({ ...this.env, from, to, accFrom: hexToBytes(start.value), accTo: hexToBytes(accTo) }));
      if (got !== norm(rangeHash)) {
        this.reject(`the archived entries ${from + 1}..${to} do not hash to the batch's inbox range commitment`);
        throw new InboxMismatchError(`the archived inbox entries ${from + 1}..${to} do not match the batch's inbox range commitment`);
      }
      this.commit(from, start.value);
      this.commit(to, accTo);
      return true;
    }
    const inbox = await this.source.inbox();
    let prev: Acc = { value: accTo, trusted: false };
    for (let s = to; ; s++) {
      if (s === inbox.headSequence) this.commit(s, inbox.headAcc);
      else if (s === inbox.consumedSequence) this.commit(s, inbox.consumedAcc);
      if (this.archive.confirmed >= to) return true;
      if (s >= inbox.headSequence) return false;
      const r = await this.step(s + 1, prev);
      if (!r) return false;
      prev = r.acc;
      if (this.archive.confirmed >= to) return true;
    }
  }

  /** The payload for a retained commitment: from the archive when its row matches, else from the block. */
  private async fetchEntry(pd: PostedData): Promise<ArchivedEntry> {
    const s = pd.sequence;
    const entry = (payloadHex: string): ArchivedEntry => ({ sequence: s, height: pd.height, poster: pd.poster, payloadHex, acc: pd.inboxAcc });
    const row = this.archive.row(s) ?? this.known.get(s);
    if (row && row.height === pd.height && row.poster === pd.poster && hex(postedDataHash(hexToBytes(row.payloadHex))) === pd.dataHash) {
      return entry(row.payloadHex);
    }
    let payload: Uint8Array | undefined;
    if (pd.poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX)) {
      const depositor = pd.poster.slice(QLEDGER_DEPOSIT_POSTER_PREFIX.length);
      for (const d of await this.source.deposits(pd.height)) {
        if (d.sequence !== s || d.rollupId !== this.env.rollupId || d.depositor !== depositor || d.account.length !== 64) continue;
        const p = encodeQledgerDeposit(hexToBytes(d.account), d.amount);
        if (hex(postedDataHash(p)) === pd.dataHash) payload = p;
      }
      if (!payload) throw new Error(`deposit ${s} of ${this.env.rollupId}: no rdk_rollup_deposit event at height ${pd.height} matches its commitment`);
    } else {
      payload = findPayload(await this.blockTxs(pd.height), pd.dataHash, pd.size);
      if (!payload) throw new Error(`post ${s} of ${this.env.rollupId}: no transaction at height ${pd.height} carries a payload with the committed hash`);
    }
    return entry(hex(payload));
  }

  private blockTxs(height: number): Promise<Uint8Array[]> {
    let p = this.blocks.get(height);
    if (!p) {
      p = this.source.blockTxs(height);
      p.catch(() => this.blocks.delete(height));
      this.blocks.set(height, p);
      while (this.blocks.size > BLOCK_CACHE) this.blocks.delete(this.blocks.keys().next().value!);
    }
    return p;
  }

  /** Keep a chain-checked entry: in the archive when it extends a confirmed archive, else in memory. */
  private remember(e: ArchivedEntry): void {
    this.commit(e.sequence, e.acc);
    this.anchors.delete(e.sequence);
    const a = this.archive;
    if (a.head === e.sequence - 1 && a.confirmed === a.head) {
      a.appendConfirmed(e);
      this.known.delete(e.sequence);
      for (let s = e.sequence + 1; this.known.has(s); s++) {
        a.appendConfirmed(this.known.get(s)!);
        this.known.delete(s);
      }
    } else if (e.sequence > a.head) {
      this.known.set(e.sequence, e);
    }
  }

  /** A chain commitment: the accumulator at `sequence` is `acc`. Confirms or rejects the archive there. */
  private commit(sequence: number, acc: string): void {
    if (sequence === 0) return;
    const a = this.archive;
    const mine = a.accAt(sequence);
    if (mine === undefined) {
      if (!this.known.has(sequence)) this.anchors.set(sequence, acc);
      return;
    }
    if (mine === acc) {
      a.confirm(sequence);
      // Rows the archive now covers no longer need a copy in memory.
      for (const s of this.known.keys()) if (s <= a.head) this.known.delete(s);
      return;
    }
    if (sequence <= a.confirmed) throw new InboxMismatchError(`the chain's inbox accumulator at ${sequence} changed`);
    this.reject(`archived entry ${sequence} does not match the chain's inbox accumulator`);
  }

  /** Drop every unconfirmed archive row: something in them contradicts the chain. */
  private reject(reason: string): void {
    const keep = this.archive.confirmed;
    const dropped = this.archive.truncate(keep);
    this.checkedAt = -1;
    if (dropped > 0) this.log("inbox_archive_rejected", { reason, dropped, keptThrough: keep, ...(this.archive.path && { path: this.archive.path }) });
  }
}
