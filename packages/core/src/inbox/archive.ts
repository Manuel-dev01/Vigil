/**
 * An inbox archive: every entry of a rollup's inbox from sequence 1, one JSON
 * line each, with the chain's inbox accumulator after it. The chain keeps a
 * post's commitment only for `posted_data_retention_blocks` (648,000 blocks
 * on testnet) and the payload lives in block history; with an archive a
 * service can still rebuild the rollup after both are gone.
 *
 * The format is the watchtower's (`sequence`, `height`, `poster`,
 * `payloadHex`, `acc`), so either archive can seed the other.
 *
 * Rows are only ever trusted once a commitment the chain still holds confirms
 * them. On load the rows must chain from the empty accumulator (an edited row
 * with its own accumulator left alone stops the archive there); the reader then
 * confirms the chain against the chain's own accumulators. Because each
 * accumulator hashes the previous one, matching the chain at sequence `n`
 * confirms every row up to `n`. An archive file only ever receives confirmed
 * rows; rows that a chain commitment contradicts are dropped, and a file that
 * held them is rewritten (the old one is kept beside it as `.rejected`).
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EMPTY_INBOX_ACC, bytesToHex, hexToBytes, inboxAccumulate, postedDataHash, type QledgerEntry } from "@qorechain/rdk";

export interface InboxEnv {
  chainId: string;
  rollupId: string;
}

export interface ArchivedEntry {
  sequence: number;
  height: number;
  poster: string;
  payloadHex: string;
  /** The chain's inbox accumulator after this entry (hex). */
  acc: string;
}

export const EMPTY_ACC = bytesToHex(EMPTY_INBOX_ACC).toLowerCase();

export const toEntry = (a: ArchivedEntry): QledgerEntry => ({ height: BigInt(a.height), poster: a.poster, payload: hexToBytes(a.payloadHex) });

const isHex = (s: unknown): s is string => typeof s === "string" && s.length % 2 === 0 && /^[0-9a-f]*$/.test(s);

/** The accumulator after an entry, from the one before it (all hex). `dataHash` saves hashing the payload again. */
export function accumulate(env: InboxEnv, prevAcc: string, e: { sequence: number; height: number; poster: string; payloadHex?: string; dataHash?: string }): string {
  const dataHash = e.dataHash ?? bytesToHex(postedDataHash(hexToBytes(e.payloadHex ?? ""))).toLowerCase();
  return bytesToHex(
    inboxAccumulate({ ...env, prevAcc: hexToBytes(prevAcc), sequence: BigInt(e.sequence), height: BigInt(e.height), poster: e.poster, dataHash: hexToBytes(dataHash) }),
  ).toLowerCase();
}

/** Parse archive lines; stops at the first line that is not a well-formed row (a torn last write, say) and says why. */
export function parseArchive(text: string): { rows: ArchivedEntry[]; problem?: string } {
  const rows: ArchivedEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let r: Partial<ArchivedEntry>;
    try {
      r = JSON.parse(line) as Partial<ArchivedEntry>;
    } catch {
      return { rows, problem: `line ${i + 1} is not JSON` };
    }
    const row = {
      sequence: Number(r.sequence),
      height: Number(r.height),
      poster: String(r.poster ?? ""),
      payloadHex: String(r.payloadHex ?? "").toLowerCase(),
      acc: String(r.acc ?? "").toLowerCase(),
    };
    if (!Number.isInteger(row.sequence) || !Number.isInteger(row.height) || row.height < 0 || !row.poster || !isHex(row.payloadHex) || !isHex(row.acc) || row.acc.length !== 64) {
      return { rows, problem: `line ${i + 1} is not an archive row` };
    }
    rows.push(row);
  }
  return { rows };
}

export function readArchiveFile(path: string): { rows: ArchivedEntry[]; problem?: string } {
  if (!existsSync(path)) return { rows: [] };
  return parseArchive(readFileSync(path, "utf8"));
}

export class InboxArchive {
  private readonly rows: ArchivedEntry[] = [];
  private confirmedThrough = 0;
  /** Rows 1..written are in the file. */
  private written = 0;
  /** What loading found wrong with the file, if anything (for the caller to log). */
  readonly loadProblem?: string;

  constructor(
    readonly env: InboxEnv,
    /** JSONL file to keep confirmed rows in, or undefined for memory only. */
    readonly path?: string,
  ) {
    if (!path) return;
    const { rows, problem } = readArchiveFile(path);
    const { problem: chainProblem } = this.extend(rows);
    this.written = this.rows.length;
    const why = problem ?? chainProblem;
    if (why) {
      this.loadProblem = `${path}: ${why}; kept the ${this.rows.length} rows before it`;
      this.rewrite();
    }
  }

  /** The highest sequence held (rows are contiguous from 1). */
  get head(): number {
    return this.rows.length;
  }

  /** Rows up to here matched a commitment the chain holds. */
  get confirmed(): number {
    return this.confirmedThrough;
  }

  row(sequence: number): ArchivedEntry | undefined {
    return sequence >= 1 ? this.rows[sequence - 1] : undefined;
  }

  /** The accumulator after `sequence` (the empty accumulator for 0), if held. */
  accAt(sequence: number): string | undefined {
    return sequence === 0 ? EMPTY_ACC : this.rows[sequence - 1]?.acc;
  }

  /**
   * Add rows after the head, unconfirmed. Rows at or below the head are
   * skipped; adding stops at a gap or at the first row that does not chain
   * onto the accumulator before it.
   */
  extend(rows: Iterable<ArchivedEntry>): { added: number; problem?: string } {
    let added = 0;
    for (const r of [...rows].sort((a, b) => a.sequence - b.sequence)) {
      if (r.sequence <= this.head) continue;
      if (r.sequence !== this.head + 1) return { added, problem: `gap before sequence ${r.sequence} (archive ends at ${this.head})` };
      if (accumulate(this.env, this.accAt(this.head)!, r) !== r.acc.toLowerCase()) {
        return { added, problem: `row ${r.sequence} does not chain onto the accumulator before it` };
      }
      this.rows.push({ ...r, payloadHex: r.payloadHex.toLowerCase(), acc: r.acc.toLowerCase() });
      added++;
    }
    return { added };
  }

  /** Append one entry the caller has already checked against the chain (it must chain onto a confirmed head). */
  appendConfirmed(e: ArchivedEntry): void {
    if (e.sequence !== this.head + 1 || this.confirmedThrough !== this.head) throw new Error(`archive: cannot append ${e.sequence} as confirmed after ${this.head} (confirmed ${this.confirmedThrough})`);
    if (accumulate(this.env, this.accAt(this.head)!, e) !== e.acc) throw new Error(`archive: entry ${e.sequence} does not chain onto the archive`);
    this.rows.push(e);
    this.confirm(e.sequence);
  }

  /** A chain commitment matched the accumulator at `sequence`: every row up to it is confirmed (and written). */
  confirm(sequence: number): void {
    if (sequence <= this.confirmedThrough || sequence > this.head) return;
    this.confirmedThrough = sequence;
    this.flush();
  }

  /** Drop every row after `sequence` (a chain commitment contradicted them). */
  truncate(sequence: number): number {
    const dropped = Math.max(0, this.rows.length - sequence);
    if (dropped === 0) return 0;
    this.rows.length = sequence;
    this.confirmedThrough = Math.min(this.confirmedThrough, sequence);
    if (this.written > sequence) this.rewrite();
    return dropped;
  }

  /** Rows `from+1 .. to`, which must all be held. */
  range(from: number, to: number): ArchivedEntry[] {
    const out: ArchivedEntry[] = [];
    for (let s = from + 1; s <= to; s++) {
      const r = this.rows[s - 1];
      if (!r) throw new Error(`archive is missing entry ${s}`);
      out.push(r);
    }
    return out;
  }

  private flush(): void {
    if (!this.path || this.confirmedThrough <= this.written) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const lines = this.rows.slice(this.written, this.confirmedThrough).map((r) => JSON.stringify(r) + "\n");
    appendFileSync(this.path, lines.join(""));
    this.written = this.confirmedThrough;
  }

  /** Replace the file with the rows held that it may keep; the old file is kept as `.rejected`. */
  private rewrite(): void {
    if (!this.path) return;
    if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.rejected`);
    const keep = this.rows.slice(0, Math.min(this.rows.length, Math.max(this.written, this.confirmedThrough)));
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, keep.map((r) => JSON.stringify(r) + "\n").join(""));
    renameSync(tmp, this.path);
    this.written = keep.length;
  }
}
