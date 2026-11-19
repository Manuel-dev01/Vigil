/**
 * Data-availability archive: every inbox entry of a rollup, append-only, one
 * JSON line per entry. QoreChain keeps only commitments; the payloads live in
 * block history, which nodes may prune (posted_data_retention_blocks). With the
 * archive, the watchtower can still re-execute and challenge after that.
 *
 * On load, every entry is re-checked against the chain's own inbox accumulator
 * chain (`qledgerAccumulate`, starting from the empty accumulator), so a
 * corrupted or edited archive is refused rather than trusted.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { EMPTY_INBOX_ACC, bytesToHex, hexToBytes, qledgerAccumulate, type QledgerEntry } from "@qorechain/rdk";
import type { RollupEnv } from "./check.ts";

export interface ArchivedEntry {
  sequence: number;
  height: number;
  poster: string;
  payloadHex: string;
  /** The chain's inbox accumulator after this entry (hex). */
  acc: string;
}

export const toEntry = (a: ArchivedEntry): QledgerEntry => ({
  height: BigInt(a.height),
  poster: a.poster,
  payload: hexToBytes(a.payloadHex),
});

export class InboxArchive {
  private readonly entries = new Map<number, ArchivedEntry>();

  constructor(
    private readonly env: RollupEnv,
    /** JSONL path, or undefined for memory only. */
    private readonly path?: string,
  ) {
    if (path && existsSync(path)) this.load(path);
  }

  private load(path: string): void {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
    const rows = lines.map((l) => JSON.parse(l) as ArchivedEntry).sort((a, b) => a.sequence - b.sequence);
    let prev = bytesToHex(EMPTY_INBOX_ACC).toLowerCase();
    let expected = 1;
    for (const r of rows) {
      if (r.sequence !== expected) throw new Error(`${path}: gap or duplicate at sequence ${r.sequence} (expected ${expected})`);
      const acc = bytesToHex(qledgerAccumulate({ ...this.env, from: r.sequence - 1, accFrom: prev, entries: [toEntry(r)] })).toLowerCase();
      if (acc !== r.acc.toLowerCase()) throw new Error(`${path}: entry ${r.sequence} does not match its inbox accumulator`);
      this.entries.set(r.sequence, r);
      prev = acc;
      expected++;
    }
  }

  /** Highest contiguous sequence held (0 if none). */
  get head(): number {
    return this.entries.size;
  }

  get(sequence: number): ArchivedEntry | undefined {
    return this.entries.get(sequence);
  }

  /** Accumulator after `sequence` (the empty accumulator for 0), if held. */
  accAt(sequence: number): string | undefined {
    if (sequence === 0) return bytesToHex(EMPTY_INBOX_ACC).toLowerCase();
    return this.entries.get(sequence)?.acc;
  }

  /** Append entries `head+1 ..` in order; each must chain onto the previous accumulator. */
  append(rows: ArchivedEntry[]): void {
    for (const r of [...rows].sort((a, b) => a.sequence - b.sequence)) {
      if (this.entries.has(r.sequence)) continue;
      if (r.sequence !== this.head + 1) throw new Error(`append out of order: ${r.sequence} after ${this.head}`);
      const prev = this.accAt(this.head)!;
      const acc = bytesToHex(qledgerAccumulate({ ...this.env, from: r.sequence - 1, accFrom: prev, entries: [toEntry(r)] })).toLowerCase();
      if (acc !== r.acc.toLowerCase()) throw new Error(`entry ${r.sequence} does not match its inbox accumulator`);
      this.entries.set(r.sequence, r);
      if (this.path) {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, JSON.stringify(r) + "\n");
      }
    }
  }

  range(from: number, to: number): QledgerEntry[] {
    const out: QledgerEntry[] = [];
    for (let s = from + 1; s <= to; s++) {
      const e = this.entries.get(s);
      if (!e) throw new Error(`archive is missing entry ${s}`);
      out.push(toEntry(e));
    }
    return out;
  }
}
