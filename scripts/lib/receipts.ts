/**
 * Helpers for receipts-snapshot.ts, kept apart so they can be tested offline.
 */
import type { AnchorView, FetchLike, HttpResponse, SettlementReceipt } from "@qorechain/rdk";

interface Saved {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

export interface PoliteFetchOptions {
  /** Least time between the starts of two requests, in ms (default 1000: about one a second). */
  gapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A fetch for reading a shared public node gently. Requests go out one at a time, at most one every
 * `gapMs`, and a GET to a URL already read in this run is answered from memory, so one run reads each
 * thing once and all its receipts describe the same reading of the chain. Errors are kept too (a 404 is
 * an answer); a request that fails outright is forgotten, so the next ask tries again.
 */
export function politeFetch(inner: FetchLike, opts: PoliteFetchOptions = {}): FetchLike & { requests(): number } {
  const gapMs = opts.gapMs ?? 1000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<string, Promise<Saved>>();
  let queue: Promise<unknown> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;
  let sent = 0;

  const send = (url: string, init: Parameters<FetchLike>[1]): Promise<Saved> => {
    const run = queue.then(async () => {
      const wait = last + gapMs - now();
      if (wait > 0) await sleep(wait);
      last = now();
      sent++;
      const res = (await inner(url, init)) as HttpResponse & { text?: () => Promise<string> };
      const body = res.text ? await res.text() : JSON.stringify(await res.json());
      return { ok: res.ok, status: res.status, statusText: res.statusText, body };
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const f: FetchLike = async (url, init) => {
    let p: Promise<Saved>;
    if ((init?.method ?? "GET").toUpperCase() === "GET") {
      const hit = cache.get(url);
      p = hit ?? send(url, init);
      if (!hit) {
        cache.set(url, p);
        p.catch(() => cache.delete(url));
      }
    } else p = send(url, init);
    const s = await p;
    return { ok: s.ok, status: s.status, statusText: s.statusText, json: async () => JSON.parse(s.body) as unknown };
  };
  return Object.assign(f, { requests: () => sent });
}

/**
 * The receipt for batch `i`, bound to batch `i`'s own anchor. Several batches
 * can share a state root (an entry that changes no balance leaves the root as
 * it was), and each has its own anchor with its own height and time; pick the
 * one whose layer height is this batch's index. Undefined if the batch has no
 * anchor of its own over that root: only the creator's sequencer anchors.
 */
export function bindOwnAnchor(r: SettlementReceipt, anchors: readonly AnchorView[]): SettlementReceipt | undefined {
  const own = anchors.find((a) => a.layerHeight === r.batchIndex && a.stateRoot === r.stateRoot);
  if (!own) return undefined;
  if (r.layerHeight === own.layerHeight && r.pqcSignature === own.pqcSignature) return r;
  return {
    ...r,
    layerHeight: own.layerHeight,
    validatorSetHash: own.validatorSetHash,
    mainChainHeight: own.mainChainHeight,
    anchoredAt: own.anchoredAt,
    pqcSignature: own.pqcSignature,
    transactionCount: own.transactionCount,
    compressedStateProof: own.compressedStateProof,
  };
}
