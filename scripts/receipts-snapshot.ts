/**
 * Build and verify a settlement receipt for every anchored batch of a rollup,
 * and save each one to receipts/<rollupId>/batch-<n>.json. Read-only; needs no key.
 *
 * Batch records are pruned after finalized_batch_retention_blocks (432,000 on
 * testnet), after which a receipt can no longer be built from chain state, so
 * snapshot them while they exist. A saved receipt stays verifiable against the
 * anchor (x/multilayer) for as long as the chain keeps that.
 *
 * A batch with no anchor of its own (one submitted by a bonded account other
 * than the creator) has no receipt, and is listed under `unanchored` in
 * summary.json.
 *
 * The public node is shared, so the script asks it about once a second
 * (--gap-ms) and reads each URL once per run.
 *
 * Only a run over every batch rewrites summary.json; a run limited with
 * --from/--to rewrites its receipts and leaves summary.json as it was.
 *
 *   tsx receipts-snapshot.ts [rollupId] [--from N] [--to M] [--gap-ms 1000]
 *
 * rollupId defaults to vigil-pay-1.
 */
import "./lib/net.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { REPO_ROOT } from "./lib/env.ts";
import { bindOwnAnchor, coversAll, politeFetch } from "./lib/receipts.ts";

const args = process.argv.slice(2);
const num = (f: string) => (args.includes(f) ? Number(args[args.indexOf(f) + 1]) : undefined);
const rollupId = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "vigil-pay-1";

const fetch = politeFetch(globalThis.fetch, { gapMs: num("--gap-ms") ?? 1000 });
const rdk = createRdkClient({ network: "testnet", fetch });
const batches = (await rdk.rest.listBatches(rollupId)).filter((b) => b.status !== "rejected");
const rollup = await rdk.rest.getRollup(rollupId);
const anchors = await rdk.rest.getAnchors(rollup.layerId);
const from = num("--from") ?? 0;
const to = num("--to") ?? Math.max(...batches.map((b) => b.batchIndex));
const outDir = resolve(REPO_ROOT, "receipts", rollupId);
mkdirSync(outDir, { recursive: true });

const summary: { batchIndex: number; valid: boolean; failed: string[] }[] = [];
const unanchored: number[] = [];
for (const b of batches.filter((x) => x.batchIndex >= from && x.batchIndex <= to)) {
  if (!anchors.some((a) => a.layerHeight === b.batchIndex)) {
    unanchored.push(b.batchIndex);
    console.log(`batch ${b.batchIndex}: no anchor of its own, so no receipt`);
    continue;
  }
  try {
    const receipt = bindOwnAnchor(await buildSettlementReceipt(rdk, rollupId, b.batchIndex), anchors);
    if (!receipt) throw new Error(`no anchor at layer height ${b.batchIndex} carries this batch's state root`);
    const v = await verifySettlementReceipt(receipt, { client: rdk });
    const failed = Object.entries(v.checks).filter(([, ok]) => ok === false).map(([k]) => k);
    writeFileSync(resolve(outDir, `batch-${b.batchIndex}.json`), JSON.stringify(receipt, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
    summary.push({ batchIndex: b.batchIndex, valid: v.valid, failed });
    console.log(`batch ${b.batchIndex}: receipt ${v.valid ? "VALID" : "INVALID"} (mode ${v.mode})${failed.length ? ` failed: ${failed.join(",")}` : ""}`);
  } catch (e) {
    summary.push({ batchIndex: b.batchIndex, valid: false, failed: [String((e as Error).message).slice(0, 160)] });
    console.log(`batch ${b.batchIndex}: ERROR ${(e as Error).message}`);
  }
}
const tip = await rdk.getChainTip();
if (coversAll(from, to, batches.map((b) => b.batchIndex))) {
  writeFileSync(
    resolve(outDir, "summary.json"),
    JSON.stringify({ rollupId, checkedAt: new Date().toISOString(), height: tip.height, summary, unanchored }, null, 2) + "\n",
  );
} else console.log(`batches ${from} to ${to} only: summary.json left as it was`);
console.log(`${summary.filter((s) => s.valid).length} of ${summary.length} receipts valid at height ${tip.height}; ${unanchored.length} batches with no anchor of their own; ${fetch.requests()} requests to the node`);
