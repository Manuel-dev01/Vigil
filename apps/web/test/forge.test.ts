/**
 * The Verify page's forgery menu, against a scripted chain built from vigil-pay-1's real batch-0 receipt and
 * the creator's real key: the honest receipt verifies, each forgery changes one field and is refused, and the
 * page names the check that refused it, whether or not the batch record has been pruned.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRdkClient, type AnchorView, type RdkClient, type SettlementReceipt } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import { FORGERIES, ROW_ORDER, caughtBy, changedFields, rowNumber, tally, type ForgeryId } from "../src/forge.ts";
import { checkReceipt } from "../src/check.ts";
import type { CheckKey } from "../src/pruned.ts";

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, "..", "..", "..", "receipts", "vigil-pay-1", "batch-0.json"), "utf8")) as SettlementReceipt;
const creator = JSON.parse(readFileSync(join(here, "fixtures", "creator-key.json"), "utf8")) as { address: string; publicKey: string };

const anchor = {
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
const notFound = () => Object.assign(new Error("not found"), { status: 404 });

/** The chain as the node would report it: one rollup, its batch 0 (or none, once pruned) and its anchor. */
function fakeChain(pruned: boolean): RdkClient {
  const rest = {
    getRollup: async (id: string) => {
      if (id !== receipt.rollupId) throw notFound();
      return { layerId: receipt.layerId, creator: receipt.creator };
    },
    getBatch: async (id: string, i: number) => {
      if (pruned || id !== receipt.rollupId || i !== receipt.batchIndex) throw notFound();
      return { stateRoot: receipt.stateRoot, status: "finalized" };
    },
    getAnchors: async () => [anchor],
    getPqcAccount: async () => ({ publicKey: creator.publicKey }),
    getLatestBatch: async () => ({ batchIndex: 24 }),
    getLatestHeight: async () => receipt.mainChainHeight + 700_000,
    getParams: async () => ({ finalizedBatchRetentionBlocks: 432_000 }),
    searchTxs: async () => [],
  };
  return { rest, network } as unknown as RdkClient;
}

const forgery = (id: ForgeryId) => FORGERIES.find((f) => f.id === id)!;

describe("the forgeries", () => {
  it("are five, each changing exactly one field of the receipt", () => {
    expect(FORGERIES.map((f) => f.id)).toEqual(["stateRoot", "signature", "chainId", "creator", "rollupId"]);
    const field: Record<ForgeryId, keyof SettlementReceipt> = { stateRoot: "stateRoot", signature: "pqcSignature", chainId: "chainId", creator: "creator", rollupId: "rollupId" };
    for (const f of FORGERIES) {
      expect([...changedFields(f.forge(receipt), receipt)], f.id).toEqual([field[f.id]]);
    }
  });

  it("change one hex digit of the root and one bit of the signature, nothing more", () => {
    const root = forgery("stateRoot").forge(receipt).stateRoot;
    expect([...root].filter((c, i) => c !== receipt.stateRoot[i])).toHaveLength(1);
    const sig = forgery("signature").forge(receipt).pqcSignature;
    expect(sig).toHaveLength(receipt.pqcSignature.length);
    expect(parseInt(sig.slice(0, 2), 16) ^ parseInt(receipt.pqcSignature.slice(0, 2), 16)).toBe(1);
    expect(sig.slice(2)).toBe(receipt.pqcSignature.slice(2));
  });
});

describe("each forgery is caught, and the page names the check", () => {
  const expected: Record<"live" | "pruned", Record<ForgeryId, CheckKey>> = {
    live: { stateRoot: "batchStateRoot", signature: "anchorOnChain", chainId: "chainBinding", creator: "creatorAuthority", rollupId: "rollupLayerBinding" },
    pruned: { stateRoot: "anchorOnChain", signature: "anchorOnChain", chainId: "chainBinding", creator: "creatorAuthority", rollupId: "rollupLayerBinding" },
  };

  for (const mode of ["live", "pruned"] as const) {
    describe(mode === "live" ? "with the batch record on chain" : "with the batch record pruned", () => {
      const rdk = fakeChain(mode === "pruned");

      it("the honest receipt passes every receipt check, and its batch reads as final", async () => {
        const { v, finality } = await checkReceipt(rdk, receipt);
        expect(v.reason).toBeUndefined();
        expect(v.valid).toBe(true);
        expect(caughtBy(v)).toBeUndefined();
        expect(finality).toMatchObject({ final: true, status: mode === "live" ? "finalized" : "pruned" });
      });

      for (const f of FORGERIES) {
        it(`${f.label}: caught by ${expected[mode][f.id]}`, async () => {
          // The page's own run of the checks: it must finish (no throw) so the page can name the check.
          const { v } = await checkReceipt(rdk, f.forge(receipt));
          expect(v.valid).toBe(false);
          expect(caughtBy(v)).toBe(expected[mode][f.id]);
        });
      }
    });
  }

  it("names each check by its number on the page", () => {
    expect(ROW_ORDER).toHaveLength(9);
    expect([rowNumber("rollupLayerBinding"), rowNumber("batchStateRoot"), rowNumber("anchorOnChain"), rowNumber("creatorAuthority"), rowNumber("chainBinding")]).toEqual([1, 2, 3, 4, 6]);
  });
});

describe("the tally", () => {
  it("counts the forgeries tried on this receipt and those caught", () => {
    expect(tally({}).text).toBe("No forgery tried yet.");
    expect(tally({ stateRoot: "batchStateRoot" }).text).toBe("1 forgery tried, 1 caught");
    expect(
      tally({ stateRoot: "batchStateRoot", signature: "anchorOnChain", chainId: "chainBinding", creator: "creatorAuthority", rollupId: "rollupLayerBinding" }).text,
    ).toBe("5 forgeries tried, 5 caught");
    expect(tally({ stateRoot: "batchStateRoot", signature: null })).toMatchObject({ tried: 2, caught: 1 });
  });
});
