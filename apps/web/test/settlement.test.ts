/**
 * Where a sealed envelope's data receipt stands: checked, failed, or could not be checked. The entries are
 * the public inbox archive of vigil-pay-1 through entry 27; batch 24 (entries 26 and 27) is the batch of
 * the committed receipt receipts/vigil-pay-1/data-27.json. The node is a stand-in, so nothing here touches
 * the network.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, postedDataHash, type BatchView, type RestClient } from "@qorechain/rdk";
import type { InboxPost } from "@vigil/sealed/inbox";
import { settlementOf } from "../src/settlement.ts";

const env = { chainId: "qorechain-diana", rollupId: "vigil-pay-1" };
const root = resolve(import.meta.dirname, "../../..");
const posts: InboxPost[] = readFileSync(resolve(root, "data/inbox/vigil-pay-1.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { sequence: number; height: number; poster: string; payloadHex: string })
  .filter((e) => e.sequence <= 27)
  .map((e) => {
    const payload = hexToBytes(e.payloadHex);
    return { sequence: e.sequence, height: e.height, poster: e.poster, payload, dataHash: bytesToHex(postedDataHash(payload)).toLowerCase() };
  });
const receipt27 = JSON.parse(readFileSync(resolve(root, "receipts/vigil-pay-1/data-27.json"), "utf8")) as {
  batch: { batchIndex: number; inboxStart: number; inboxEnd: number; dataHash: string; stateRoot: string };
};
const batch = { ...receipt27.batch, status: "finalized" } as BatchView;
const entry27 = posts.find((p) => p.sequence === 27)!;

/** A node that answers getBatch with `answer`, or fails as `answer` says. */
const node = (answer: () => Promise<BatchView>): Pick<RestClient, "getBatch"> => ({ getBatch: answer }) as Pick<RestClient, "getBatch">;
const same = node(async () => batch);

describe("settlementOf", () => {
  it("checks entry 27 against batch 24: rebuilt here, and the batch record says the same", async () => {
    expect(batch).toMatchObject({ batchIndex: 24, inboxStart: 26, inboxEnd: 27 });
    const s = await settlementOf(same, env, posts, entry27, batch);
    expect(s).toMatchObject({ kind: "receipt", valid: true, onChain: true, finalized: true });
  });

  it("fails when the batch record differs, or the envelope does not fold to it", async () => {
    const other = node(async () => ({ ...batch, dataHash: "00".repeat(32) }));
    expect(await settlementOf(other, env, posts, entry27, batch)).toMatchObject({ kind: "receipt", valid: true, onChain: false });
    const changed = { ...entry27, payload: entry27.payload.slice(1) };
    const s = await settlementOf(same, env, [...posts.slice(0, -1), changed], changed, batch);
    expect(s).toMatchObject({ kind: "receipt", valid: false });
  });

  it("could not check, rather than fails, when the node does not answer", async () => {
    const limited = node(async () => {
      throw new Error("HTTP 429 Too Many Requests");
    });
    const s = await settlementOf(limited, env, posts, entry27, batch);
    expect(s.kind).toBe("unchecked");
    expect(s.kind === "unchecked" && s.detail).toMatch(/Could not read batch 24 from the node: HTTP 429/);
  });

  it("could not check, rather than fails, when the page has not read the whole batch", async () => {
    let asked = false;
    const watch = node(async () => {
      asked = true;
      return batch;
    });
    const s = await settlementOf(watch, env, posts.slice(0, -1), entry27, batch);
    expect(s).toMatchObject({ kind: "unchecked", detail: "The page read 26 of the 27 inbox entries up to the end of batch 24" });
    expect(asked).toBe(false);
  });
});
