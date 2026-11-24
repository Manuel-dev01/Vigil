/**
 * The chain client the views share: the chain's own protobuf descriptors and an RDK client whose
 * REST calls are answered over the node's websocket (no server of ours, no CORS). This module pulls
 * in the RDK and its SDK, so only the lazily loaded views import it.
 */
import { createRdkClient, type RdkClient } from "@qorechain/rdk";
import { chainRegistry, restOverWs, sha256Hex } from "@vigil/chain-ws";
import descriptorsUrl from "@vigil/chain-ws/descriptors/qorechain-diana.binpb?url";
import descriptorsMeta from "@vigil/chain-ws/descriptors/qorechain-diana.json";
import { rpc } from "./rpc.ts";

export interface Chain {
  rdk: RdkClient;
  descriptors: { sha256: string; expected: string; files: number; height: number };
}

let chainPromise: Promise<Chain> | undefined;

/** Load the descriptors (checking their hash against the snapshot record) and build the client. */
export function chain(): Promise<Chain> {
  chainPromise ??= (async () => {
    const res = await fetch(descriptorsUrl);
    if (!res.ok) throw new Error(`the chain's descriptor snapshot could not be loaded (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== descriptorsMeta.sha256) throw new Error(`descriptor snapshot hash ${sha256} does not match its record ${descriptorsMeta.sha256}`);
    const registry = chainRegistry(bytes);
    const rdk = createRdkClient({ network: "testnet", fetch: restOverWs(rpc, registry) });
    return { rdk, descriptors: { sha256, expected: descriptorsMeta.sha256, files: descriptorsMeta.files, height: descriptorsMeta.height } };
  })();
  // A failed load (offline, a dropped request) is asked again next time.
  chainPromise.catch(() => (chainPromise = undefined));
  return chainPromise;
}

export { isNotFound } from "./config.ts";
