/**
 * Replay a qledger-v1 rollup from chain data the way Keel does (sync.ts, from
 * an empty ledger, every batch root checked) three ways, and count the REST
 * requests each makes:
 *
 *   rdk      the previous path: RDK 0.9.0's fetchQledgerEntries per batch
 *            (transaction search over every post the rollup has had)
 *   reader   the inbox reader, chain only (by sequence, no archive)
 *   archive  the inbox reader seeded with data/inbox/<rollupId>.jsonl (or --seed <file>)
 *
 * With --plan <rollupId> it also plans the next batch of that rollup with the
 * RDK's planQledgerBatch and with Keel's planBatch and compares them (it needs
 * entries waiting in that rollup's inbox). Read-only: GET requests only.
 *
 *   pnpm --filter @vigil/scripts exec tsx inbox-replay-check.ts [rollupId] [--seed <archive>] [--plan <rollupId>]
 */
import "./lib/net.ts";
import { EMPTY_INBOX_ACC, QledgerLedger, bytesToHex, createRdkClient, fetchQledgerEntries, planQledgerBatch, type RestClient } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";
import { InboxReader, openInboxReader, restInboxSource } from "@vigil/core/inbox";
import { planBatch } from "../packages/keel/src/plan.ts";
import { emptyState } from "../packages/keel/src/snapshot.ts";
import { chainView, syncFrom, type ChainView } from "../packages/keel/src/sync.ts";

const args = process.argv.slice(2);
const rollupId = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--plan" && args[i - 1] !== "--seed") ?? "vigil-pay-1";
const planRollup = args.includes("--plan") ? args[args.indexOf("--plan") + 1] : undefined;
const seed = args.includes("--seed") ? args[args.indexOf("--seed") + 1] : undefined;
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();

// Count every request, by route.
const counts = new Map<string, number>();
const inner = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const route = new URL(url).pathname.replace(/\/\d+(\/|$)/g, "/N$1").replace(new RegExp(`/${rollupId}|/${planRollup ?? "\u0000"}`, "g"), "/R");
  counts.set(route, (counts.get(route) ?? 0) + 1);
  return inner(input, init);
}) as typeof fetch;
const take = () => {
  const out = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  counts.clear();
  return { total, byRoute: out };
};

const rest: RestClient = createRdkClient({ network: "testnet" }).rest;
const env = { chainId: TESTNET.chainId, rollupId };

async function replay(label: string, view: ChainView): Promise<boolean> {
  counts.clear();
  const t0 = Date.now();
  const latest = await rest.getLatestBatch(rollupId);
  let r: Awaited<ReturnType<typeof syncFrom>>;
  try {
    r = await syncFrom(view, env, emptyState());
  } catch (err) {
    console.log(`${label.padEnd(8)} FAILED: ${(err as Error).message}; ${take().total} requests`);
    return false;
  }
  const ok = !r.blocked && hex(r.state.ledger.root()) === latest.stateRoot.toLowerCase().replace(/^0x/, "");
  const c = take();
  console.log(
    `${label.padEnd(8)} ${ok ? "OK" : "FAILED"}: ${r.replayed} batches replayed to batch ${r.state.batchIndex} (inbox ${r.state.inboxEnd}), ` +
      `root ${hex(r.state.ledger.root()).slice(0, 16)}… ${ok ? "=" : "≠"} latest batch ${latest.batchIndex}; ${c.total} requests in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  console.log(`         ${JSON.stringify(c.byRoute)}`);
  return ok;
}

const rdkView: ChainView = {
  ...chainView(rest, env, new InboxReader(env, restInboxSource(rollupId))),
  async entries(from, to) {
    const accFrom = from === 0 ? EMPTY_INBOX_ACC : (await rest.getPostedData(rollupId, from)).inboxAcc;
    return fetchQledgerEntries(rest, { ...env, from, to, accFrom });
  },
};
delete (rdkView as { firstBatchFrom?: unknown }).firstBatchFrom;

let ok = true;
ok = (await replay("rdk", rdkView)) && ok;
ok = (await replay("reader", chainView(rest, env, new InboxReader(env, restInboxSource(rollupId))))) && ok;
ok = (await replay("archive", chainView(rest, env, openInboxReader(env, seed ? { seeds: [seed] } : {})))) && ok;

if (planRollup) {
  const penv = { chainId: TESTNET.chainId, rollupId: planRollup };
  const rollup = await rest.getRollup(planRollup);
  const inbox = await rest.getInbox(planRollup);
  console.log(`plan ${planRollup}: inbox consumed ${inbox.consumedSequence}, head ${inbox.headSequence}; submitter ${rollup.creator} (bond and pending read only)`);
  const ledger = new QledgerLedger(); // only valid before the rollup's first batch
  counts.clear();
  const a = await planQledgerBatch(rest, { ...penv, submitter: rollup.creator, ledger });
  const ca = take();
  const preader = new InboxReader(penv, restInboxSource(planRollup));
  const b = await planBatch(rest, preader, { ...penv, submitter: rollup.creator, ledger });
  const cb = take();
  // Keel plans with one long-lived reader: the next pass reads only entries it has not seen.
  await planBatch(rest, preader, { ...penv, submitter: rollup.creator, ledger });
  const warm = take();
  await planQledgerBatch(rest, { ...penv, submitter: rollup.creator, ledger });
  const warmRdk = take();
  const same =
    a.input.batchIndex === b.input.batchIndex &&
    a.input.inboxEnd === b.input.inboxEnd &&
    a.input.txCount === b.input.txCount &&
    hex(a.input.stateRoot) === hex(b.input.stateRoot) &&
    hex(a.input.dataHash) === hex(b.input.dataHash) &&
    hex(a.input.withdrawalsRoot) === hex(b.input.withdrawalsRoot) &&
    a.entries.every((e, i) => hex(e.payload) === hex(b.entries[i]!.payload) && e.poster === b.entries[i]!.poster && BigInt(e.height) === BigInt(b.entries[i]!.height));
  console.log(
    `plan     ${same ? "SAME" : "DIFFERENT"}: batch ${b.input.batchIndex}, entries ${inbox.consumedSequence + 1}..${b.input.inboxEnd} (${b.input.txCount}), ` +
      `state ${hex(b.input.stateRoot).slice(0, 16)}…, data hash ${hex(b.input.dataHash).slice(0, 16)}…; ` +
      `RDK ${ca.total} requests, planBatch ${cb.total} cold; planned again: RDK ${warmRdk.total}, planBatch ${warm.total}`,
  );
  console.log(`         RDK ${JSON.stringify(ca.byRoute)}`);
  console.log(`         planBatch ${JSON.stringify(cb.byRoute)}`);
  ok = same && ok;
}
process.exit(ok ? 0 : 1);
