/**
 * Vigil in numbers: the pure half of `scripts/metrics.ts`.
 *
 * Everything here works on data already read, from the chain or from the committed inbox archive
 * (`data/inbox/vigil-pay-1.jsonl`), so it runs offline and is tested in `scripts/test/metrics.test.ts`.
 * The script does the reading; this module counts, times and writes the tables.
 */
import { QLEDGER_KIND_WITHDRAW, decodeQledgerTx, hexToBytes } from "@qorechain/rdk";

export const METRICS_SCHEMA = "vigil/metrics/v1";
export const UQOR_PER_QOR = 1_000_000n;
/** 1 uqor (the rollup's unit) is 10^12 wei of the same balance on the EVM side. */
export const WEI_PER_UQOR = 1_000_000_000_000n;

// ------------------------------------------------------------------ inputs (what the script reads)

/** The fields of the RDK's BatchView that the numbers use. */
export interface BatchIn {
  batchIndex: number;
  status: string;
  stateRoot: string;
  /** Block height of the submission. */
  submittedAt: number;
  /** Block time of the submission (Unix seconds), 0 when the node does not serve it. */
  submittedTime: number;
  inboxStart: number;
  inboxEnd: number;
}

/** The fields of the RDK's AnchorView that the numbers use. */
export interface AnchorIn {
  layerHeight: number;
  stateRoot: string;
}

/** An inbox entry from the committed archive. */
export interface EntryIn {
  sequence: number;
  height: number;
  poster: string;
  payloadHex: string;
}

/** A `Fronted` event of the InstantExitVault. */
export interface FrontIn {
  batchIndex: number;
  withdrawalIndex: number;
  payout: string;
  paidWei: bigint;
  feeWei: bigint;
  tx: string;
  height: number;
}

// ------------------------------------------------------------------ the snapshot (docs/metrics.json)

export interface BatchCounts {
  /** Batch records the chain lists now. It may delete finalized records after a retention window; their anchors stay. */
  listed: number;
  final: number;
  /** Submitted or challenged, inside their challenge window. */
  pending: number;
  /** Rejected records still listed. The next batch reuses a rejected batch's index, so most rejected ones are not listed. */
  rejectedListed: number;
  latestIndex: number;
  /** Listed batches whose own anchor (layer height = batch index) carries their state root. */
  anchored: number;
  /** Final batches with no anchor of their own: submitted by a bonded standby (only the creator's key anchors). */
  unanchoredFinal: number[];
}

export interface AnchorCounts {
  /** Anchors the chain holds for the rollup's layer. */
  onChain: number;
  /** Anchors whose ML-DSA-87 signature verifies against the creator's key as the node reports it. */
  verified: number;
  /** Layer heights whose anchor did not verify. */
  failed: number[];
  /** Final batches whose own anchor verifies and carries the batch's state root. */
  finalWithVerifiedAnchor: number;
  /** Anchors `SettlementReceiptVerifier` has verified with pqcVerify and recorded on chain. */
  attestedInSolidity: number;
  highestAttested: number;
  conflicts: number;
}

export interface FraudRow {
  batchIndex: number;
  /** The challenge transaction the chain upheld. */
  tx: string;
  height: number;
  challenger: string;
  /** Whether the challenger is one of our watchtowers. */
  ours: boolean;
  /** The forged batch's submission, when we know its transaction (EVIDENCE). */
  forgedTx?: string;
  forgedHeight?: number;
  blocksAfterBatch?: number;
  evidence: number[];
}

export interface StandbyRow {
  batchIndex: number;
  /** The first inbox entry the batch consumed. */
  firstEntry: number;
  postHeight: number;
  submittedHeight: number;
  blocksAfterPost: number;
}

export interface ExitRow {
  batchIndex: number;
  withdrawalIndex: number;
  payout: string;
  amountUqor: string;
  paidUqor: string;
  feeUqor: string;
  frontTx: string;
  frontHeight: number;
  frontTime: string;
  batchHeight: number;
  blocksAfterBatch: number;
  /** The inbox entry that carried the L2 withdrawal, found in the committed archive. */
  postEntry?: number;
  postHeight?: number;
  postTime?: string;
  postToPaidSeconds?: number;
  /** How long before the batch could be final the exit was paid (batch time + challenge window − payment time). */
  secondsBeforeFinal?: number;
}

export interface PayslipRound {
  period: string;
  paymentEntry: number;
  envelopeEntry: number;
  paymentTx: string;
  envelopeTx: string;
  evidence: number[];
  /** QOR spent by the posters of both transactions (gas and data fees), in uqor. */
  spentUqor?: string;
  envelopeBytes?: number;
}

export interface StripItem {
  value: string;
  label: string;
  note: string;
  source: string;
}

export interface Snapshot {
  schema: string;
  rollupId: string;
  chainId: string;
  /** The chain's tip when the numbers were read. */
  asOf: { height: number; time: string };
  /** Read-only requests made for this snapshot. */
  requests: number;
  live: { createdHeight: number; createdTime: string; days: number };
  archive: { entries: number; head: number; confirmedByChain: boolean };
  batches: BatchCounts;
  anchors: AnchorCounts;
  fraud: {
    upheld: FraudRow[];
    /** From watchtower-2's logs, not the chain: EVIDENCE 55. */
    fastPath: { seenAfterBlockSeconds: number; judgedMs: number; broadcastAfterMs: number; evidence: number };
  };
  standby: StandbyRow[];
  exits: {
    rows: ExitRow[];
    frontedUqor: string;
    owedUqor: string;
    /** Share of fronted money already repaid to the vault, or null before any exit. */
    repaidPercent: number | null;
    /** Batches whose challenge window was searched for `Fronted` events. */
    searchedBatches: number[];
  };
  payslips: { sealedEntries: number[]; rounds: PayslipRound[] };
  strip: StripItem[];
}

// ------------------------------------------------------------------ counting

const lower = (s: string): string => s.toLowerCase();

export function countBatches(batches: BatchIn[], anchors: AnchorIn[]): BatchCounts {
  const own = new Map(anchors.map((a) => [a.layerHeight, lower(a.stateRoot)]));
  const isAnchored = (b: BatchIn): boolean => own.get(b.batchIndex) === lower(b.stateRoot);
  const final = batches.filter((b) => b.status === "finalized");
  return {
    listed: batches.length,
    final: final.length,
    pending: batches.filter((b) => b.status === "submitted" || b.status === "challenged").length,
    rejectedListed: batches.filter((b) => b.status === "rejected").length,
    latestIndex: batches.reduce((m, b) => Math.max(m, b.batchIndex), -1),
    anchored: batches.filter(isAnchored).length,
    unanchoredFinal: final
      .filter((b) => !own.has(b.batchIndex))
      .map((b) => b.batchIndex)
      .sort((a, b) => a - b),
  };
}

/** Final batches whose own anchor verified and carries the batch's root. */
export function finalWithVerifiedAnchor(batches: BatchIn[], anchors: AnchorIn[], verifiedHeights: Set<number>): number {
  const own = new Map(anchors.map((a) => [a.layerHeight, lower(a.stateRoot)]));
  return batches.filter((b) => b.status === "finalized" && verifiedHeights.has(b.batchIndex) && own.get(b.batchIndex) === lower(b.stateRoot)).length;
}

/** How soon a standby batch followed the first post it consumed. */
export function standbyRows(batches: BatchIn[], unanchored: number[], entries: EntryIn[]): StandbyRow[] {
  const bySeq = new Map(entries.map((e) => [e.sequence, e]));
  const out: StandbyRow[] = [];
  for (const i of unanchored) {
    const b = batches.find((x) => x.batchIndex === i);
    const first = b ? bySeq.get(b.inboxStart + 1) : undefined;
    if (!b || !first) continue;
    out.push({ batchIndex: i, firstEntry: first.sequence, postHeight: first.height, submittedHeight: b.submittedAt, blocksAfterPost: b.submittedAt - first.height });
  }
  return out;
}

/**
 * The inbox entry that carried an exit's L2 withdrawal: a qledger withdrawal in the batch's inbox range
 * whose recipient is the payout's exit address and whose amount is the exit's.
 */
export function findWithdrawalPost(batch: BatchIn, entries: EntryIn[], exitAddressQor: string, amountUqor: bigint): EntryIn | undefined {
  for (const e of entries) {
    if (e.sequence <= batch.inboxStart || e.sequence > batch.inboxEnd) continue;
    let tx;
    try {
      tx = decodeQledgerTx(hexToBytes(e.payloadHex));
    } catch {
      continue;
    }
    if (!tx || tx.kind !== QLEDGER_KIND_WITHDRAW) continue;
    if (tx.recipient === exitAddressQor && tx.amount === amountUqor) return e;
  }
  return undefined;
}

export const isoUtc = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");

export function exitRow(input: {
  front: FrontIn;
  batch: BatchIn;
  frontTime: number;
  post?: EntryIn;
  postTime?: number;
  challengeWindowSeconds?: number;
}): ExitRow {
  const { front, batch } = input;
  const paid = front.paidWei / WEI_PER_UQOR;
  const fee = front.feeWei / WEI_PER_UQOR;
  const row: ExitRow = {
    batchIndex: front.batchIndex,
    withdrawalIndex: front.withdrawalIndex,
    payout: front.payout,
    amountUqor: String(paid + fee),
    paidUqor: String(paid),
    feeUqor: String(fee),
    frontTx: front.tx,
    frontHeight: front.height,
    frontTime: isoUtc(input.frontTime),
    batchHeight: batch.submittedAt,
    blocksAfterBatch: front.height - batch.submittedAt,
  };
  if (input.post && input.postTime !== undefined) {
    row.postEntry = input.post.sequence;
    row.postHeight = input.post.height;
    row.postTime = isoUtc(input.postTime);
    row.postToPaidSeconds = input.frontTime - input.postTime;
  }
  if (batch.submittedTime > 0 && input.challengeWindowSeconds) {
    row.secondsBeforeFinal = batch.submittedTime + input.challengeWindowSeconds - input.frontTime;
  }
  return row;
}

/** Share of fronted money repaid, in percent with one decimal, or null when nothing was fronted. */
export function repaidPercent(frontedUqor: bigint, owedUqor: bigint): number | null {
  if (frontedUqor <= 0n) return null;
  const repaid = frontedUqor - (owedUqor > frontedUqor ? frontedUqor : owedUqor);
  return Number((repaid * 1000n) / frontedUqor) / 10;
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
}

/** Whole days between two Unix times. */
export const daysBetween = (from: number, to: number): number => Math.floor((to - from) / 86_400);

/** Coins of `denom` spent by `spender` in a transaction, from its `coin_spent` events. */
export function spentBy(events: { type: string; attributes?: { key: string; value: string }[] }[], spender: string, denom = "uqor"): bigint {
  let total = 0n;
  for (const ev of events) {
    if (ev.type !== "coin_spent") continue;
    const a = Object.fromEntries((ev.attributes ?? []).map((x) => [x.key, x.value]));
    if (a["spender"] !== spender) continue;
    for (const coin of String(a["amount"] ?? "").split(",")) {
      const m = /^(\d+)(.+)$/.exec(coin.trim());
      if (m && m[2] === denom) total += BigInt(m[1]!);
    }
  }
  return total;
}

// ------------------------------------------------------------------ words and tables

/** "0.0995 QOR": uqor as QOR, without trailing zeros. */
export function qor(uqor: bigint | string): string {
  const v = BigInt(uqor);
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  const whole = a / UQOR_PER_QOR;
  const frac = (a % UQOR_PER_QOR).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""} QOR`;
}

/** "0.26 QOR": uqor rounded to `places` decimals of QOR, half up. */
export function qorAbout(uqor: bigint | string, places = 2): string {
  const step = 10n ** BigInt(6 - places);
  const v = ((BigInt(uqor) + step / 2n) / step) * step;
  return qor(v);
}

/** "27 Nov 2026" from an ISO time. */
export function dayUtc(iso: string): string {
  const d = new Date(iso);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/** "27 Nov 2026, 09:14 UTC" from an ISO time. */
export function timeUtc(iso: string): string {
  const d = new Date(iso);
  return `${dayUtc(iso)}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const grouped = (n: number): string => n.toLocaleString("en-GB");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The six numbers shown in the README and on the landing page. */
export function buildStrip(s: Omit<Snapshot, "strip">): StripItem[] {
  const read = `chain read ${dayUtc(s.asOf.time)}`;
  const ourFraud = s.fraud.upheld.find((f) => f.ours && f.blocksAfterBatch !== undefined);
  const timed = s.exits.rows.filter((r) => r.postToPaidSeconds !== undefined).map((r) => r.postToPaidSeconds!);
  const fastest = timed.length ? Math.min(...timed) : undefined;
  const rounds = s.payslips.rounds.filter((r) => r.spentUqor !== undefined);
  return [
    {
      value: plural(s.live.days, "day"),
      label: "live on testnet",
      note: `vigil-pay-1 created at block ${grouped(s.live.createdHeight)}, ${dayUtc(s.live.createdTime)}`,
      source: `EVIDENCE 13; ${read}`,
    },
    {
      value: `${s.anchors.verified} of ${s.anchors.onChain}`,
      label: "anchors verify (ML-DSA-87)",
      note: `checked against the creator's key as the node reports it; ${s.anchors.finalWithVerifiedAnchor} final batches carry their own verified anchor`,
      source: read,
    },
    {
      value: String(s.anchors.attestedInSolidity),
      label: "anchors verified in Solidity",
      note: `recorded by SettlementReceiptVerifier through pqcVerify, through layer height ${s.anchors.highestAttested}; ${plural(s.anchors.conflicts, "conflict")}`,
      source: `EVIDENCE 62, 63, 80, 112; ${read}`,
    },
    {
      value: ourFraud ? plural(ourFraud.blocksAfterBatch!, "block") : "not yet exercised",
      label: "from forged batch to upheld challenge",
      note: ourFraud ? `fraud drill 2: batch ${ourFraud.batchIndex}, our watchtower-2's challenge; 1,000 QOR bond slashed` : "no upheld challenge from our watchtowers yet",
      source: ourFraud ? `EVIDENCE ${ourFraud.evidence.join(", ")}` : read,
    },
    {
      value: plural(s.exits.rows.length, "instant exit"),
      label: "paid before finality",
      note:
        s.exits.rows.length === 0
          ? "not yet exercised"
          : `a small sample (n = ${s.exits.rows.length}); the fastest was paid ${fastest} s after its withdrawal was posted; the vault is ${s.exits.repaidPercent ?? 0}% repaid`,
      source: `EVIDENCE 91, 104; ${read}`,
    },
    {
      value: String(s.payslips.sealedEntries.length),
      label: "payslips sealed with ML-KEM-1024",
      note: rounds.length ? `posted in the rollup's inbox; a payment and its payslip cost about ${qorAbout(average(rounds.map((r) => BigInt(r.spentUqor!))))} in fees` : "posted in the rollup's inbox",
      source: `EVIDENCE 37, 115, 122; ${read}`,
    },
  ];
}

const average = (xs: bigint[]): bigint => (xs.length ? xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length) : 0n);

export const README_START = "<!-- metrics:start (written by pnpm --filter @vigil/scripts metrics) -->";
export const README_END = "<!-- metrics:end -->";

/** The README's numbers block: the strip, its date and where the full table is. */
export function renderReadmeStrip(s: Snapshot): string {
  const rows = s.strip.map((i) => `| **${i.value}** ${i.label} | ${i.note} | ${i.source} |`);
  return [
    README_START,
    `Read from the chain at block ${grouped(s.asOf.height)} (${timeUtc(s.asOf.time)}) by \`pnpm --filter @vigil/scripts metrics\`, which makes about ${s.requests} read-only requests. Full table: [docs/METRICS.md](docs/METRICS.md).`,
    "",
    "| Number | What it counts | Source |",
    "|---|---|---|",
    ...rows,
    README_END,
  ].join("\n");
}

/** Replace the block between the markers. Throws if the markers are missing. */
export function replaceBlock(text: string, block: string): string {
  const a = text.indexOf(README_START);
  const b = text.indexOf(README_END);
  if (a < 0 || b < a) throw new Error("the README has no metrics markers");
  return text.slice(0, a) + block + text.slice(b + README_END.length);
}

const txLink = (h: string): string => (h.startsWith("0x") ? `\`${h.slice(0, 10)}…\`` : `[\`${h.slice(0, 8)}…\`](https://explore.qore.network/tx/${h})`);

/** docs/METRICS.md. */
export function renderMarkdown(s: Snapshot): string {
  const L: string[] = [];
  const b = s.batches;
  const a = s.anchors;
  L.push(
    "# Vigil in numbers",
    "",
    `Read from \`${s.chainId}\` at block ${grouped(s.asOf.height)} (${timeUtc(s.asOf.time)}) by [\`scripts/metrics.ts\`](../scripts/metrics.ts), with ${s.requests} read-only requests, about one a second. It reads the chain over its public REST and EVM endpoints and the committed inbox archive, [\`data/inbox/${s.rollupId}.jsonl\`](../data/inbox/${s.rollupId}.jsonl). The numbers are what the node reports; nothing here is signed by us. Re-run it with:`,
    "",
    "```bash",
    "pnpm --filter @vigil/scripts metrics           # rewrites this file, docs/metrics.json and the README's numbers",
    "pnpm --filter @vigil/scripts metrics --dry-run # prints the numbers and writes nothing",
    "```",
    "",
    "## The rollup",
    "",
    "| | |",
    "|---|---|",
    `| Live | ${plural(s.live.days, "day")}: \`${s.rollupId}\` was created at block ${grouped(s.live.createdHeight)}, ${timeUtc(s.live.createdTime)} (EVIDENCE 13) |`,
    `| Batches the chain lists | ${b.listed} (indices 0 to ${b.latestIndex}): ${b.final} final, ${b.pending} inside their challenge window, ${b.rejectedListed} rejected and still listed |`,
    `| Batches carrying their own ML-DSA-87 anchor | ${b.anchored} of ${b.listed} |`,
    `| Final batches with no anchor | ${b.unanchoredFinal.length ? b.unanchoredFinal.map((i) => `batch ${i}`).join(", ") : "none"}: anchoring needs the creator's key, so a batch from the bonded standby has no anchor (EVIDENCE 69) |`,
    `| Inbox entries in the committed archive | ${s.archive.entries} (to entry ${s.archive.head}); ${s.archive.confirmedByChain ? "its last accumulator matches the chain's commitment for that entry" : "**not** confirmed against the chain at this run"} |`,
    "",
    "## Settlement receipts",
    "",
    "| | |",
    "|---|---|",
    `| Anchors on chain | ${a.onChain} |`,
    `| Anchors whose ML-DSA-87 signature verifies | ${a.verified} of ${a.onChain}${a.failed.length ? ` (failed: layer heights ${a.failed.join(", ")})` : ""}. Checked here with the RDK's \`verifySettlementReceipt\` (signature-only mode), against the creator's key as the node reports it |`,
    `| Final batches whose own anchor verifies and carries the batch's state root | ${a.finalWithVerifiedAnchor} |`,
    `| Anchors verified and recorded in Solidity | ${a.attestedInSolidity}, through layer height ${a.highestAttested}, ${plural(a.conflicts, "conflict")} (\`SettlementReceiptVerifier\`, \`pqcVerify\`; EVIDENCE 62, 63, 80, 112). Anyone can record newer ones with \`attest\` |`,
    "",
    "## Fraud caught",
    "",
  );
  if (s.fraud.upheld.length === 0) L.push("No fraud proof has been upheld on this rollup: not yet exercised.", "");
  else {
    L.push("| Forged batch | Challenge upheld | Blocks after the batch | Challenger | Evidence |", "|---|---|---|---|---|");
    for (const f of s.fraud.upheld) {
      L.push(
        `| ${f.batchIndex}${f.forgedTx ? ` (${txLink(f.forgedTx)}, block ${grouped(f.forgedHeight!)})` : ""} | ${txLink(f.tx)}, block ${grouped(f.height)} | ${f.blocksAfterBatch ?? "not known"} | ${f.ours ? `our watchtower \`${f.challenger}\`` : `another team's watcher \`${f.challenger}\``} | ${f.evidence.join(", ")} |`,
      );
    }
    const fp = s.fraud.fastPath;
    L.push(
      "",
      `In fraud drill 2, watchtower-2's logs show it saw the forged batch about ${fp.seenAfterBlockSeconds} s after the block's timestamp, judged it in ${fp.judgedMs} ms and broadcast its challenge ${fp.broadcastAfterMs} ms later (EVIDENCE ${fp.evidence}). Those times come from our logs, not from the chain; the block heights above do.`,
      "",
    );
  }
  L.push("## Standby takeover", "");
  if (s.standby.length === 0) L.push("No final batch without an anchor: not yet exercised.", "");
  else {
    L.push("| Batch | Entry it starts with | Posted at block | Batched at block | Blocks after the post |", "|---|---|---|---|---|");
    for (const r of s.standby) L.push(`| ${r.batchIndex} | ${r.firstEntry} | ${grouped(r.postHeight)} | ${grouped(r.submittedHeight)} | ${r.blocksAfterPost} |`);
    L.push(
      "",
      "The standby waits 30 blocks before it batches. Batch 11 came sooner because of an off-by-one in that wait, fixed in PR #29 (EVIDENCE 69), so the number above is not the designed margin.",
      "",
    );
  }
  const e = s.exits;
  L.push("## Instant exits", "");
  if (e.rows.length === 0) L.push("No exit has been fronted: not yet exercised.", "");
  else {
    L.push(
      `${plural(e.rows.length, "exit")} so far, **a small sample**. Found by searching each withdrawal batch's challenge window for the vault's \`Fronted\` events (batches ${e.searchedBatches.join(", ")}); times are block timestamps.`,
      "",
      "| Batch | Paid | Payment | Blocks after the batch | Posted to paid | Before the batch could be final |",
      "|---|---|---|---|---|---|",
    );
    for (const r of e.rows) {
      L.push(
        `| ${r.batchIndex} (withdrawal ${r.withdrawalIndex}) | ${qor(r.paidUqor)} (fee ${qor(r.feeUqor)}) | ${txLink(r.frontTx)}, block ${grouped(r.frontHeight)} | ${r.blocksAfterBatch} | ${r.postToPaidSeconds !== undefined ? `${r.postToPaidSeconds} s (entry ${r.postEntry}, block ${grouped(r.postHeight!)})` : "the post is not in the committed archive"} | ${r.secondsBeforeFinal !== undefined ? `${grouped(r.secondsBeforeFinal)} s` : "not known"} |`,
      );
    }
    L.push(
      "",
      `Fronted ${qor(e.frontedUqor)} in all; the vault is still owed ${qor(e.owedUqor)}, so ${e.repaidPercent ?? 0}% has been repaid after finality (\`totalOwed\` on the vault, EVIDENCE 95, 108). Seconds here come from block timestamps, so they can differ by a second or two from times in EVIDENCE.md.`,
      "",
    );
  }
  L.push("## Sealed payslips", "");
  L.push(
    `${plural(s.payslips.sealedEntries.length, "QoreSeal envelope")} (ML-KEM-1024 with X25519) in the archive: inbox entries ${s.payslips.sealedEntries.join(", ") || "none"}.`,
    "",
    "| Period | Payment entry | Payslip entry | Payslip size | QOR spent by the posters | Evidence |",
    "|---|---|---|---|---|---|",
  );
  for (const r of s.payslips.rounds) {
    L.push(
      `| ${r.period} | ${r.paymentEntry} (${txLink(r.paymentTx)}) | ${r.envelopeEntry} (${txLink(r.envelopeTx)}) | ${r.envelopeBytes !== undefined ? `${grouped(r.envelopeBytes)} bytes` : "not in the archive"} | ${r.spentUqor !== undefined ? qor(r.spentUqor) : "not served by the node"} | ${r.evidence.join(", ")} |`,
    );
  }
  L.push(
    "",
    "QOR spent is what each transaction's poster paid, from its `coin_spent` events: the gas fee and the chain's fee per posted byte.",
    "",
    "## What this does not show",
    "",
    "- Nearly all traffic on the rollup is ours. These are testnet numbers from a small team, not usage.",
    "- Two instant exits and two fraud drills are small samples.",
    "- The node is trusted to report chain state truthfully; signatures are checked here, the rest is read.",
    "",
  );
  return L.join("\n");
}
