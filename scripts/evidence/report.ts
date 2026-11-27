/**
 * Turn row results into the saved report (docs/evidence-check.json), its short Markdown summary and
 * the terminal table. Pure: no network, no file access.
 */
import type { RowResult, Status } from "./check.ts";
import type { ReadOnlyRow } from "./ledger.ts";

export interface ReadOnlyResult {
  /** Position in EVIDENCE.md's "Read-only checks" table, from 1. */
  index: number;
  date: string;
  height: string;
  status: "by command";
  command: string;
  why: string;
}

export interface Report {
  ledger: { file: "EVIDENCE.md"; sha256: string; rows: number; readOnlyRows: number };
  chain: { network: "qorechain-diana"; rest: string; evmRpc: string; tipHeight: number | null; tipTime: string | null };
  run: { firstRead: string | null; lastRead: string | null; minGapMs: number };
  summary: Record<Status, number> & { rows: number; claimsListed: number; checks: number; checksPassed: number };
  headline: string;
  rows: RowResult[];
  readOnly: ReadOnlyResult[];
}

/** Every backticked command in a "How to re-verify" cell. */
export function commandsOf(recheck: string): string {
  const cmds = [...recheck.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter((c) => !/^[\w./-]+\.json$/.test(c));
  return cmds.length > 0 ? cmds.join("; ") : recheck;
}

/** Read-only rows are listed by command, never passed silently. */
export function readOnlyResults(rows: ReadOnlyRow[]): ReadOnlyResult[] {
  return rows.map((r) => ({
    index: r.index,
    date: r.date,
    height: r.height,
    status: "by command" as const,
    command: commandsOf(r.recheck),
    why: /needs the .*key/i.test(r.recheck)
      ? "it signs a test message, so it needs a key this check does not hold"
      : /spike:b/.test(r.recheck)
        ? "it calls the PQC precompiles with crafted inputs: a separate probe, not a read-back of a transaction"
        : "it replays batches from chain data, which takes far more reads than this check makes at one a second",
  }));
}

/** [1,2,3,5,7,8] -> "1 to 3, 5, 7 and 8" */
export function ranges(ns: number[]): string {
  if (ns.length === 0) return "none";
  const sorted = [...ns].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const n of [...sorted.slice(1), Number.NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : prev === start + 1 ? `${start}, ${prev}` : `${start} to ${prev}`);
    start = n;
    prev = n;
  }
  return parts.length === 1 ? (parts[0] as string) : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-27T16:42:57.89Z" -> "27 Nov 2026, 16:42 UTC" */
export function utc(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

const fmt = (n: number) => n.toLocaleString("en-GB");

export function buildReport(input: {
  ledgerSha256: string;
  /** Numbered rows in EVIDENCE.md (more than `rows` when only some were checked). */
  ledgerRows?: number;
  rows: RowResult[];
  readOnly: ReadOnlyRow[];
  rest: string;
  evmRpc: string;
  tipHeight: number | null;
  tipTime: string | null;
  readTimes: string[];
  minGapMs: number;
}): Report {
  const count = (s: Status) => input.rows.filter((r) => r.status === s).length;
  const checks = input.rows.flatMap((r) => r.checks);
  const times = [...input.readTimes].sort();
  const summary = {
    rows: input.rows.length,
    verified: count("verified"),
    mismatch: count("mismatch"),
    "not found": count("not found"),
    error: count("error"),
    claimsListed: input.rows.filter((r) => r.claimsListed).length,
    checks: checks.length,
    checksPassed: checks.filter((c) => c.ok).length,
  };
  const at =
    input.tipHeight !== null && input.tipTime !== null ? ` at height ${fmt(input.tipHeight)} (${utc(input.tipTime)})` : "";
  return {
    ledger: { file: "EVIDENCE.md", sha256: input.ledgerSha256, rows: input.ledgerRows ?? input.rows.length, readOnlyRows: input.readOnly.length },
    chain: { network: "qorechain-diana", rest: input.rest, evmRpc: input.evmRpc, tipHeight: input.tipHeight, tipTime: input.tipTime },
    run: { firstRead: times[0] ?? null, lastRead: times.at(-1) ?? null, minGapMs: input.minGapMs },
    summary,
    headline: `${summary.verified} of ${summary.rows} rows re-verified${at}, as the node reports`,
    rows: input.rows,
    readOnly: readOnlyResults(input.readOnly),
  };
}

const REPO = "https://github.com/Manuel-dev01/Vigil/blob/main";

const STATUS_ORDER: Status[] = ["verified", "mismatch", "not found", "error"];

/** The short Markdown summary: docs/evidence-check.md, and the scheduled run's job summary. */
export function toMarkdown(r: Report): string {
  const s = r.summary;
  const rowsWith = (st: Status) => r.rows.filter((x) => x.status === st).map((x) => x.n);
  const failed = r.rows.filter((x) => x.status !== "verified");
  const genericOnly = r.rows.filter((x) => !x.claimsListed).map((x) => x.n);
  const window =
    r.run.firstRead && r.run.lastRead ? ` between ${utc(r.run.firstRead)} and ${utc(r.run.lastRead).replace(/^.*, /, "")}` : "";
  const failures = (x: RowResult) =>
    x.note ?? x.checks.filter((c) => !c.ok).map((c) => `${c.what}: expected ${c.expected ?? "?"}, got ${c.actual ?? "?"}`).join("; ");

  const lines = [
    "# Evidence check",
    "",
    `**${r.headline}.**${r.readOnly.length ? ` The ${r.readOnly.length} read-only checks are listed by command below.` : ""}`,
    "",
    `\`pnpm evidence:check\` (\`scripts/evidence-check.ts\`) read ${s.rows === r.ledger.rows ? "every numbered row" : `rows ${ranges(r.rows.map((x) => x.n))}`} of [EVIDENCE.md](${REPO}/EVIDENCE.md) (sha256 \`${r.ledger.sha256.slice(0, 16)}…\`) back from the chain${window}: \`GET /cosmos/tx/v1beta1/txs/{hash}\` on ${r.chain.rest} for native transactions and \`eth_getTransactionReceipt\` on ${r.chain.evmRpc} for EVM ones, one request at a time and at most one a second. No key, no transaction. Full results: [docs/evidence-check.json](${REPO}/docs/evidence-check.json).`,
    "",
    "A row counts as re-verified when the node returns its transaction and:",
    "- its height is the row's, and so is its date (UTC) wherever the answer carries a time (an EVM receipt has one only in its logs);",
    "- it succeeded, or failed with the code the row records;",
    `- every event, log, gas figure and fee the row claims, as listed in \`scripts/evidence/expect.ts\`, is there with the row's values (${fmt(s.checksPassed)} of ${fmt(s.checks)} checks passed).`,
    "",
    "It does not re-read chain state that changes over time (balances, bonds, contract records); each row's \"How to re-verify\" column has the command for that. It trusts the node to report the chain truthfully.",
    "",
    "| Result | Rows |",
    "|---|---|",
    ...STATUS_ORDER.map((st) => `| ${st} | ${ranges(rowsWith(st))} |`),
  ];
  if (genericOnly.length > 0) {
    lines.push("", `Rows with no claims listed in \`expect.ts\`, so only the height, date and result were checked: ${ranges(genericOnly)}.`);
  }
  if (failed.length > 0) {
    lines.push("", "## Rows not re-verified", "", "| Row | Result | Detail |", "|---|---|---|");
    for (const x of failed) lines.push(`| ${x.n} | ${x.status} | ${failures(x).replace(/\|/g, "\\|")} |`);
  }
  if (r.readOnly.length > 0) {
    lines.push(
      "",
      "## Read-only checks (by command)",
      "",
      "These rows of EVIDENCE.md have no transaction. Re-run them yourself; none needs a key except where noted.",
      "",
      "| # | Date (UTC) | Height | Command | Not run here because |",
      "|---|---|---|---|---|",
      ...r.readOnly.map((x) => `| ${x.index} | ${x.date} | ${x.height} | \`${x.command.replace(/`/g, "")}\` | ${x.why} |`),
    );
  }
  return lines.join("\n") + "\n";
}

/** The terminal table: one line per row, failures spelled out. */
export function toTable(r: Report): string {
  const out = ["row  kind    result      checks"];
  for (const x of r.rows) {
    const passed = x.checks.filter((c) => c.ok).length;
    const detail = x.status === "verified" ? "" : `  ${x.note ?? x.checks.filter((c) => !c.ok).map((c) => `${c.what}: expected ${c.expected}, got ${c.actual}`).join("; ")}`;
    out.push(`${String(x.n).padEnd(5)}${x.kind.padEnd(8)}${x.status.padEnd(12)}${`${passed}/${x.checks.length}`.padEnd(6)}${x.claimsListed ? "" : " (generic only)"}${detail}`);
  }
  for (const x of r.readOnly) out.push(`R${String(x.index).padEnd(4)}read    by command  ${x.command}`);
  out.push("", r.headline);
  return out.join("\n");
}
