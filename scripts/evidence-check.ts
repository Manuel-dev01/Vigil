/**
 * Re-check every numbered EVIDENCE.md row against the chain. Read-only: no key, no transaction.
 *
 * For each row it reads the transaction back (REST for native hashes, `eth_getTransactionReceipt`
 * for 0x hashes) and checks its height, its date where the answer carries one, its result, and the
 * events, logs, gas and fees listed for it in scripts/evidence/expect.ts. Claims a row makes that
 * are not listed there are not checked. The read-only checks, which have no transaction, are listed
 * by command. Requests go out one at a time, at most one a second, because the public endpoints'
 * rate limit is shared with Vigil's live services; a full run makes about 125 requests.
 *
 *   pnpm evidence:check                      print the table (exit codes below)
 *   pnpm evidence:check --write              also save docs/evidence-check.json and docs/evidence-check.md
 *   pnpm evidence:check --summary <file>     also append the Markdown summary to <file> (CI job summary)
 *   pnpm evidence:check --rows 13,60-64      only these rows (cannot be combined with --write)
 *   pnpm evidence:check --cache <dir>        keep each answer in <dir> and reuse it on the next run
 *   pnpm evidence:check --gap-ms 1500        wait longer between requests (at least 1000; anything else is refused)
 *
 * A row whose transaction the node no longer returns is reported "not found", not failed: a node may
 * stop indexing old transactions. The command exits 1 on a mismatch, on a read that failed after
 * retries, or when fewer than half the rows checked were re-verified (so a run that proved little,
 * such as one where the node returns nothing, cannot pass); 2 on a command line it cannot run with.
 */
import { netFetch } from "@vigil/core/net";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, UsageError, type CliOptions } from "./evidence/args.ts";
import { judgeRow, type RowResult } from "./evidence/check.ts";
import { EXPECT } from "./evidence/expect.ts";
import { ChainReader, EVM_RPC, REST, type Fetched } from "./evidence/fetch.ts";
import { parseLedger } from "./evidence/ledger.ts";
import { buildReport, failReasons, toMarkdown, toTable } from "./evidence/report.ts";
import { REPO_ROOT } from "./lib/env.ts";

let cli: CliOptions;
try {
  cli = parseArgs(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exit(2);
}
const { rows: only, gapMs, cache: cacheDir } = cli;

const ledgerText = readFileSync(resolve(REPO_ROOT, "EVIDENCE.md"), "utf8");
const ledger = parseLedger(ledgerText);
const rows = ledger.rows.filter((r) => !only || only.has(r.n));
if (rows.length === 0) {
  console.error(`--rows matched no row of EVIDENCE.md (it has rows 1 to ${ledger.rows.length}).`);
  process.exit(2);
}

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
  requests: reader.requests,
  reusedFromCache: reader.cacheHits,
});

console.log(toTable(report));
console.error(`${reader.requests} requests made${reader.cacheHits ? `; ${reader.cacheHits} answers reused from the cache` : ""}.`);

const markdown = toMarkdown(report);
if (cli.write) {
  const json = JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
  writeFileSync(resolve(REPO_ROOT, "docs/evidence-check.json"), json);
  writeFileSync(resolve(REPO_ROOT, "docs/evidence-check.md"), markdown);
  console.error("Saved docs/evidence-check.json and docs/evidence-check.md.");
}
if (cli.summary) appendFileSync(cli.summary, markdown);

const reasons = failReasons(report.summary);
if (reasons.length > 0) console.error(`Failing: ${reasons.join("; ")}.`);
process.exit(reasons.length > 0 ? 1 : 0);
