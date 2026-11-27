/**
 * Read-only chain reads for the evidence check, one at a time and throttled.
 *
 * Only GETs to the REST API, and only `eth_getTransactionReceipt` on the EVM JSON-RPC endpoint.
 * No key, no signing, no transaction. The public endpoints sit behind a shared rate limit
 * that also serves Vigil's own services, so requests go out one by one with at least `gapMs`
 * between them (never less than a second), and a failed request is retried at most twice.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const REST = "https://api-testnet.qore.host";
export const EVM_RPC = "https://evm-testnet.qore.host";

/** One answer from the chain, as received. `body` is the parsed JSON, or the raw text if it was not JSON. */
export interface Fetched {
  url: string;
  fetchedAt: string;
  httpStatus: number;
  body: unknown;
}

export const MIN_GAP_MS = 1000;

/**
 * Only a complete answer is cached: HTTP 200 with a JSON body that is not a JSON-RPC error or an
 * empty (`null`) receipt. Failures and "not found" answers are asked again on the next run.
 */
export function worthKeeping(f: Fetched): boolean {
  if (f.httpStatus !== 200 || typeof f.body !== "object" || f.body === null) return false;
  const b = f.body as { error?: unknown; result?: unknown };
  return b.error === undefined && b.result !== null;
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export interface ReaderOptions {
  fetchFn: typeof fetch;
  /** Time between the starts of two requests; raised to at least MIN_GAP_MS. */
  gapMs?: number;
  /**
   * Keep each complete answer here and reuse it on the next run. Failures and "not found" answers
   * are not kept, so a re-run asks again; the tip is kept, so a cached run is one consistent snapshot
   * (the report counts the answers it reused).
   */
  cacheDir?: string;
  log?: (line: string) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ChainReader {
  private last = Number.NEGATIVE_INFINITY;
  private readonly fetchFn: typeof fetch;
  private readonly cacheDir: string | undefined;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly gapMs: number;
  /** Requests sent, retries included (cache hits are not requests). */
  requests = 0;
  /** Answers reused from `cacheDir` instead of read again. */
  cacheHits = 0;

  constructor(o: ReaderOptions) {
    this.fetchFn = o.fetchFn;
    // A gap that is not a finite number (NaN from a mistyped flag) must not switch the throttle off.
    this.gapMs = o.gapMs !== undefined && Number.isFinite(o.gapMs) ? Math.max(MIN_GAP_MS, o.gapMs) : MIN_GAP_MS;
    this.cacheDir = o.cacheDir;
    this.log = o.log ?? (() => {});
    this.sleep = o.sleep ?? sleep;
    this.now = o.now ?? Date.now;
    if (this.cacheDir) mkdirSync(this.cacheDir, { recursive: true });
  }

  /** `GET /cosmos/tx/v1beta1/txs/{hash}`. */
  nativeTx(hash: string): Promise<Fetched> {
    return this.cached(`native-${hash}`, () => this.request(`${REST}/cosmos/tx/v1beta1/txs/${hash}`));
  }

  /** `eth_getTransactionReceipt`. */
  evmReceipt(hash: string): Promise<Fetched> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] });
    return this.cached(`evm-${hash}`, () =>
      this.request(EVM_RPC, { method: "POST", headers: { "content-type": "application/json" }, body }),
    );
  }

  /** The latest block: its height and time, as the node reports them. */
  tip(): Promise<Fetched> {
    return this.cached("tip", () => this.request(`${REST}/cosmos/base/tendermint/v1beta1/blocks/latest`));
  }

  private async cached(key: string, get: () => Promise<Fetched>): Promise<Fetched> {
    const file = this.cacheDir ? resolve(this.cacheDir, `${key}.json`) : undefined;
    if (file) {
      let hit: Fetched | undefined;
      try {
        hit = JSON.parse(readFileSync(file, "utf8")) as Fetched;
      } catch {
        // not cached yet
      }
      if (hit) {
        this.cacheHits++;
        return hit;
      }
    }
    const f = await get();
    if (file && worthKeeping(f)) writeFileSync(file, JSON.stringify(f));
    return f;
  }

  private async request(url: string, init?: RequestInit): Promise<Fetched> {
    const backoff = [5_000, 15_000];
    for (let attempt = 0; ; attempt++) {
      await this.turn();
      const fetchedAt = new Date(this.now()).toISOString();
      let f: Fetched;
      let retryAfterMs = 0;
      try {
        this.requests++;
        const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(60_000) });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // keep the text
        }
        f = { url, fetchedAt, httpStatus: res.status, body };
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra, 60) * 1000;
      } catch (e) {
        f = { url, fetchedAt, httpStatus: 0, body: String((e as Error).message ?? e) };
      }
      const transient = f.httpStatus === 0 || f.httpStatus === 429 || f.httpStatus >= 500;
      if (!transient || attempt >= backoff.length) return f;
      const wait = Math.max(retryAfterMs, backoff[attempt] ?? 15_000);
      this.log(`  ${f.httpStatus || "network error"} from ${new URL(url).host}; retrying in ${wait / 1000} s`);
      await this.sleep(wait);
    }
  }

  /** Wait until at least `gapMs` has passed since the previous request started. */
  private async turn(): Promise<void> {
    const wait = this.last + this.gapMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.last = this.now();
  }
}
