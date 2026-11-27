/**
 * Run the BUILT browser-watchtower worker (dist/assets/worker-*.js) on vigil-pay-1's recorded history,
 * exactly as the page drives it. The worker is built with side-effect-free tree-shaking
 * (vite.config.ts), which cut it from about 1.4 MB to about 73 kB; this proves the cut kept everything
 * re-execution needs (ML-DSA-44 checks, the state tree, fraud proofs). No network.
 *
 *   pnpm --filter @vigil/web build && pnpm --filter @vigil/web smoke:worker
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hexToBytes } from "@qorechain/rdk";
import { executedFrom, fraudsFrom, parseArchive, submissionsFrom, type TxResponse } from "../src/replay/chain-data.ts";
import type { BatchRecord, AnchorLite, Lookup, ReplayInput, ReplayResult } from "../src/replay/core.ts";
import type { ForgeAnswer, ReplayRequest, ReplayResponse } from "../src/replay/worker.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "replay-vigil-pay-1.json"), "utf8")) as {
  chainId: string;
  rollupId: string;
  rollup: { depositPool: string };
  inbox: { headAcc: string };
  entries: { sequence: number; height: number; poster: string; payloadHex: string }[];
  batches: BatchRecord[];
  anchors: AnchorLite[];
  submitTxs: TxResponse[];
  fraudTxs: TxResponse[];
  executedTxs: TxResponse[];
};
const env = { chainId: fx.chainId, rollupId: fx.rollupId };
const archive = parseArchive(readFileSync(join(here, "..", "..", "..", "data", "inbox", "vigil-pay-1.jsonl"), "utf8"), env);
const input: ReplayInput = {
  env,
  entries: [...archive, ...fx.entries].map((e) => ({ sequence: e.sequence, height: e.height, poster: e.poster, payload: hexToBytes(e.payloadHex) })),
  headAcc: fx.inbox.headAcc,
  records: fx.batches,
  submissions: submissionsFrom(fx.submitTxs, fx.rollupId),
  anchors: fx.anchors,
  frauds: fraudsFrom(fx.fraudTxs, fx.rollupId),
  executed: executedFrom(fx.executedTxs, fx.rollupId),
  depositPool: fx.rollup.depositPool,
};

// The worker's globals, as a Web Worker has them.
const listeners: ((ev: { data: unknown }) => void)[] = [];
let answer: ReplayResponse | undefined;
const g = globalThis as unknown as { addEventListener: unknown; postMessage: unknown };
g.addEventListener = (_type: string, f: (ev: { data: unknown }) => void) => listeners.push(f);
g.postMessage = (m: ReplayResponse) => (answer = structuredClone(m));

const assets = join(here, "..", "dist", "assets");
const file = readdirSync(assets).find((f) => /^worker-[\w-]+\.js$/.test(f));
if (!file) throw new Error("no built worker in apps/web/dist/assets: run the web build first");
await import(pathToFileURL(join(assets, file)).href);

function ask<T>(req: ReplayRequest): T {
  answer = undefined;
  for (const f of listeners) f({ data: structuredClone(req) });
  if (!answer) throw new Error(`${req.kind}: no answer`);
  const a = answer as ReplayResponse;
  if (!a.ok) throw new Error(`${req.kind}: ${a.error}`);
  return a.value as T;
}
function expect(what: string, ok: boolean): void {
  if (!ok) throw new Error(`worker smoke test failed: ${what}`);
  console.log(`ok  ${what}`);
}

const r = ask<ReplayResult>({ id: 1, kind: "run", input });
expect(`${r.counts.keptReproduced} of ${r.counts.kept} kept batches reproduced (26 of 26 recorded)`, r.counts.kept === 26 && r.counts.keptReproduced === 26);
expect(`both rolled-back drill batches caught on their state root`, r.counts.rolledBackCaught === 2 && r.rows.filter((x) => x.where === "rolled back").every((x) => x.mismatches.join() === "stateRoot"));
expect(`L2 owes ${r.solvency?.owed} uqor, the pool holds ${r.solvency?.pool}`, r.solvency?.surplus === "0");
const l = ask<Lookup>({ id: 2, kind: "lookup", account: r.accounts[0]!.id });
expect(`account ${l.id.slice(0, 8)}… opened against batch ${l.batchIndex}'s root`, l.root === r.lookupRoot?.root);
const row = r.rows.find((x) => x.transfers.length > 0)!;
const f = ask<ForgeAnswer>({ id: 3, kind: "forge", key: row.key, sequence: row.transfers[0]!.sequence, amount: row.transfers[0]!.max });
expect(`forged batch ${f.batchIndex}: proof wins against the forgery and loses against the real batch`, f.wins && !f.winsAgainstReal && f.forgedRoot !== f.honestRoot);
expect(
  `challenge printed with ${f.gas} gas and ${f.feeUqor} uqor, --generate-only, co-signing as a comment`,
  f.command.includes(`--gas ${f.gas} --fees ${f.feeUqor}uqor --generate-only`) && f.command.split("\n").every((l) => l.startsWith("#") || !l.includes("cosign")),
);
console.log(`${file}: re-executed in ${r.ms} ms`);
