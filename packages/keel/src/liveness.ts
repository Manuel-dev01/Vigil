/**
 * What Keel's heartbeat reports. The heartbeat runs on its own timer, so a
 * Keel whose passes keep failing, or whose pass hangs, still says so every
 * interval: the last pass's outcome and reason, how long since one succeeded,
 * and how long the current pass has been running.
 *
 * Level: `error` once no pass has succeeded for `stuckMs` (or one has been
 * running that long); `warn` when the last pass failed, the balance is low or
 * could not be read; `info` otherwise.
 */
export interface HeartbeatInput {
  balanceUqor?: bigint;
  balanceError?: string;
}

export interface Heartbeat {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
}

export class Liveness {
  private readonly startedAt: number;
  private lastOk?: { at: number; result: string };
  private lastFailure?: { at: number; reason: string };
  private failures = 0;
  private running: number | undefined;

  constructor(
    readonly opts: { stuckMs: number; lowBalanceUqor: bigint },
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  passStarted(): void {
    this.running = this.now();
  }

  passSucceeded(result: string): void {
    this.running = undefined;
    this.lastOk = { at: this.now(), result };
    this.failures = 0;
  }

  passFailed(reason: string): void {
    this.running = undefined;
    this.lastFailure = { at: this.now(), reason };
    this.failures++;
  }

  beat(b: HeartbeatInput = {}): Heartbeat {
    const now = this.now();
    const sec = (t: number) => Math.round((now - t) / 1000);
    const sinceOk = now - (this.lastOk?.at ?? this.startedAt);
    const runningMs = this.running === undefined ? 0 : now - this.running;
    const failing = this.failures > 0;
    const low = b.balanceUqor !== undefined && b.balanceUqor < this.opts.lowBalanceUqor;
    const stuck = sinceOk >= this.opts.stuckMs || runningMs >= this.opts.stuckMs;
    const level = stuck ? "error" : failing || low || b.balanceError ? "warn" : "info";
    return {
      level,
      fields: {
        lastPass: failing ? "failed" : (this.lastOk?.result ?? "none yet"),
        ...(this.lastOk ? { lastSuccessSecAgo: sec(this.lastOk.at) } : { noSuccessSinceStartSec: sec(this.startedAt) }),
        ...(failing && { consecutiveFailures: this.failures, lastError: this.lastFailure?.reason }),
        ...(this.running !== undefined && { passRunningSec: sec(this.running) }),
        ...(stuck && { stuck: true }),
        ...(b.balanceUqor !== undefined && { balanceUqor: b.balanceUqor }),
        ...(low && { lowBalance: true }),
        ...(b.balanceError && { balanceError: b.balanceError }),
      },
    };
  }
}
