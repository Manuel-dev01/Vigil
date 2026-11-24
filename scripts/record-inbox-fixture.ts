/**
 * Record what the inbox reader reads from the chain for one rollup, for the
 * offline tests: every posted-data commitment (null where the chain has pruned
 * it), the raw transactions of each block holding a retained post, the deposit
 * events, the inbox, and the batch records. Read-only.
 *
 *   pnpm --filter @vigil/scripts exec tsx record-inbox-fixture.ts <rollupId>
 *
 * Writes test/vectors/inbox-<rollupId>.json.
 */
import "./lib/net.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRdkClient } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { restInboxSource, type DepositEvent, type PostedData } from "@vigil/core/inbox";
import { REPO_ROOT } from "./lib/env.ts";

const rollupId = process.argv[2];
if (!rollupId) throw new Error("usage: record-inbox-fixture.ts <rollupId>");
const source = restInboxSource(rollupId);
const rest = createRdkClient({ network: "testnet" }).rest;

const inbox = await source.inbox();
const postedData: Record<string, PostedData | null> = {};
const blocks: Record<string, string[]> = {};
const deposits: Record<string, (Omit<DepositEvent, "amount"> & { amount: string })[]> = {};
for (let s = 1; s <= inbox.headSequence; s++) {
  const pd = await source.postedData(s);
  postedData[s] = pd ?? null;
  if (!pd) continue;
  if (pd.poster.startsWith("deposit:")) {
    deposits[pd.height] ??= (await source.deposits(pd.height)).map((d) => ({ ...d, amount: d.amount.toString() }));
  } else {
    blocks[pd.height] ??= (await source.blockTxs(pd.height)).map((t) => Buffer.from(t).toString("base64"));
  }
}
const batches = await rest.listBatches(rollupId);
const out = resolve(REPO_ROOT, "test/vectors", `inbox-${rollupId}.json`);
writeFileSync(
  out,
  JSON.stringify(
    { chainId: TESTNET.chainId, rollupId, recordedAt: new Date().toISOString(), recordedAtHeight: await rest.getLatestHeight(), inbox, postedData, blocks, deposits, batches },
    null,
    1,
  ) + "\n",
);
console.log(`recorded ${out}: ${inbox.headSequence} entries, ${Object.keys(blocks).length} blocks, ${batches.length} batches; ${JSON.stringify(source.requests)}`);
