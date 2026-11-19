/**
 * Fraud drill on vigil-pay-1: a bonded "evil" submitter publishes a batch with a
 * deliberately wrong state root; our watchtowers must challenge it and the chain
 * must slash the bond (50% burned, 50% to the challenger).
 *
 * Drill 1 was approved in writing by Manuel on 19 Nov 2026, with the key in
 * repo/.env.evil-submitter (on Manuel's machine). Drill 2 was approved by OoJae
 * on 19 Nov 2026 (OoJae approves spending since the handover), with a fresh key
 * in repo/.env.evil-submitter-2. One drill per approval. Every step simulates
 * unless --broadcast.
 *
 *   tsx drill/fraud-drill.ts status [--role evil-submitter-2]
 *   tsx drill/fraud-drill.ts bond   [--role …] [--broadcast]   # bond 1,000 QOR
 *   tsx drill/fraud-drill.ts attack [--role …] [--broadcast]   # post a no-op, then submit the wrong batch
 *   tsx drill/fraud-drill.ts watch  [--role …]                  # follow the batch until rejected or finalized
 *
 * The evil account first needs its PQ key: tsx drill/register-pqc.ts --role <role> --broadcast
 *
 * Before submitting, the script builds our watchtower's fraud proof against the
 * wrong batch and checks it with checkQledgerFraud: the drill only goes ahead
 * if the chain is certain to uphold the challenge.
 */
import "../lib/net.ts";
import { bondRollupSubmitterMsg, createRdkClient, createRdkRegistry, postRollupDataMsg, submitBatchMsg } from "@qorechain/rdk";
import { InboxArchive, RollupTracker, chainSource, checkBatch, buildChallenge, type PublishedBatch } from "@vigil/qledger-watchtower";
import { balances, getJson, loadRoleAccount, sendHybrid } from "../lib/native.ts";

const ROLLUP = "vigil-pay-1";
const BOND_UQOR = 1_000_000_000n;
const args = process.argv.slice(2);
const step = args[0] ?? "status";
const broadcast = args.includes("--broadcast");

const rdk = createRdkClient({ network: "testnet" });
const env = { chainId: rdk.network.chainId, rollupId: ROLLUP };
const role = args.includes("--role") ? args[args.indexOf("--role") + 1]! : "evil-submitter";
if (!/^evil-submitter(-\d+)?$/.test(role)) throw new Error(`--role must be an evil-submitter account, got ${role}`);
const evil = await loadRoleAccount(role);
const flip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bond(): Promise<bigint> {
  try {
    return BigInt((await getJson<{ amount: string }>(`/qorechain/rdk/v1/submitter_bond/${ROLLUP}/${evil.cosmos}`)).amount);
  } catch {
    return 0n;
  }
}

async function status() {
  const inbox = await rdk.rest.getInbox(ROLLUP);
  const latest = await rdk.rest.getLatestBatch(ROLLUP);
  console.log(`evil ${evil.cosmos}: ${JSON.stringify(await balances(evil.cosmos))}; bond ${Number(await bond()) / 1e6} QOR`);
  console.log(`inbox head ${inbox.headSequence} consumed ${inbox.consumedSequence}; latest batch ${latest.batchIndex} (${latest.status}) root ${latest.stateRoot.slice(0, 16)}…`);
  return { inbox, latest };
}

switch (step) {
  case "status":
    await status();
    break;

  case "bond": {
    const have = await bond();
    console.log(`plan: bond ${Number(BOND_UQOR) / 1e6} QOR from ${evil.cosmos} on ${ROLLUP} (currently bonded ${Number(have) / 1e6})`);
    if (have >= BOND_UQOR) { console.log("already bonded"); break; }
    if (!broadcast) break;
    const res = await sendHybrid(evil, [bondRollupSubmitterMsg({ submitter: evil.cosmos, rollupId: ROLLUP, amount: BOND_UQOR.toString() })], { gas: 400_000, memo: "vigil fraud drill: bond", registry: createRdkRegistry() });
    console.log(`bond tx ${res.transactionHash} height ${res.height}`);
    break;
  }

  case "attack": {
    if ((await bond()) < BOND_UQOR) throw new Error("evil submitter is not bonded");
    const tracker = new RollupTracker(env, chainSource(rdk.rest, env, rdk.network.endpoints.rest), new InboxArchive(env));
    await tracker.sync();

    for (let attempt = 1; attempt <= 3; attempt++) {
      // 1. A no-op post (not a qledger tx): execution leaves the state unchanged.
      const payload = new TextEncoder().encode(`vigil fraud drill ${new Date().toISOString()} attempt ${attempt}`);
      console.log(`attempt ${attempt}: plan: post ${payload.length} B no-op, then submit a batch over it with a WRONG state root`);
      if (!broadcast) {
        const { inbox, latest } = await status();
        console.log(`dry run: would build batch ${latest.batchIndex + 1} from consumed ${inbox.consumedSequence} to head+1`);
        break;
      }
      const post = await sendHybrid(evil, [postRollupDataMsg({ poster: evil.cosmos, rollupId: ROLLUP, data: payload })], { gas: 300_000, memo: "vigil fraud drill: post", registry: createRdkRegistry() });
      console.log(`post tx ${post.transactionHash} height ${post.height}`);

      // 2. Build the honest batch over [consumed, head], then corrupt its state root.
      const inbox = await rdk.rest.getInbox(ROLLUP);
      if (inbox.consumedSequence >= inbox.headSequence) { console.log("Keel already batched the post; retrying"); await sleep(3000); continue; }
      const latest = await rdk.rest.getLatestBatch(ROLLUP);
      await tracker.sync();
      await tracker.ensureEntries(inbox.headSequence);
      const parent = tracker.ledgerFor(latest.stateRoot);
      if (!parent) throw new Error(`no honest state for the latest batch root ${latest.stateRoot}`);
      const accFrom = tracker.archive.accAt(inbox.consumedSequence)!;
      const accTo = tracker.archive.accAt(inbox.headSequence)!;
      const entries = tracker.archive.range(inbox.consumedSequence, inbox.headSequence);
      const probe: PublishedBatch = { batchIndex: latest.batchIndex + 1, inboxStart: inbox.consumedSequence, inboxEnd: inbox.headSequence, prevStateRoot: latest.stateRoot, stateRoot: "", withdrawalsRoot: "", dataHash: "" };
      const honest = checkBatch(env, parent, accFrom, accTo, entries, probe).honest;
      const chainRange = (await rdk.rest.getInbox(ROLLUP, inbox.headSequence)).rangeDataHash.toLowerCase();
      if (honest.dataHash !== chainRange) throw new Error(`data hash mismatch: ours ${honest.dataHash} chain ${chainRange}`);
      const evilBatch: PublishedBatch = { ...probe, stateRoot: flip(honest.stateRoot), withdrawalsRoot: honest.withdrawalsRoot, dataHash: honest.dataHash };

      // 3. Proceed only if our watchtower's proof against it would be upheld.
      const c = buildChallenge(env, parent, accFrom, entries, evilBatch);
      console.log(`wrong batch ${evilBatch.batchIndex}: honest root ${honest.stateRoot.slice(0, 16)}…, published ${evilBatch.stateRoot.slice(0, 16)}…; fraud proof ${c.proof.length} B upheld by checkQledgerFraud: ${c.wins}`);
      if (!c.wins) throw new Error("the challenge would not be upheld; aborting the drill");

      const res = await sendHybrid(evil, [submitBatchMsg({
        sequencer: evil.cosmos,
        rollupId: ROLLUP,
        batchIndex: evilBatch.batchIndex,
        prevStateRoot: evilBatch.prevStateRoot,
        stateRoot: evilBatch.stateRoot,
        txCount: evilBatch.inboxEnd - evilBatch.inboxStart,
        dataHash: evilBatch.dataHash,
        withdrawalsRoot: evilBatch.withdrawalsRoot,
        inboxEnd: evilBatch.inboxEnd,
      })], { gas: 600_000, memo: "vigil fraud drill: deliberately wrong batch", registry: createRdkRegistry() }).catch((e: Error) => {
        console.log(`submit failed: ${e.message.slice(0, 200)}`);
        return undefined;
      });
      if (!res) { await sleep(3000); continue; }
      console.log(`EVIL BATCH ${evilBatch.batchIndex} submitted: tx ${res.transactionHash} height ${res.height}. Now run: tsx drill/fraud-drill.ts watch --role ${role}`);
      break;
    }
    break;
  }

  case "watch": {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < 70 * 60_000) {
      const batches = await rdk.rest.listBatches(ROLLUP);
      const line = batches.slice(-3).map((b) => `${b.batchIndex}:${b.status}:${b.stateRoot.slice(0, 8)}`).join(" ") + ` | evil bond ${Number(await bond()) / 1e6} QOR`;
      if (line !== last) { console.log(`${new Date().toISOString()} ${line}`); last = line; }
      if (batches.some((b) => b.status === "rejected")) { console.log("a batch was REJECTED: challenge upheld"); break; }
      await sleep(5000);
    }
    break;
  }

  default:
    console.error("usage: fraud-drill.ts <status|bond|attack|watch> [--broadcast]");
    process.exit(2);
}
