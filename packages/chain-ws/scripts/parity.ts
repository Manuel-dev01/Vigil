/**
 * Ask the same REST paths of the public REST API and of `restOverWs`, and
 * compare the JSON. Run: pnpm --filter @vigil/chain-ws exec tsx scripts/parity.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WsRpc, chainRegistry, restOverWs } from "../src/index.ts";

const REST = "https://api-testnet.qore.host";
const here = dirname(fileURLToPath(import.meta.url));
const registry = chainRegistry(readFileSync(join(here, "..", "descriptors", "qorechain-diana.binpb")));
const rpc = new WsRpc({ url: "wss://rpc-testnet.qore.host/websocket", timeoutMs: 60_000 });
const shim = restOverWs(rpc, registry);

const paths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "/qorechain/rdk/v1/rollup/vigil-pay-1",
      "/qorechain/rdk/v1/batch/vigil-pay-1/3",
      "/qorechain/rdk/v1/batches/vigil-pay-1?limit=3",
      "/qorechain/rdk/v1/latest_batch/vigil-pay-1",
      "/qorechain/rdk/v1/inbox/vigil-pay-1",
      "/qorechain/rdk/v1/posted_data/vigil-pay-1/9",
      "/qorechain/rdk/v1/submitter_bond/vigil-pay-1/qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s",
      "/qorechain/rdk/v1/params",
      "/qorechain/multilayer/v1/anchors/vigil-pay-1",
      "/qorechain/pqc/v1/account/qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s",
      "/cosmos/bank/v1beta1/balances/qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd",
      "/cosmos/tx/v1beta1/txs/4963FCFD2D33188456572D27C16D96DD2CB03604767DCBEEF0EDFB54E0F5B915",
      "/cosmos/tx/v1beta1/txs?query=" + encodeURIComponent("rdk_data_posted.rollup_id='vigil-pay-1'") + "&page=1&limit=3&order_by=ORDER_BY_ASC",
      "/qorechain/rdk/v1/rollup/no-such-rollup",
    ];

/** Paths where the two sides differ, as `a.b[2].c: rest | shim`. */
function diff(a: unknown, b: unknown, at = "", out: string[] = []): string[] {
  if (out.length > 12) return out;
  if (a === b) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k, out);
    return out;
  }
  const s = (v: unknown) => (typeof v === "string" && v.length > 40 ? `${v.slice(0, 40)}…` : JSON.stringify(v));
  out.push(`${at}: rest ${s(a)} | shim ${s(b)}`);
  return out;
}

try {
  for (const p of paths) {
    const [r, s] = await Promise.all([fetch(REST + p, { headers: { accept: "application/json" } }), shim(p)]);
    const [rj, sj] = await Promise.all([r.json().catch(() => null), s.json()]);
    const d = r.ok && s.ok ? diff(rj, sj) : [];
    const verdict = r.status !== s.status ? `STATUS rest ${r.status} shim ${s.status}` : d.length ? `${d.length} DIFF` : "same";
    console.log(`${verdict.padEnd(22)} ${p.slice(0, 110)}`);
    for (const line of d) console.log(`    ${line}`);
  }
} finally {
  rpc.close();
}
