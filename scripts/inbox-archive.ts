/**
 * Build, extend or check a rollup's committed inbox archive,
 * data/inbox/<rollupId>.jsonl (public chain data: every inbox entry with the
 * chain's accumulator after it). Read-only toward the chain.
 *
 *   pnpm --filter @vigil/scripts exec tsx inbox-archive.ts [rollupId] [--check] [--out <file>]
 *
 * Reads every entry after the archive's last row from the chain, by sequence,
 * each checked against the chain's inbox accumulator, and appends it. Then
 * checks the whole archive against every commitment the chain still holds:
 * the accumulator of each retained entry, the inbox head, and the inbox range
 * hash of each batch record. --check writes nothing and only checks.
 * Exits 1 if anything does not match.
 *
 * Run it now and then (the chain prunes an entry's commitment after
 * posted_data_retention_blocks, 648,000 blocks on testnet), and commit the file.
 */
import "./lib/net.ts";
import { existsSync } from "node:fs";
import { createRdkClient, hexToBytes, inboxRangeHash, bytesToHex } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { committedArchivePath, openInboxReader, restInboxSource } from "@vigil/core/inbox";

const args = process.argv.slice(2);
const rollupId = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out") ?? "vigil-pay-1";
const check = args.includes("--check");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1]! : committedArchivePath(rollupId);
const env = { chainId: TESTNET.chainId, rollupId };

const source = restInboxSource(rollupId);
const log = (event: string, fields: Record<string, unknown>) => console.log(event, JSON.stringify(fields));
const reader = openInboxReader(env, check ? { source, seeds: [out], log } : { source, archivePath: out, seeds: [], log });
const before = reader.archive.head;
if (check && !existsSync(out)) throw new Error(`${out} does not exist`);

const inbox = await source.inbox();
const tip = await createRdkClient({ network: "testnet" }).rest.getLatestHeight();
console.log(`${rollupId}: inbox head ${inbox.headSequence}, consumed ${inbox.consumedSequence}; archive ${out} holds ${before} entries; tip ${tip}`);
if (!check) {
  await reader.read(0, inbox.headSequence);
  console.log(`read and confirmed 1..${inbox.headSequence}: ${reader.archive.head - before} new entries appended`);
}

// Check every row against every commitment the chain still holds.
const a = reader.archive;
let problems = 0;
let retained = 0;
let pruned = 0;
for (let s = 1; s <= Math.min(a.head, inbox.headSequence); s++) {
  const pd = await source.postedData(s);
  if (!pd) {
    pruned++;
    continue;
  }
  retained++;
  if (pd.inboxAcc !== a.accAt(s)) {
    problems++;
    console.error(`MISMATCH entry ${s}: chain accumulator ${pd.inboxAcc}, archive ${a.accAt(s)}`);
  }
}
if (a.head >= inbox.headSequence && a.accAt(inbox.headSequence) !== inbox.headAcc) {
  problems++;
  console.error(`MISMATCH inbox head ${inbox.headSequence}: chain ${inbox.headAcc}, archive ${a.accAt(inbox.headSequence)}`);
}
const batches = (await createRdkClient({ network: "testnet" }).rest.listBatches(rollupId)).filter((b) => b.status !== "rejected");
let batchChecked = 0;
for (const b of batches) {
  const accFrom = a.accAt(b.inboxStart);
  const accTo = a.accAt(b.inboxEnd);
  if (!accFrom || !accTo) continue;
  const h = bytesToHex(inboxRangeHash({ ...env, from: b.inboxStart, to: b.inboxEnd, accFrom: hexToBytes(accFrom), accTo: hexToBytes(accTo) })).toLowerCase();
  batchChecked++;
  if (h !== b.dataHash.toLowerCase().replace(/^0x/, "")) {
    problems++;
    console.error(`MISMATCH batch ${b.batchIndex} (${b.inboxStart}..${b.inboxEnd}): range hash ${h}, chain ${b.dataHash}`);
  }
}
console.log(
  `checked ${a.head} archived entries: ${retained} against their retained commitments (${pruned} pruned on chain), ` +
    `${batchChecked} batch range hashes, the inbox head; ${problems} problem(s); ${JSON.stringify(source.requests)} requests`,
);
process.exit(problems === 0 && (check || a.head >= inbox.headSequence) ? 0 : 1);
