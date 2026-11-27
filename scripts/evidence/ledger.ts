/**
 * Parse EVIDENCE.md into rows. Pure: no network, no file access.
 *
 * Two tables:
 * - the numbered rows (one transaction each): # | Date | Network | Height | Tx hash | Explorer | What it proves | How to re-verify
 * - "Read-only checks" (no transaction):        Date | Network | Height | What it shows | How to re-verify
 */

export type TxKind = "native" | "evm";

export interface TxRow {
  n: number;
  date: string;
  network: string;
  height: number;
  hash: string;
  kind: TxKind;
  proves: string;
  recheck: string;
}

export interface ReadOnlyRow {
  /** Position in the read-only table, from 1 (EVIDENCE.md does not number these rows). */
  index: number;
  date: string;
  network: string;
  /** As written, e.g. "~10,362,910" or "see vector". */
  height: string;
  recheck: string;
}

export interface Ledger {
  rows: TxRow[];
  readOnly: ReadOnlyRow[];
}

const NATIVE_HASH = /^[0-9A-F]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;

/** Split one Markdown table line into its cells. EVIDENCE.md does not escape pipes inside cells. */
export function cells(line: string): string[] {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return [];
  return t
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

const unquote = (s: string) => s.replace(/^`(.*)`$/, "$1");

/** A row may start with a link target, `<a id="r12"></a>12` or `<a id="ro-escrow"></a>2026-11-27`; it is not part of the value. */
const ANCHOR = /^<a\s+id="[^"]*"\s*><\/a>\s*/i;
export const withoutAnchor = (cell: string) => cell.replace(ANCHOR, "");

/** "10,241,702" -> 10241702. Throws on anything else, so a malformed row is loud. */
export function parseHeight(s: string): number {
  const digits = s.replace(/,/g, "");
  if (!/^\d+$/.test(digits)) throw new Error(`not a height: ${s}`);
  return Number(digits);
}

export function parseLedger(markdown: string): Ledger {
  const rows: TxRow[] = [];
  const readOnly: ReadOnlyRow[] = [];
  let section: "numbered" | "readOnly" | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\|\s*#\s*\|/.test(line)) section = "numbered";
    else if (/^##\s+Read-only checks/i.test(line)) section = "readOnly";
    else if (/^##\s/.test(line)) section = undefined;

    const c = cells(line);
    if (c.length > 0) c[0] = withoutAnchor(c[0] as string);
    if (c.length === 0 || /^-+$/.test(c[0]?.replace(/:/g, "") ?? "")) continue;

    if (section === "numbered" && /^\d+$/.test(c[0] ?? "")) {
      if (c.length !== 8) throw new Error(`EVIDENCE row ${c[0]}: expected 8 cells, found ${c.length}`);
      const [n, date, network, height, hashCell, , proves, recheck] = c as [string, string, string, string, string, string, string, string];
      const hash = unquote(hashCell);
      const kind: TxKind | undefined = NATIVE_HASH.test(hash) ? "native" : EVM_HASH.test(hash) ? "evm" : undefined;
      if (!kind) throw new Error(`EVIDENCE row ${n}: not a full transaction hash: ${hashCell}`);
      rows.push({ n: Number(n), date, network, height: parseHeight(height), hash, kind, proves, recheck });
    } else if (section === "readOnly" && /^\d{4}-\d{2}-\d{2}$/.test(c[0] ?? "")) {
      if (c.length !== 5) throw new Error(`EVIDENCE read-only row ${readOnly.length + 1}: expected 5 cells, found ${c.length}`);
      const [date, network, height, , recheck] = c as [string, string, string, string, string];
      readOnly.push({ index: readOnly.length + 1, date, network, height, recheck });
    }
  }

  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.n)) throw new Error(`EVIDENCE row ${r.n} appears twice`);
    seen.add(r.n);
  }
  return { rows, readOnly };
}
