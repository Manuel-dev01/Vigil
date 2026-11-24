/**
 * One connection to the chain for the whole app: the node's websocket, the
 * chain's own protobuf descriptors, and an RDK client whose REST calls are
 * answered over that websocket (no server of ours, no CORS).
 */
import { createRdkClient, type RdkClient } from "@qorechain/rdk";
import { WsRpc, chainRegistry, restOverWs, sha256Hex, type RpcState } from "@vigil/chain-ws";
import descriptorsUrl from "@vigil/chain-ws/descriptors/qorechain-diana.binpb?url";
import descriptorsMeta from "@vigil/chain-ws/descriptors/qorechain-diana.json";

export const CHAIN_ID = "qorechain-diana";
export const ROLLUP = "vigil-pay-1";
export const WS_URL = "wss://rpc-testnet.qore.host/websocket";
export const EXPLORER = "https://explore.qore.network";
export const REPO = "https://github.com/Manuel-dev01/Vigil";

/** Accounts the page names instead of showing a bare address. All are public in the repo's README and EVIDENCE. */
export const KNOWN: Record<string, string> = {
  qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s: "Vigil creator and sequencer (Keel)",
  qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd: "Vigil watchtower-2 (US West)",
  qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33: "Vigil watchtower-3 (EU West)",
  qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft: "Vigil standby sequencer (keel-b)",
  qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6: "Vigil EVM deployer",
  qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn: "Vigil exit relayer",
  qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l: "Vigil keep-alive pulse",
  qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws: "employer-1 (sealed payroll demo)",
  qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry: "employee-1 (sealed payroll demo)",
  qor1u7tkkkd56h27lcl3qgzzcavaukuj74mjvxqf9d: "auditor-1 (sealed payroll demo)",
  qor1fvrd7gscnq6xkmrcrdm4gzzwnv4f3lfk0ummn2: "evil submitter, fraud drill 2",
  qor1kgvdpmv87386eyp7k577r55ttx9tf5m77jwygk: "evil submitter, fraud drill 1",
  qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5: "another team's watcher",
  qor182yhsq4k9vzj5yp02hszr0zxdpfec2d4nhyfj6: "Vigil InstantExitVault",
  qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k: "OoJae's QoreX address",
  qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy: "exit address of OoJae's QoreX",
};

type Listener = (s: RpcState) => void;
const listeners = new Set<Listener>();
let state: RpcState = "connecting";

export const rpc = new WsRpc({
  url: WS_URL,
  timeoutMs: 30_000,
  onState: (s) => {
    state = s;
    for (const l of listeners) l(s);
  },
});

export function connectionState(): RpcState {
  return state;
}

export function onConnectionState(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface Chain {
  rdk: RdkClient;
  descriptors: { sha256: string; expected: string; files: number; height: number };
}

let chainPromise: Promise<Chain> | undefined;

/** Load the descriptors (checking their hash against the snapshot record) and build the client. */
export function chain(): Promise<Chain> {
  chainPromise ??= (async () => {
    const bytes = new Uint8Array(await (await fetch(descriptorsUrl)).arrayBuffer());
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== descriptorsMeta.sha256) throw new Error(`descriptor snapshot hash ${sha256} does not match its record ${descriptorsMeta.sha256}`);
    const registry = chainRegistry(bytes);
    const rdk = createRdkClient({ network: "testnet", fetch: restOverWs(rpc, registry) });
    return { rdk, descriptors: { sha256, expected: descriptorsMeta.sha256, files: descriptorsMeta.files, height: descriptorsMeta.height } };
  })();
  return chainPromise;
}

export const qor = (uqor: string | number | bigint): string => {
  const n = BigInt(String(uqor).replace(/uqor$/, "") || "0");
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} QOR`;
};

export const short = (h: string, n = 8): string => (h.length > 2 * n + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h);
export const shortAddr = (a: string): string => (a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);
export const txUrl = (hash: string): string => `${EXPLORER}/tx/${hash}`;
