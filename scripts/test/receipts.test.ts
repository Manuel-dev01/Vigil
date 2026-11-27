/** The snapshot script's helpers: a gentle, caching fetch, binding a receipt to its batch's own anchor, and when to rewrite the summary. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnchorView, FetchLike, SettlementReceipt } from "@qorechain/rdk";
import { bindOwnAnchor, coversAll, politeFetch } from "../lib/receipts.ts";

const RECEIPTS = resolve(import.meta.dirname, "../../receipts/vigil-pay-1");
const batch3 = JSON.parse(readFileSync(resolve(RECEIPTS, "batch-3.json"), "utf8")) as SettlementReceipt;

/** A fake node: answers from a table, records every call, and a clock that moves only when slept. */
function fakeNode(table: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; at: number; method: string }[] = [];
  let clock = 1_000;
  const inner: FetchLike = async (url, init) => {
    calls.push({ url, at: clock, method: init?.method ?? "GET" });
    const hit = table[url];
    if (!hit) throw new Error(`connection refused: ${url}`);
    return { ok: hit.status < 400, status: hit.status, statusText: hit.status === 404 ? "Not Found" : "OK", json: async () => hit.body };
  };
  const slept: number[] = [];
  return {
    calls,
    slept,
    inner,
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
  };
}

describe("politeFetch", () => {
  it("reads each URL once and answers repeats from memory", async () => {
    const node = fakeNode({ "https://n/a": { status: 200, body: { x: 1 } } });
    const f = politeFetch(node.inner, { now: node.now, sleep: node.sleep });
    const one = await f("https://n/a", { method: "GET" });
    const two = await f("https://n/a");
    expect(await one.json()).toEqual({ x: 1 });
    expect(await two.json()).toEqual({ x: 1 });
    expect(node.calls).toHaveLength(1);
    expect(f.requests()).toBe(1);
  });

  it("spaces requests at least gapMs apart, one at a time", async () => {
    const node = fakeNode({ "https://n/a": { status: 200, body: 1 }, "https://n/b": { status: 200, body: 2 }, "https://n/c": { status: 200, body: 3 } });
    const f = politeFetch(node.inner, { gapMs: 1000, now: node.now, sleep: node.sleep });
    await Promise.all([f("https://n/a"), f("https://n/b"), f("https://n/c")]);
    expect(node.calls.map((c) => c.url)).toEqual(["https://n/a", "https://n/b", "https://n/c"]);
    expect(node.calls[1]!.at - node.calls[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(node.calls[2]!.at - node.calls[1]!.at).toBeGreaterThanOrEqual(1000);
  });

  it("keeps a 404 as an answer, with its status", async () => {
    const node = fakeNode({ "https://n/gone": { status: 404, body: { code: 5 } } });
    const f = politeFetch(node.inner, { now: node.now, sleep: node.sleep });
    const r = await f("https://n/gone");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    await f("https://n/gone");
    expect(node.calls).toHaveLength(1);
  });

  it("forgets a request that failed outright, so the next ask tries again", async () => {
    const node = fakeNode({});
    const f = politeFetch(node.inner, { now: node.now, sleep: node.sleep });
    await expect(f("https://n/down")).rejects.toThrow(/refused/);
    await expect(f("https://n/down")).rejects.toThrow(/refused/);
    expect(node.calls).toHaveLength(2);
  });

  it("never answers a POST from memory", async () => {
    const node = fakeNode({ "https://n/rpc": { status: 200, body: { result: 1 } } });
    const f = politeFetch(node.inner, { now: node.now, sleep: node.sleep });
    await f("https://n/rpc", { method: "POST", body: "{}" });
    await f("https://n/rpc", { method: "POST", body: "{}" });
    expect(node.calls).toHaveLength(2);
  });
});

/** Synthetic anchors: several can share one root, each at its own layer height. */
const ROOT = "ab".repeat(32);
const anchorAt = (h: number, root = ROOT): AnchorView => ({
  layerId: "vigil-pay-1",
  layerHeight: h,
  stateRoot: root,
  validatorSetHash: "",
  mainChainHeight: 1_000 + h,
  anchoredAt: 2_000 + h,
  pqcSignature: `sig${h}`,
  transactionCount: h,
  compressedStateProof: `proof${h}`,
});

describe("bindOwnAnchor", () => {
  it("leaves a receipt that already carries its own anchor unchanged (the real batch-3 receipt)", () => {
    const own: AnchorView = {
      layerId: batch3.layerId,
      layerHeight: batch3.layerHeight,
      stateRoot: batch3.stateRoot,
      validatorSetHash: batch3.validatorSetHash,
      mainChainHeight: batch3.mainChainHeight,
      anchoredAt: batch3.anchoredAt,
      pqcSignature: batch3.pqcSignature,
      transactionCount: batch3.transactionCount ?? 0,
      compressedStateProof: batch3.compressedStateProof ?? "",
    };
    expect(bindOwnAnchor(batch3, [anchorAt(40), own])).toBe(batch3);
  });

  it("binds the receipt to the anchor at its own layer height", () => {
    const r: SettlementReceipt = { ...batch3, batchIndex: 41, stateRoot: ROOT, batchStateRoot: ROOT };
    const bound = bindOwnAnchor(r, [anchorAt(40), anchorAt(41), anchorAt(42)])!;
    expect(bound.batchIndex).toBe(41);
    expect(bound.layerHeight).toBe(41);
    expect(bound.pqcSignature).toBe("sig41");
    expect(bound.mainChainHeight).toBe(1_041);
    expect(bound.anchoredAt).toBe(2_041);
    expect(bound.transactionCount).toBe(41);
    expect(bound.compressedStateProof).toBe("proof41");
    // Same fields in the same order, so a saved file diffs cleanly.
    expect(Object.keys(bound)).toEqual(Object.keys(r));
  });

  it("gives nothing for a batch with no anchor of its own over its root", () => {
    const r: SettlementReceipt = { ...batch3, batchIndex: 43, stateRoot: ROOT, batchStateRoot: ROOT };
    expect(bindOwnAnchor(r, [anchorAt(40), anchorAt(41)])).toBeUndefined();
    expect(bindOwnAnchor(r, [anchorAt(43, "cd".repeat(32))])).toBeUndefined();
  });
});

describe("coversAll", () => {
  const indexes = [0, 1, 2, 3, 5];
  it("is true for a run over every batch", () => {
    expect(coversAll(0, 5, indexes)).toBe(true);
    expect(coversAll(0, 9, indexes)).toBe(true);
  });
  it("is false for a run over some of them, so summary.json is kept", () => {
    expect(coversAll(3, 3, indexes)).toBe(false);
    expect(coversAll(1, 5, indexes)).toBe(false);
    expect(coversAll(0, 4, indexes)).toBe(false);
  });
});
