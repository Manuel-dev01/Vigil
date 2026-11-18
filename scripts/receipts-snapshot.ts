/**
 * Build and verify a settlement receipt for every anchored batch of a rollup,
 * and save each one to receipts/<rollupId>/batch-<n>.json. Read-only; needs no key.
 *
 * Batch records are pruned after finalized_batch_retention_blocks (432,000 on
 * testnet), after which a receipt can no longer be built from chain state, so
 * snapshot them while they exist. A saved receipt stays verifiable against the
 * anchor (x/multilayer) for as long as the chain keeps that.
 *
 *   tsx receipts-snapshot.ts [rollupId] [--from N] [--to M]
 */
import "./lib/net.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSettlementReceipt, createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { REPO_ROOT } from "./lib/env.ts";

const args = process.argv.slice(2);
const rollupId = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "vigil-1";
const num = (f: string) => (args.includes(f) ? Number(args[args.indexOf(f) + 1]) : undefined);

const rdk = createRdkClient({ network: "testnet" });
const batches = (await rdk.rest.listBatches(rollupId)).filter((b) => b.status !== "rejected");
const from = num("--from") ?? 0;
const to = num("--to") ?? Math.max(...batches.map((b) => b.batchIndex));
const outDir = resolve(REPO_ROOT, "receipts", rollupId);
mkdirSync(outDir, { recursive: true });

const summary: { batchIndex: number; valid: boolean; failed: string[] }[] = [];
for (const b of batches.filter((x) => x.batchIndex >= from && x.batchIndex <= to)) {
  try {
    const receipt = await buildSettlementReceipt(rdk, rollupId, b.batchIndex);
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
writeFileSync(
  resolve(outDir, "summary.json"),
  JSON.stringify({ rollupId, checkedAt: new Date().toISOString(), height: tip.height, summary }, null, 2) + "\n",
);
console.log(`${summary.filter((s) => s.valid).length} of ${summary.length} receipts valid at height ${tip.height}`);
