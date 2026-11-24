/**
 * Receipts for pruned batch records, against a scripted chain built from vigil-pay-1's real batch-0
 * receipt and the creator's real key: the honest receipt verifies, a forged one fails at the check that
 * actually failed, and a missing record is treated as final only when pruning explains it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRdkClient, type AnchorView, type RdkClient, type SettlementReceipt } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import { keyPin } from "../src/keys.ts";
import { explainMissingBatch, verifyPrunedReceipt, type Pruning } from "../src/pruned.ts";

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, "..", "..", "..", "receipts", "vigil-pay-1", "batch-0.json"), "utf8")) as SettlementReceipt;
const creator = JSON.parse(readFileSync(join(here, "fixtures", "creator-key.json"), "utf8")) as { address: string; publicKey: string };

const anchor: AnchorView = {
  layerId: receipt.layerId,
  layerHeight: receipt.layerHeight,
  stateRoot: receipt.stateRoot,
  validatorSetHash: receipt.validatorSetHash,
  mainChainHeight: receipt.mainChainHeight,
  anchoredAt: receipt.anchoredAt,
  pqcSignature: receipt.pqcSignature,
  transactionCount: receipt.transactionCount ?? 0,
  compressedStateProof: receipt.compressedStateProof ?? "",
} as AnchorView;

const network = createRdkClient({ network: "testnet" }).network;

function fakeChain(opts: { head?: number; fraudAgainst?: number } = {}): RdkClient {
  const rest = {
    getRollup: async () => ({ layerId: receipt.layerId, creator: receipt.creator }),
    getAnchors: async () => [anchor],
    getPqcAccount: async () => ({ publicKey: creator.publicKey }),
    getLatestBatch: async () => ({ batchIndex: 19 }),
    getLatestHeight: async () => opts.head ?? receipt.mainChainHeight + 700_000,
    getParams: async () => ({ finalizedBatchRetentionBlocks: 432_000 }),
    searchTxs: async () =>
      opts.fraudAgainst === undefined
        ? []
        : [
            {
              height: "10370243",
              txhash: "AB",
              events: [{ type: "rdk_fraud_upheld", attributes: [
                { key: "rollup_id", value: receipt.rollupId },
                { key: "batch_index", value: String(opts.fraudAgainst) },
                { key: "submitter", value: receipt.creator },
              ] }],
            },
          ],
  };
  return { rest, network } as unknown as RdkClient;
}

const pruning: Pruning = { retentionBlocks: 432_000, latestBatch: 19, headHeight: receipt.mainChainHeight + 700_000 };

describe("verifyPrunedReceipt", () => {
  it("verifies the real batch-0 receipt from its anchor alone, and the creator's key is the pinned one", async () => {
    const v = await verifyPrunedReceipt(fakeChain(), receipt, pruning);
    expect(v.reason).toBeUndefined();
    expect(v.valid).toBe(true);
    expect(v.failed).toBeUndefined();
    expect(v.checks.pqcSignature).toBe(true);
    expect(keyPin(creator.address, creator.publicKey).status).toBe("match");
  });

  it("blames the anchor, not the rollup binding, for a forged state root", async () => {
    const forged = { ...receipt, stateRoot: (receipt.stateRoot[0] === "0" ? "1" : "0") + receipt.stateRoot.slice(1) };
    const v = await verifyPrunedReceipt(fakeChain(), forged, pruning);
    expect(v.valid).toBe(false);
    expect(v.failed).toBe("anchorOnChain");
    expect(v.checks.rollupLayerBinding).toBe(true);
  });

  it("refuses a batch root that is not its own anchor's", async () => {
    const v = await verifyPrunedReceipt(fakeChain(), { ...receipt, batchStateRoot: "00".repeat(32) }, pruning);
    expect(v.failed).toBe("batchStateRoot");
  });

  it("does not take a young missing record for a pruned one", async () => {
    const v = await verifyPrunedReceipt(fakeChain(), receipt, { ...pruning, headHeight: receipt.mainChainHeight + 1000 });
    expect(v.valid).toBe(false);
    expect(v.failed).toBe("batchStateRoot");
    expect(v.reason).toMatch(/younger than the 432,000-block retention window/);
  });

  it("reports an upheld fraud proof against the creator's batch as not final", async () => {
    const v = await verifyPrunedReceipt(fakeChain({ fraudAgainst: 0 }), receipt, pruning);
    expect(v.valid).toBe(false);
    expect(v.failed).toBe("final");
  });
});

describe("explainMissingBatch (the Exits page's batch check)", () => {
  it("is final only when the anchor is past the retention window and no fraud was upheld", async () => {
    const m = await explainMissingBatch(fakeChain(), receipt.rollupId, 0, anchor, receipt.creator);
    expect(m).toMatchObject({ pruned: true, final: true });
  });

  it("is not final when the record is missing but the anchor is young", async () => {
    const m = await explainMissingBatch(fakeChain({ head: receipt.mainChainHeight + 10 }), receipt.rollupId, 0, anchor, receipt.creator);
    expect(m).toMatchObject({ pruned: false, final: false });
  });

  it("is not final without an anchor, past the newest batch, or after an upheld fraud proof", async () => {
    expect(await explainMissingBatch(fakeChain(), receipt.rollupId, 0, undefined, receipt.creator)).toMatchObject({ pruned: false, final: false });
    expect(await explainMissingBatch(fakeChain(), receipt.rollupId, 25, anchor, receipt.creator)).toMatchObject({ pruned: false, final: false });
    expect(await explainMissingBatch(fakeChain({ fraudAgainst: 0 }), receipt.rollupId, 0, anchor, receipt.creator)).toMatchObject({ pruned: true, final: false });
  });
});
