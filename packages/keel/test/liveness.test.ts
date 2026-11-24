/** Keel's heartbeat: never silent about failing or hanging passes, or a low balance. */
import { describe, expect, it } from "vitest";
import { Liveness } from "../src/liveness.ts";

const MIN = 60_000;

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("keel liveness", () => {
  it("is info while passes succeed and the balance is fine", () => {
    const c = clock();
    const l = new Liveness({ stuckMs: 30 * MIN, lowBalanceUqor: 5_000_000n }, c.now);
    l.passStarted();
    l.passSucceeded("idle");
    c.advance(10 * MIN);
    const b = l.beat({ balanceUqor: 9_000_000n });
    expect(b.level).toBe("info");
    expect(b.fields).toMatchObject({ lastPass: "idle", lastSuccessSecAgo: 600, balanceUqor: 9_000_000n });
  });

  it("warns with the reason when the last pass failed, and errors once nothing has succeeded for a while", () => {
    const c = clock();
    const l = new Liveness({ stuckMs: 30 * MIN, lowBalanceUqor: 5_000_000n }, c.now);
    l.passSucceeded("submitted");
    for (let i = 0; i < 3; i++) {
      c.advance(MIN);
      l.passStarted();
      l.passFailed("GET /qorechain/rdk/v1/inbox/vigil-pay-1 -> HTTP 502");
    }
    let b = l.beat({ balanceUqor: 9_000_000n });
    expect(b.level).toBe("warn");
    expect(b.fields).toMatchObject({ lastPass: "failed", consecutiveFailures: 3, lastError: "GET /qorechain/rdk/v1/inbox/vigil-pay-1 -> HTTP 502" });
    c.advance(30 * MIN);
    b = l.beat({ balanceUqor: 9_000_000n });
    expect(b.level).toBe("error");
    expect(b.fields["stuck"]).toBe(true);
    l.passSucceeded("idle");
    expect(l.beat({ balanceUqor: 9_000_000n }).level).toBe("info");
  });

  it("reports a pass that hangs", () => {
    const c = clock();
    const l = new Liveness({ stuckMs: 30 * MIN, lowBalanceUqor: 5_000_000n }, c.now);
    l.passSucceeded("idle");
    l.passStarted();
    c.advance(31 * MIN);
    const b = l.beat({ balanceUqor: 9_000_000n });
    expect(b.level).toBe("error");
    expect(b.fields).toMatchObject({ passRunningSec: 31 * 60, stuck: true });
  });

  it("warns about a low or unreadable balance even when passes succeed", () => {
    const c = clock();
    const l = new Liveness({ stuckMs: 30 * MIN, lowBalanceUqor: 5_000_000n }, c.now);
    l.passSucceeded("idle");
    expect(l.beat({ balanceUqor: 4_999_999n })).toMatchObject({ level: "warn", fields: { lowBalance: true } });
    expect(l.beat({ balanceError: "timed out" })).toMatchObject({ level: "warn", fields: { balanceError: "timed out" } });
  });

  it("says so when no pass has succeeded since start", () => {
    const c = clock();
    const l = new Liveness({ stuckMs: 30 * MIN, lowBalanceUqor: 5_000_000n }, c.now);
    l.passStarted();
    l.passFailed("could not plan");
    c.advance(5 * MIN);
    expect(l.beat({ balanceUqor: 9_000_000n }).fields).toMatchObject({ noSuccessSinceStartSec: 300, lastPass: "failed" });
  });
});
