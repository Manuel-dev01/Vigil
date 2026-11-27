/**
 * The evidence check's command line. Pure: a mistyped flag is refused here rather than read as
 * something else (a missing value must not swallow the next flag, and a gap that is not a number must
 * not switch the throttle off).
 */
import { MIN_GAP_MS } from "./fetch.ts";

export interface CliOptions {
  write: boolean;
  /** Only these rows; undefined means every row. */
  rows?: Set<number>;
  summary?: string;
  cache?: string;
  gapMs: number;
}

/** A command line the check cannot run with. The CLI prints the message and exits 2. */
export class UsageError extends Error {}

const WITH_VALUE = new Set(["--rows", "--summary", "--cache", "--gap-ms"]);
const SWITCHES = new Set(["--write"]);

/** "13,60-64" -> {13, 60, 61, 62, 63, 64} */
export function parseRows(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new UsageError(`--rows: cannot read "${part}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(n);
  }
  return out;
}

export function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") continue; // `pnpm evidence:check -- --rows 44`
    if (SWITCHES.has(a)) {
      write = true;
    } else if (WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      values.set(a, v);
      i++;
    } else {
      throw new UsageError(`unknown argument "${a}" (flags: --write, --rows, --summary, --cache, --gap-ms)`);
    }
  }

  const rowsSpec = values.get("--rows");
  const rows = rowsSpec !== undefined ? parseRows(rowsSpec) : undefined;
  if (rows && write) throw new UsageError("--write saves the full report; run it without --rows.");

  let gapMs = MIN_GAP_MS;
  const gap = values.get("--gap-ms");
  if (gap !== undefined) {
    gapMs = /^\d+$/.test(gap) ? Number(gap) : Number.NaN;
    if (!Number.isFinite(gapMs) || gapMs < MIN_GAP_MS) {
      throw new UsageError(`--gap-ms takes a whole number of milliseconds, at least ${MIN_GAP_MS} (got "${gap}")`);
    }
  }

  const summary = values.get("--summary");
  const cache = values.get("--cache");
  return { write, gapMs, ...(rows ? { rows } : {}), ...(summary !== undefined ? { summary } : {}), ...(cache !== undefined ? { cache } : {}) };
}
