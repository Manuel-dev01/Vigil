import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { buildRoutes, chainRegistry, restOverWs, sha256Hex, type AbciQueryResult, type WsRpc } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, "..", "descriptors", "qorechain-diana.binpb"));
const meta = JSON.parse(readFileSync(join(here, "..", "descriptors", "qorechain-diana.json"), "utf8")) as { sha256: string; files: number };
const registry = chainRegistry(bytes);

/** A stand-in for the websocket: records each abci_query and answers with `answer`. */
function fakeRpc(answer: (path: string, data: Uint8Array) => AbciQueryResult) {
  const calls: { path: string; data: Uint8Array }[] = [];
  const rpc = {
    abciQuery: async (path: string, data: Uint8Array) => (calls.push({ path, data }), answer(path, data)),
    call: async () => {
      throw new Error("not used");
    },
  } as unknown as WsRpc;
  return { rpc, calls };
}

describe("descriptor snapshot", () => {
  it("matches its recorded hash and file count", async () => {
    expect(await sha256Hex(bytes)).toBe(meta.sha256);
    expect([...registry.files].length).toBe(meta.files);
  });

  it("maps the RDK's REST routes to their gRPC queries", () => {
    const routes = buildRoutes(registry);
    const find = (t: string) => routes.find((r) => r.template === t)?.grpcPath;
    expect(find("/qorechain/rdk/v1/batch/{rollup_id}/{batch_index}")).toBe("/qorechain.rdk.v1.Query/Batch");
    expect(find("/qorechain/rdk/v1/rollup/{rollup_id}")).toBe("/qorechain.rdk.v1.Query/Rollup");
    expect(find("/qorechain/multilayer/v1/anchors/{layer_id}")).toBeDefined();
    expect(find("/qorechain/pqc/v1/account/{address}")).toBeDefined();
  });
});

describe("restOverWs", () => {
  it("encodes path and query parameters into the gRPC request", async () => {
    const out = registry.getMessage("qorechain.rdk.v1.QueryBatchResponse")!;
    const { rpc, calls } = fakeRpc(() => ({ code: 0, log: "", codespace: "", height: 1, value: toBinary(out, create(out)) }));
    const res = await restOverWs(rpc, registry)("https://node/qorechain/rdk/v1/batch/vigil-pay-1/7");
    expect(res.status).toBe(200);
    expect(calls[0]!.path).toBe("/qorechain.rdk.v1.Query/Batch");
    const req = registry.getMessage("qorechain.rdk.v1.QueryBatchRequest")!;
    const sent = fromBinary(req, calls[0]!.data) as unknown as { rollupId: string; batchIndex: bigint };
    expect(sent.rollupId).toBe("vigil-pay-1");
    expect(Number(sent.batchIndex)).toBe(7);
    // An unset message field is written as null, as the gateway does.
    expect(await res.json()).toEqual({ batch: null });
  });

  it("answers a gRPC NotFound as HTTP 404", async () => {
    const { rpc } = fakeRpc(() => ({ code: 5, log: "rpc error: code = NotFound desc = rollup x not found", codespace: "", height: 1, value: new Uint8Array() }));
    const res = await restOverWs(rpc, registry)("/qorechain/rdk/v1/rollup/x");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("refuses writes and unknown routes", async () => {
    const { rpc, calls } = fakeRpc(() => {
      throw new Error("must not be called");
    });
    const shim = restOverWs(rpc, registry);
    expect((await shim("/cosmos/tx/v1beta1/txs", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await shim("/no/such/route")).status).toBe(501);
    expect(calls).toHaveLength(0);
  });
});
