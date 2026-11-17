/**
 * Convert a role account's bank coins of an ERC-20 pair (e.g. fUSD "erc20:0x9714…")
 * into the ERC-20 balance of an EVM address, with MsgConvertCoin on the Native lane
 * (hybrid-signed; no EVM window). Used to fund PQGuardVault with real ERC-20 fUSD.
 *
 *   tsx drill/convert.ts --from drill --to 0x… --fusd 1 [--broadcast]
 */
import "../lib/net.ts";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { convertCoinMsg, vigilRegistry } from "../lib/erc20.ts";
import { EVM_RPC, balances, loadRoleAccount, sendHybrid, windowStatus } from "../lib/native.ts";

const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as const;
const args = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const from = opt("--from");
const to = opt("--to") as Hex | undefined;
const fusd = Number(opt("--fusd") ?? 0);
if (!from || !to || !/^0x[0-9a-fA-F]{40}$/.test(to) || !(fusd > 0)) {
  console.error("usage: convert.ts --from <role> --to <0x…> --fusd <n> [--broadcast]");
  process.exit(2);
}
const pub = createPublicClient({ transport: http(EVM_RPC, { timeout: 90_000, retryCount: 3 }) });
const bal = (a: Hex) => pub.readContract({ address: FUSD, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [a] });

const acct = await loadRoleAccount(from);
const w = await windowStatus(acct.cosmos);
if (w.found && w.live) throw new Error(`${from} has a LIVE EVM window; refusing`);
const amount = String(Math.round(fusd * 1e6));
console.log(`plan: MsgConvertCoin ${amount} erc20:${FUSD} from ${from} ${acct.cosmos} -> ERC-20 balance of ${to}`);
console.log(`before: bank ${JSON.stringify(await balances(acct.cosmos))}; fUSD.balanceOf(${to}) = ${await bal(to)}`);
if (!args.includes("--broadcast")) process.exit(0);
const res = await sendHybrid(acct, [convertCoinMsg(acct.cosmos, to, `erc20:${FUSD}`, amount)], {
  gas: 400_000,
  memo: `vigil: convert fUSD to ERC-20 for ${to}`,
  registry: vigilRegistry(),
});
console.log(`tx ${res.transactionHash} height ${res.height} gasUsed ${res.gasUsed}`);
console.log(`after: fUSD.balanceOf(${to}) = ${await bal(to)}`);
console.log(`explorer: https://explore.qore.network/tx/${res.transactionHash}`);
