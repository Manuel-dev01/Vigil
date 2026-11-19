/**
 * Against the live testnet (set VIGIL_LIVE=1): the RDK's own receipt
 * verification and inbox reader, run entirely over the websocket, agree with
 * the REST API. Skipped by default so the suite stays offline.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_INBOX_ACC, RestClient, bytesToHex, createRdkClient, fetchQledgerEntries, verifySettlementReceipt, type SettlementReceipt } from "@qorechain/rdk";
import { afterAll, describe, expect, it } from "vitest";
import { WsRpc, chainRegistry, restOverWs } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const live = process.env.VIGIL_LIVE === "1";
const receiptsDir = join(here, "..", "..", "..", "receipts", "vigil-pay-1");

describe.skipIf(!live)("chain-ws against the live testnet", () => {
  const rpc = new WsRpc({ url: "wss://rpc-testnet.qore.host/websocket", timeoutMs: 60_000 });
  const fetch = restOverWs(rpc, chainRegistry(readFileSync(join(here, "..", "descriptors", "qorechain-diana.binpb"))));
  const overWs = createRdkClient({ network: "testnet", fetch });
  afterAll(() => rpc.close());

  const files = readdirSync(receiptsDir).filter((f) => /^batch-\d+\.json$/.test(f));
  for (const f of files) {
    it(`verifies ${f} against the chain, over the websocket only`, async () => {
      const receipt = JSON.parse(readFileSync(join(receiptsDir, f), "utf8")) as SettlementReceipt;
      const v = await verifySettlementReceipt(receipt, { client: overWs });
      expect(v.reason ?? "").toBe("");
      expect(v.valid).toBe(true);
      expect(v.mode).toBe("chain");
    });
  }

  it("rejects a receipt whose state root was changed", async () => {
    const receipt = JSON.parse(readFileSync(join(receiptsDir, files[0]!), "utf8")) as SettlementReceipt;
    const forged = { ...receipt, stateRoot: (receipt.stateRoot[0] === "0" ? "1" : "0") + receipt.stateRoot.slice(1) };
    const v = await verifySettlementReceipt(forged, { client: overWs });
    expect(v.valid).toBe(false);
  });

  it("reads the same inbox entries as the REST API", async () => {
    const inbox = await overWs.rest.getInbox("vigil-pay-1");
    const to = Number(inbox.headSequence);
    const env = { chainId: "qorechain-diana", rollupId: "vigil-pay-1", from: 0, to, accFrom: bytesToHex(EMPTY_INBOX_ACC) };
    // fetchQledgerEntries checks every entry against the chain's inbox accumulator.
    const viaRest = await fetchQledgerEntries(new RestClient("https://api-testnet.qore.host"), env);
    const viaWs = await fetchQledgerEntries(overWs.rest, env);
    expect(viaWs.length).toBe(to);
    expect(viaWs).toEqual(viaRest);
  });
});
