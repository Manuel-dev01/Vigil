/**
 * Data receipts for inbox posts. Read-only.
 *
 *   tsx src/cli/receipt.ts build --sequence <n> [--rollup vigil-pay-1] [--out <file>]
 *   tsx src/cli/receipt.ts verify --file <receipt.json> [--payload <hex file>] [--live]
 *
 * build writes receipts/<rollup>/data-<n>.json by default. verify checks the
 * fold offline, the payload if given, and with --live the batch on chain.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hexToBytes } from "@qorechain/rdk";
import { buildDataReceipt, checkDataReceiptOnChain, verifyDataReceipt, type DataReceipt } from "../data-receipt.ts";
import { argValue, chainId, fail, repoRoot, rest } from "./common.ts";

const argv = process.argv.slice(2);

function report(r: DataReceipt, payload?: Uint8Array) {
  const v = verifyDataReceipt(r, payload);
  console.log(`inbox entry ${r.sequence} of ${r.rollupId} in batch ${r.batch.batchIndex} (entries ${r.batch.inboxStart + 1}-${r.batch.inboxEnd})`);
  for (const [k, ok] of Object.entries(v.checks)) console.log(`  ${k.padEnd(16)} ${ok ? "ok" : "FAILED"}`);
  console.log(`  offline: ${v.valid ? "VALID" : "INVALID"}`);
  return v.valid;
}

if (argv[0] === "build") {
  const sequence = Number(argValue(argv, "--sequence"));
  const rollupId = argValue(argv, "--rollup") ?? "vigil-pay-1";
  if (!Number.isInteger(sequence) || sequence < 1) fail("usage: receipt.ts build --sequence <n> [--rollup id] [--out file]");
  const r = await buildDataReceipt(rest, { chainId, rollupId }, sequence);
  const ok = report(r);
  const live = await checkDataReceiptOnChain(rest, r);
  console.log(`  live: ${live.detail}`);
  const out = argValue(argv, "--out") ?? resolve(repoRoot, "receipts", rollupId, `data-${sequence}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
  console.log(`written to ${out}`);
  process.exit(ok && live.onChain ? 0 : 2);
} else if (argv[0] === "verify") {
  const file = argValue(argv, "--file");
  if (!file) fail("usage: receipt.ts verify --file <receipt.json> [--payload <hex file>] [--live]");
  const r = JSON.parse(readFileSync(file, "utf8")) as DataReceipt;
  const payloadPath = argValue(argv, "--payload");
  const payload = payloadPath ? hexToBytes(readFileSync(payloadPath, "utf8").trim()) : undefined;
  let ok = report(r, payload);
  if (argv.includes("--live")) {
    const live = await checkDataReceiptOnChain(rest, r);
    console.log(`  live: ${live.detail}${live.finalized ? "" : " (not finalized)"}`);
    ok = ok && live.finalized;
  }
  process.exit(ok ? 0 : 2);
} else {
  fail("usage: receipt.ts build --sequence <n> [--rollup id] [--out file] | verify --file <receipt.json> [--payload <hex file>] [--live]");
}
