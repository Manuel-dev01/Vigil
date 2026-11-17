/**
 * Native-lane bank send from a role account, hybrid-signed (secp256k1 + ML-DSA-87).
 * Never touches the EVM lane, so it is safe for the drill account.
 *
 *   tsx drill/send.ts --from drill --to <qor1…> --qor 30 [--fusd 500] [--memo "..."] [--broadcast]
 */
import "../lib/net.ts";
import { bank } from "@qorechain/sdk";
import { balances, loadRoleAccount, sendHybrid, windowStatus } from "../lib/native.ts";

const FUSD_DENOM = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";
const args = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const from = opt("--from");
const to = opt("--to");
if (!from || !to || !/^qor1[02-9ac-hj-np-z]{38,58}$/.test(to)) {
  console.error("usage: send.ts --from <role> --to <qor1…> --qor <n> [--fusd <n>] [--broadcast]");
  process.exit(2);
}
const qor = Number(opt("--qor") ?? 0);
const fusd = Number(opt("--fusd") ?? 0);
const amount = [
  ...(qor > 0 ? [{ denom: "uqor", amount: String(Math.round(qor * 1e6)) }] : []),
  ...(fusd > 0 ? [{ denom: FUSD_DENOM, amount: String(Math.round(fusd * 1e6)) }] : []),
].sort((a, b) => (a.denom < b.denom ? -1 : 1)); // Coins must be sorted by denom or the chain refuses them
if (amount.length === 0) throw new Error("nothing to send");

const acct = await loadRoleAccount(from);
const w = await windowStatus(acct.cosmos);
if (w.found && w.live) throw new Error(`${from} has a LIVE EVM window; refusing`);
console.log(`plan: ${from} ${acct.cosmos} -> ${to}: ${JSON.stringify(amount)} (native lane, hybrid-signed)`);
console.log(`before: ${JSON.stringify(await balances(acct.cosmos))}`);
if (!args.includes("--broadcast")) {
  console.log("dry run: pass --broadcast to send.");
  process.exit(0);
}
const res = await sendHybrid(acct, [bank.send({ fromAddress: acct.cosmos, toAddress: to, amount })], {
  gas: 300_000,
  memo: opt("--memo") ?? `vigil: ${from} transfer`,
});
console.log(`tx ${res.transactionHash} height ${res.height} gasUsed ${res.gasUsed}`);
console.log(`after:  ${JSON.stringify(await balances(acct.cosmos))}`);
console.log(`to:     ${JSON.stringify(await balances(to))}`);
console.log(`explorer: https://explore.qore.network/tx/${res.transactionHash}`);
