/** The sentinel's alert rules, offline: each fires on its condition and only then, and changes are announced once. */
import { describe, expect, it } from "vitest";
import { ACCOUNTS } from "../src/accounts.ts";
import { DEFAULT_THRESHOLDS, diff, evaluate, formatAlert, formatCleared, type Observation } from "../src/rules.ts";

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
});
