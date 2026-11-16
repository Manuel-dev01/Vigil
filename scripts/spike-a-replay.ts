/**
 * Spike A: rebuild a qledger-v1 rollup from chain data alone and check that
 * every published batch matches its re-execution. Read-only; needs no key.
 *
 *   pnpm --filter @vigil/scripts spike:a [rollupId] [--record]
 *
 * --record writes test/vectors/replay-<rollupId>.json for the offline test.
 */
import "./lib/net.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, createRdkClient, fetchQledgerEntries } from "@qorechain/rdk";
import { EMPTY_ACC_HEX, allOk, checkBatches, type ReplayVector } from "./lib/replay.ts";

const CHAIN_ID = "qorechain-diana";
const args = process.argv.slice(2);
const rollupId = args.find((a) => !a.startsWith("--")) ?? "rdk-v328-e2e-mwd5v89d";
const record = args.includes("--record");

const rdk = createRdkClient({ network: "testnet" });
const rest = rdk.rest;

const rollup = await rest.getRollup(rollupId);
const inbox = await rest.getInbox(rollupId);
const batches = (await rest.listBatches(rollupId)).filter((b) => b.status !== "rejected");
const tip = await rdk.getChainTip();
console.log(
  `rollup ${rollupId}: vm=${rollup.executionVm ?? "?"} sequencing=${rollup.sequencing ?? "?"} ` +
    `inbox head=${inbox.headSequence} consumed=${inbox.consumedSequence}; ${batches.length} live batches; tip ${tip.height}`,
);

// Inbox accumulators at every position, from the chain's own commitments.
const inboxAcc: Record<string, string> = { "0": EMPTY_ACC_HEX };
for (let s = 1; s <= inbox.headSequence; s++) {
  inboxAcc[String(s)] = (await rest.getPostedData(rollupId, s)).inboxAcc.toLowerCase();
}

// Entries 1..head, read back from the posting transactions and checked by the RDK.
const raw = await fetchQledgerEntries(rest, {
  chainId: CHAIN_ID,
  rollupId,
  from: 0,
  to: inbox.headSequence,
  accFrom: EMPTY_ACC_HEX,
});
const entries = raw.map((e, i) => ({
  sequence: i + 1,
  height: Number(e.height),
  poster: e.poster,
  payloadHex: bytesToHex(e.payload).toLowerCase(),
}));

const vector: ReplayVector = {
  chainId: CHAIN_ID,
  rollupId,
  recordedAt: new Date().toISOString(),
  recordedAtHeight: Number(tip.height),
  inboxAcc,
  entries,
  batches: batches.map((b) => ({
    batchIndex: b.batchIndex,
    status: b.status,
    inboxStart: b.inboxStart,
    inboxEnd: b.inboxEnd,
    prevStateRoot: b.prevStateRoot,
    stateRoot: b.stateRoot,
    withdrawalsRoot: b.withdrawalsRoot,
    dataHash: b.dataHash,
    txCount: b.txCount,
  })),
};

const { checks, ledger } = checkBatches(vector);
let failed = 0;
for (const c of checks) {
  const ok = allOk(c);
  if (!ok) failed++;
  console.log(
    `batch ${c.batchIndex}: ${ok ? "MATCH" : "MISMATCH"}  prev=${c.prevStateRootOk} state=${c.stateRootOk} ` +
      `withdrawals=${c.withdrawalsRootOk} data_hash=${c.dataHashOk} acc=${c.accOk}  ` +
      `(state ${c.computed.stateRoot.slice(0, 16)}…, ${c.computed.withdrawals} withdrawal(s))`,
  );
}

// What the next batch would have to publish, if anything is waiting.
const last = checks.at(-1);
const consumed = vector.batches.reduce((m, b) => Math.max(m, b.inboxEnd), 0);
if (inbox.headSequence > consumed) {
  console.log(`entries ${consumed + 1}..${inbox.headSequence} are waiting; the next batch would publish:`);
  const pending = checkBatches({
    ...vector,
    batches: [
      ...vector.batches,
      {
        batchIndex: (last?.batchIndex ?? -1) + 1,
        status: "planned",
        inboxStart: consumed,
        inboxEnd: inbox.headSequence,
        prevStateRoot: bytesToHex(ledger.root()),
        stateRoot: "",
        withdrawalsRoot: "",
        dataHash: "",
        txCount: inbox.headSequence - consumed,
      },
    ],
  }).checks.at(-1);
  console.log(JSON.stringify(pending?.computed, null, 2));
} else {
  console.log("inbox fully consumed: nothing waiting for a batch");
}

if (record) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../test/vectors", `replay-${rollupId}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(vector, null, 2) + "\n");
  console.log(`recorded ${out}`);
}

process.exit(failed === 0 ? 0 : 1);
