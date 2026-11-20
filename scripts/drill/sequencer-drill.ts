/**
 * Kill-the-sequencer drill on vigil-pay-1: the creator's Keel stops, and a
 * standby Keel with its own bonded key (role `keel-b`) keeps the rollup moving.
 *
 *   tsx drill/sequencer-drill.ts status                 # accounts, bond, windows, inbox
 *   tsx drill/sequencer-drill.ts bond [--broadcast]     # keel-b bonds min_submitter_bond (1,000 QOR)
 *   tsx drill/sequencer-drill.ts batches [--last 12]    # who submitted each recent batch, anchored or not
 *
 * The standby needs its ML-DSA-87 key first: tsx drill/register-pqc.ts --role keel-b --broadcast
 * Neither account ever opens an EVM window; every step refuses to run if one has.
 */
import "../lib/net.ts";
import { bondRollupSubmitterMsg, createRdkClient, createRdkRegistry } from "@qorechain/rdk";
import { REST, balances, getJson, loadRoleAccount, sendHybrid, windowStatus } from "../lib/native.ts";

const ROLLUP = "vigil-pay-1";
const args = process.argv.slice(2);
const step = args[0];
const broadcast = args.includes("--broadcast");
const lastN = args.includes("--last") ? Number(args[args.indexOf("--last") + 1]) : 12;

const rdk = createRdkClient({ network: "testnet" });
const rollup = await rdk.rest.getRollup(ROLLUP);
const standby = await loadRoleAccount("keel-b");
if (standby.cosmos === rollup.creator) throw new Error("the standby must not be the creator");
const qor = (u: string | bigint) => `${(Number(u) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;

for (const [name, addr] of [["creator", rollup.creator], ["keel-b", standby.cosmos]] as const) {
  const w = await windowStatus(addr);
  if (w.found && w.live) throw new Error(`${name} ${addr} HAS A LIVE EVM WINDOW; close it first`);
}

switch (step) {
  case "status": {
    const [params, bondB, bondC, inbox, pqc, bal] = await Promise.all([
      rdk.rest.getParams(),
      rdk.rest.getSubmitterBond(ROLLUP, standby.cosmos),
      rdk.rest.getSubmitterBond(ROLLUP, rollup.creator),
      rdk.rest.getInbox(ROLLUP),
      getJson<{ found?: boolean; account?: { possession_proven: boolean } }>(`/qorechain/pqc/v1/account/${standby.cosmos}`),
      balances(standby.cosmos).catch(() => ({}) as Record<string, string>),
    ]);
    console.log(`rollup ${ROLLUP}: ${rollup.status}, ${rollup.sequencing}; inbox head ${inbox.headSequence}, consumed ${inbox.consumedSequence}`);
    console.log(`min_submitter_bond ${qor(params.minSubmitterBond ?? "0")}`);
    console.log(`creator ${rollup.creator}: bond ${qor(bondC.amount)}; no EVM window`);
    console.log(`keel-b  ${standby.cosmos}: ${qor(bal["uqor"] ?? "0")} liquid, bond ${qor(bondB.amount)}, PQ key ${pqc.found ? (pqc.account?.possession_proven ? "registered, possession proven" : "registered, NO possession proof") : "not registered"}; no EVM window`);
    break;
  }
  case "bond": {
    const params = await rdk.rest.getParams();
    const amount = params.minSubmitterBond ?? "1000000000";
    const bal = BigInt((await balances(standby.cosmos))["uqor"] ?? "0");
    console.log(`plan: keel-b ${standby.cosmos} bonds ${qor(amount)} on ${ROLLUP} (MsgBondRollupSubmitter, hybrid-signed); balance ${qor(bal)}`);
    if (bal < BigInt(amount) + 1_000_000n) throw new Error("keel-b needs the bond plus about 1 QOR for fees");
    if (!broadcast) break;
    const res = await sendHybrid(standby, [bondRollupSubmitterMsg({ submitter: standby.cosmos, rollupId: ROLLUP, amount })], {
      gas: 400_000,
      memo: "vigil: standby sequencer bond",
      registry: createRdkRegistry(),
    });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(`bond now ${qor((await rdk.rest.getSubmitterBond(ROLLUP, standby.cosmos)).amount)}`);
    break;
  }
  case "batches": {
    const q = encodeURIComponent(`batch_submitted.rollup_id='${ROLLUP}'`);
    const j = await getJson<{ tx_responses?: { txhash: string; height: string; timestamp: string; code: number; events: { type: string; attributes: { key: string; value: string }[] }[] }[] }>(
      `/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&pagination.limit=${lastN}&limit=${lastN}&page=1`,
    );
    const name = (a: string) => (a === rollup.creator ? "creator (Keel)" : a === standby.cosmos ? "keel-b (standby)" : a);
    for (const t of j.tx_responses ?? []) {
      const attr = (type: string, key: string) => t.events.find((e) => e.type === type)?.attributes.find((a) => a.key === key)?.value;
      const sender = attr("message", "sender") ?? "?";
      console.log(
        `batch ${attr("batch_submitted", "batch_index")} at ${t.height} (${t.timestamp}) by ${name(sender)}: ${attr("state_anchored", "state_root") ? "anchored" : "unanchored"}, code ${t.code}, tx ${t.txhash}`,
      );
    }
    console.log(`(read from ${REST})`);
    break;
  }
  default:
    console.error("usage: sequencer-drill.ts <status|bond|batches> [--broadcast]");
    process.exit(2);
}
