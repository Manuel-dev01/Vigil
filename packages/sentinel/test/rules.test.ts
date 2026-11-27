/** The sentinel's alert rules, offline: each fires on its condition and only then, and changes are announced once. */
import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "../src/accounts.ts";
import type { ExitWatch } from "../src/exits.ts";
import type { Verdict } from "../src/judge.ts";
import { DEFAULT_THRESHOLDS, diff, evaluate, formatAlert, formatCleared, repeats, type Observation } from "../src/rules.ts";

const NOW = 1_800_000_000;
const creator = ACCOUNTS.find((a) => a.name.startsWith("Creator"))!;
const relayer = ACCOUNTS.find((a) => a.name === "exit-relayer")!;
const wt2 = ACCOUNTS.find((a) => a.name === "watchtower-2")!;

function healthy(): Observation {
  return {
    now: NOW,
    balances: Object.fromEntries(ACCOUNTS.map((a) => [a.qor1, 100_000_000n])),
    windows: Object.fromEntries(ACCOUNTS.map((a) => [a.qor1, { found: false }])),
    rollup: { inboxHead: 24, batchedThrough: 24, newestBatchAt: NOW - 600, disputed: [] },
    vault: { liquidityWei: 1_000_000_000_000_000_000n, totalOwedWei: 0n },
    web: { ok: true, detail: "commit 3298a1b" },
  };
}

describe("sentinel rules", () => {
  it("say nothing when all is well", () => {
    expect(evaluate(healthy(), ACCOUNTS)).toEqual([]);
  });

  it("flag a window on a key that must never open one as critical, at once", () => {
    const o = healthy();
    o.windows[creator.qor1] = { found: true, seenSince: NOW };
    const c = evaluate(o, ACCOUNTS);
    expect(c).toHaveLength(1);
    expect(c[0]!.severity).toBe("critical");
    expect(formatAlert(c[0]!)).toMatch(/CRITICAL.*must never open one/);
  });

  it("allow the relayer's short windows but flag one that lingers", () => {
    const o = healthy();
    o.windows[relayer.qor1] = { found: true, seenSince: NOW - 120 };
    expect(evaluate(o, ACCOUNTS)).toEqual([]);
    o.windows[relayer.qor1] = { found: true, seenSince: NOW - 900 };
    expect(evaluate(o, ACCOUNTS).map((c) => c.id)).toEqual([`window-lingers:${relayer.qor1}`]);
  });

  it("flag balances below their floor (a watchtower below its challenge reserve)", () => {
    const o = healthy();
    o.balances[wt2.qor1] = 5_900_000n;
    expect(evaluate(o, ACCOUNTS).map((c) => c.id)).toEqual([`balance:${wt2.qor1}`]);
  });

  it("flag a sequencer that leaves entries unbatched, a quiet keep-alive, disputes, an unrepaid vault and a down web app", () => {
    const o = healthy();
    o.rollup = { inboxHead: 26, batchedThrough: 24, oldestUnbatchedAt: NOW - DEFAULT_THRESHOLDS.unbatchedSec - 1, newestBatchAt: NOW - 4 * 86_400, disputed: ["21:challenged"] };
    o.vault = { liquidityWei: 100_000_000_000_000_000n, totalOwedWei: 100_000_000_000_000_000n, owedSince: NOW - 3 * 3600 };
    o.web = { ok: false, detail: "HTTP 502" };
    const ids = evaluate(o, ACCOUNTS).map((c) => c.id).sort();
    expect(ids).toEqual(["disputed:21:challenged", "keepalive-quiet", "sequencer-stuck", "vault-liquidity", "vault-owed", "web-down"].sort());
    expect(evaluate(o, ACCOUNTS).find((c) => c.id === "sequencer-stuck")!.text).toMatch(/2 inbox entries have waited/);
  });

  it("do not flag entries that have waited less than the threshold, or a vault owed only briefly", () => {
    const o = healthy();
    o.rollup = { ...o.rollup, inboxHead: 25, oldestUnbatchedAt: NOW - 60 };
    o.vault = { ...o.vault, totalOwedWei: 1n, owedSince: NOW - 600 };
    expect(evaluate(o, ACCOUNTS)).toEqual([]);
  });

  it("announce a condition once when it starts and once when it clears", () => {
    const o = healthy();
    o.balances[wt2.qor1] = 1n;
    const first = evaluate(o, ACCOUNTS);
    const active = new Map<string, (typeof first)[number]>();
    let d = diff(active, first);
    expect(d.started).toHaveLength(1);
    for (const c of d.started) active.set(c.id, c);
    d = diff(active, evaluate(o, ACCOUNTS));
    expect(d).toEqual({ started: [], cleared: [] });
    d = diff(active, evaluate(healthy(), ACCOUNTS));
    expect(d.cleared.map((c) => c.id)).toEqual([`balance:${wt2.qor1}`]);
    expect(formatCleared(d.cleared[0]!)).toMatch(/^✅ Resolved: watchtower-2 holds/);
  });

  // ------------------------------------------------------------ unchallenged bad batch
  // vigil-pay-1 batch 21 as recorded (test/vectors/inbox-vigil-pay-1.json), judged bad by re-execution.
  const SUBMITTED = 1_795_557_808;
  const bad: Verdict = { batchIndex: 21, stateRoot: "91b0fa6a5d88a8e6e2ef2cd0aaecf91cc9dfa62e95142a1355b47351bd0ca318", status: "submitted", submittedTime: SUBMITTED, kind: "invalid", mismatches: ["stateRoot"], withdrawals: [] };
  const withBad = (now: number, v: Partial<Verdict> = {}): Observation => ({ ...healthy(), now, challengeWindowSec: 3600, judged: [{ ...bad, ...v }] });

  it("say nothing about a bad batch before half its challenge window has passed (the watchtowers have time)", () => {
    expect(evaluate(withBad(SUBMITTED + 1799), ACCOUNTS)).toEqual([]);
  });

  it("alert loudly about a bad batch with no challenge upheld once half the window has passed, and repeat it", () => {
    const c = evaluate(withBad(SUBMITTED + 1800), ACCOUNTS);
    expect(c.map((x) => x.id)).toEqual(["bad-batch:21:91b0fa6a5d88a8e6"]);
    expect(c[0]!.severity).toBe("critical");
    expect(c[0]!.repeatSec).toBe(DEFAULT_THRESHOLDS.badBatchRepeatSec);
    expect(formatAlert(c[0]!)).toMatch(/CRITICAL: UNCHALLENGED BAD BATCH: vigil-pay-1 batch 21 does not re-execute \(stateRoot differs\).*closes in 30 min/);
    expect(formatCleared(c[0]!)).toMatch(/^✅ Resolved: vigil-pay-1 batch 21 is no longer an unchallenged bad batch/);
    expect(evaluate(withBad(SUBMITTED + 4000, { status: "finalized", mismatches: ["withdrawalsRoot", "dataHash"] }), ACCOUNTS)[0]!.text).toMatch(/withdrawalsRoot, dataHash differ.*It is already final/);
  });

  it("stay quiet once a challenge is upheld (the batch is rejected), and about valid batches", () => {
    expect(evaluate(withBad(SUBMITTED + 2000, { status: "rejected" }), ACCOUNTS)).toEqual([]);
    expect(evaluate(withBad(SUBMITTED + 2000, { kind: "valid", mismatches: [] }), ACCOUNTS)).toEqual([]);
  });

  it("repeat only conditions that ask to be repeated, once their interval has passed", () => {
    const [loud] = evaluate(withBad(SUBMITTED + 1800), ACCOUNTS);
    const quiet = { id: "web-down", severity: "warning" as const, text: "x" };
    const said = new Map([
      [loud!.id, 1000],
      [quiet.id, 0],
    ]);
    expect(repeats([loud!, quiet], said, 1000 + 599)).toEqual([]);
    expect(repeats([loud!, quiet], said, 1000 + 600).map((c) => c.id)).toEqual([loud!.id]);
  });

  it("warn when re-execution keeps failing or cannot start, so a blind check is known", () => {
    const o = healthy();
    o.judgeFailures = { count: DEFAULT_THRESHOLDS.judgeFailures - 1, error: "timeout" };
    expect(evaluate(o, ACCOUNTS)).toEqual([]);
    o.judgeFailures.count++;
    expect(evaluate(o, ACCOUNTS).map((c) => c.id)).toEqual(["judge-failed"]);
    const u = withBad(SUBMITTED + 2000, { kind: "unjudged", mismatches: [], reason: "no honest starting state" });
    expect(evaluate(u, ACCOUNTS).map((c) => c.id)).toEqual(["judge-unjudged"]);
  });

  // ------------------------------------------------------------ instant exits not fronted
  // The relayer's first automatic exit (EVIDENCE 99 to 109): batch 18, submitted at 1,795,550,685, fronted 15 s later.
  const BATCH_AT = 1_795_550_685;
  const exit: ExitWatch = {
    batchIndex: 18,
    stateRoot: "e7a18f24df1884b1015e16501bcc866b07a421921b9d841b82d6fa4d3e8c569d",
    withdrawalIndex: 4,
    amountUqor: 100_000n,
    recipient: "qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy",
    payout: "0x7baaa4638c10dfb64d6ae593c2f019782e7773e3",
    batchAt: BATCH_AT,
    exitId: "0x73f5a6e66fff40bcfa053fe15cea24e6ccb3600ef86da829132e8580fa78ccfc",
    fronted: false,
  };
  const withExit = (now: number, x: Partial<ExitWatch> = {}): Observation => ({ ...healthy(), now, exits: [{ ...exit, ...x }] });

  it("warn when an exit the relayer serves is not fronted within 5 minutes of its batch", () => {
    expect(evaluate(withExit(BATCH_AT + 300), ACCOUNTS)).toEqual([]);
    const c = evaluate(withExit(BATCH_AT + 301), ACCOUNTS);
    expect(c.map((x) => x.id)).toEqual(["exit-not-fronted:18:e7a18f24df1884b1:4"]);
    expect(c[0]!.severity).toBe("warning");
    expect(formatAlert(c[0]!)).toMatch(/Batch 18's withdrawal 4 to an exit address was not fronted within 5 min of its batch \(5 min so far\)\. It pays 0\.100 QOR to qor1k44v/);
    expect(formatCleared(c[0]!)).toMatch(/^✅ Resolved: batch 18's withdrawal 4 is no longer waiting for a front/);
  });

  it("say nothing about an exit that was fronted (as this one was, 15 s after its batch), not read, or not meant to be fronted", () => {
    expect(evaluate(withExit(BATCH_AT + 15 + 3600, { fronted: true }), ACCOUNTS)).toEqual([]);
    const unknown = withExit(BATCH_AT + 900);
    delete unknown.exits![0]!.fronted;
    expect(evaluate(unknown, ACCOUNTS)).toEqual([]);
    expect(evaluate(withExit(BATCH_AT + 900, { exempt: "it is below the relayer's minimum exit" }), ACCOUNTS)).toEqual([]);
  });
});

