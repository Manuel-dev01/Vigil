/**
 * Re-check every numbered EVIDENCE.md row against the chain. Read-only: no key, no transaction.
 *
 * For each row it reads the transaction back (REST for native hashes, `eth_getTransactionReceipt`
 * for 0x hashes) and checks its height, date, result, and the events, logs, gas and fees the row
 * claims (scripts/evidence/expect.ts). The read-only checks, which have no transaction, are listed
 * by command. Requests go out one at a time, at most one a second, because the public endpoints'
 * rate limit is shared with Vigil's live services; a full run makes about 125 requests.
 *
 *   pnpm evidence:check                      print the table; exit 1 on a mismatch or a failed read
 *   pnpm evidence:check --write              also save docs/evidence-check.json and docs/evidence-check.md
 *   pnpm evidence:check --summary <file>     also append the Markdown summary to <file> (CI job summary)
 *   pnpm evidence:check --rows 13,60-64      only these rows (cannot be combined with --write)
 *   pnpm evidence:check --cache <dir>        keep each answer in <dir> and reuse it on the next run
 *   pnpm evidence:check --gap-ms 1500        wait longer between requests (never less than 1000)
 *
 * A row whose transaction the node no longer returns is reported "not found", not failed: a node may
 * stop indexing old transactions. "not found" does not change the exit code; a mismatch or a read
 * that failed after retries does.
 */
import { netFetch } from "@vigil/core/net";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { judgeRow, type RowResult } from "./evidence/check.ts";
import { EXPECT } from "./evidence/expect.ts";
import { ChainReader, EVM_RPC, MIN_GAP_MS, REST, type Fetched } from "./evidence/fetch.ts";
import { parseLedger } from "./evidence/ledger.ts";
import { buildReport, toMarkdown, toTable } from "./evidence/report.ts";
import { REPO_ROOT } from "./lib/env.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (flag(f) ? args[args.indexOf(f) + 1] : undefined);

/** "13,60-64" -> {13, 60, 61, 62, 63, 64} */
function parseRows(spec: string): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`--rows: cannot read "${part}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.add(n);
  }
  return out;
}

const rowsSpec = opt("--rows");
const only = rowsSpec ? parseRows(rowsSpec) : undefined;
if (only && flag("--write")) {
  console.error("--write saves the full report; run it without --rows.");
  process.exit(2);
}
const gapMs = Math.max(MIN_GAP_MS, Number(opt("--gap-ms") ?? MIN_GAP_MS));
const cacheDir = opt("--cache");

const ledgerText = readFileSync(resolve(REPO_ROOT, "EVIDENCE.md"), "utf8");
const ledger = parseLedger(ledgerText);
const rows = ledger.rows.filter((r) => !only || only.has(r.n));

const reader = new ChainReader({
  fetchFn: netFetch,
  gapMs,
  ...(cacheDir ? { cacheDir: resolve(cacheDir) } : {}),
  log: (l) => console.error(l),
});
console.error(`Reading ${rows.length} transactions from ${REST} and ${EVM_RPC}, one request at a time (${gapMs} ms apart)…`);

const readTimes: string[] = [];
const tip: Fetched = await reader.tip();
readTimes.push(tip.fetchedAt);
const header = (tip.body as { block?: { header?: { height?: string; time?: string } } })?.block?.header;
const tipHeight = tip.httpStatus === 200 && header?.height ? Number(header.height) : null;
const tipTime = tip.httpStatus === 200 && header?.time ? header.time : null;

const results: RowResult[] = [];
for (const row of rows) {
  const f = row.kind === "native" ? await reader.nativeTx(row.hash) : await reader.evmReceipt(row.hash);
  readTimes.push(f.fetchedAt);
  const r = judgeRow(row, EXPECT[row.n], f);
  results.push(r);
  if (r.status !== "verified") console.error(`  row ${r.n}: ${r.status}${r.note ? ` (${r.note})` : ""}`);
}

const report = buildReport({
  ledgerSha256: createHash("sha256").update(ledgerText).digest("hex"),
  ledgerRows: ledger.rows.length,
  rows: results,
  readOnly: only ? [] : ledger.readOnly,
  rest: REST,
  evmRpc: EVM_RPC,
  tipHeight,
  tipTime,
  readTimes,
  minGapMs: gapMs,
});

console.log(toTable(report));
console.error(`${reader.requests} requests made.`);

const markdown = toMarkdown(report);
if (flag("--write")) {
  const json = JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
  writeFileSync(resolve(REPO_ROOT, "docs/evidence-check.json"), json);
  writeFileSync(resolve(REPO_ROOT, "docs/evidence-check.md"), markdown);
  console.error("Saved docs/evidence-check.json and docs/evidence-check.md.");
}
const summaryFile = opt("--summary");
if (summaryFile) appendFileSync(summaryFile, markdown);

process.exit(report.summary.mismatch > 0 || report.summary.error > 0 ? 1 : 0);
