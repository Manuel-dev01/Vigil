/**
 * Deploy and fund PQGuardVault for the Q-Day Drill, from the DEPLOYER account
 * only. The drill account never opens an EVM window; this script refuses to.
 *
 * Steps (each broadcasting step needs --broadcast; without it, it prints the plan):
 *   open-window   deployer opens an UNSCOPED window (creation needs one): 1 tx, 120 blocks, 0.25 QOR cap
 *   deploy        deployer deploys PQGuardVault(guardian = drill account's 0x address)
 *   close-window  deployer closes its window at once
 *   fund          deployer sends QOR (and fUSD) to the vault on the native lane: no window needed
 *   verify        free reads: windows closed on both accounts, vault code, guardian key,
 *                 and a REAL ML-DSA-87 isValidRelease check through the live pqcVerify precompile
 *
 *   tsx drill/deploy-vault.ts <step> [--broadcast] [--qor 50] [--fusd 500]
 */
import "../lib/net.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { bank, closeEvmWindowMsg, evmToQor, openEvmWindowMsg } from "@qorechain/sdk";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REPO_ROOT } from "../lib/env.ts";
import { EVM_CHAIN_ID, EVM_RPC, balances, loadRoleAccount, sendHybrid, windowStatus } from "../lib/native.ts";

const FUSD = "0x97143B771D34ddb9130b807b135Ae675A5a963CA" as const;
const DEPLOYMENTS = resolve(REPO_ROOT, "deployments/diana.json");
const ARTIFACT = resolve(REPO_ROOT, "contracts/out/PQGuardVault.sol/PQGuardVault.json");

const args = process.argv.slice(2);
const step = args[0];
const broadcast = args.includes("--broadcast");
const num = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};

const chain = defineChain({
  id: EVM_CHAIN_ID,
  name: "qorechain-diana",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
const pub = createPublicClient({ chain, transport: http(EVM_RPC, { timeout: 90_000, retryCount: 3 }) });
const vaultAbi = parseAbi([
  "function guardian() view returns (address)",
  "function nonce() view returns (uint256)",
  "function guardianKey() view returns (bytes)",
  "function releaseMessage(address,address,uint256,uint256,uint256) view returns (bytes)",
  "function isValidRelease(address,address,uint256,uint256,bytes) view returns (bool)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const deployer = await loadRoleAccount("deployer");
const drill = await loadRoleAccount("drill");
if (deployer.cosmos === drill.cosmos) throw new Error("deployer and drill must be different accounts");

type Deployments = { network: string; PQGuardVault?: { address: Hex; guardian: Hex; deployTx: Hex; block: string; deployer: string } };
const readDeployments = (): Deployments =>
  existsSync(DEPLOYMENTS) ? (JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments) : { network: "qorechain-diana" };

async function assertDrillHasNoWindow() {
  const w = await windowStatus(drill.cosmos);
  if (w.found && w.live) throw new Error(`DRILL ACCOUNT HAS A LIVE EVM WINDOW: ${JSON.stringify(w)}. Close it now.`);
}

console.log(`deployer ${deployer.cosmos} / ${deployer.evm}; guardian (drill) ${drill.evm}`);
await assertDrillHasNoWindow();

switch (step) {
  case "open-window": {
    const msg = openEvmWindowMsg({ sender: deployer.cosmos, blocks: 120, maxTxs: 1, maxValue: "250000" });
    console.log("plan: MsgOpenEVMWindow from DEPLOYER, unscoped (contract creation), 120 blocks (~3 min), 1 tx, 0.25 QOR value+fee cap");
    if (!broadcast) break;
    const res = await sendHybrid(deployer, [msg], { gas: 500_000, memo: "vigil: deploy window for PQGuardVault" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(JSON.stringify(await windowStatus(deployer.cosmos)));
    break;
  }
  case "deploy": {
    const art = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { bytecode: { object: Hex } };
    const data = (art.bytecode.object + encodeAbiParameters([{ type: "address" }], [drill.evm as Hex]).slice(2)) as Hex;
    const gas = (await pub.estimateGas({ account: deployer.evm as Hex, data })) * 12n / 10n;
    const gasPrice = await pub.getGasPrice();
    console.log(`plan: CREATE PQGuardVault(${drill.evm}) gas ${gas} @ ${gasPrice} = ${Number(gas * gasPrice) / 1e18} QOR max fee`);
    if (!broadcast) break;
    const w = await windowStatus(deployer.cosmos);
    if (!w.live) throw new Error("deployer has no live window: run open-window first");
    const wallet = createWalletClient({ chain, account: privateKeyToAccount(deployer.privateKey as Hex), transport: http(EVM_RPC) });
    const hash = await wallet.sendTransaction({ data, gas, gasPrice });
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`deploy failed: ${JSON.stringify(rcpt)}`);
    const d = readDeployments();
    d.PQGuardVault = { address: rcpt.contractAddress, guardian: drill.evm as Hex, deployTx: hash, block: rcpt.blockNumber.toString(), deployer: deployer.evm };
    mkdirSync(resolve(REPO_ROOT, "deployments"), { recursive: true });
    writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
    console.log(`deployed ${rcpt.contractAddress} in tx ${hash} block ${rcpt.blockNumber}, gas used ${rcpt.gasUsed}`);
    break;
  }
  case "close-window": {
    console.log("plan: MsgCloseEVMWindow from DEPLOYER");
    if (!broadcast) break;
    const res = await sendHybrid(deployer, [closeEvmWindowMsg(deployer.cosmos)], { gas: 400_000, memo: "vigil: close deploy window" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(JSON.stringify(await windowStatus(deployer.cosmos)));
    break;
  }
  case "fund": {
    const v = readDeployments().PQGuardVault;
    if (!v) throw new Error("no vault in deployments/diana.json");
    const to = evmToQor(v.address);
    const qor = num("--qor", 0);
    const fusd = num("--fusd", 0);
    const amount = [
      ...(qor > 0 ? [{ denom: "uqor", amount: String(Math.round(qor * 1e6)) }] : []),
      ...(fusd > 0 ? [{ denom: `erc20:${FUSD}`, amount: String(Math.round(fusd * 1e6)) }] : []),
    ];
    console.log(`plan: native MsgSend from DEPLOYER to vault ${to}: ${JSON.stringify(amount)}`);
    if (!broadcast || amount.length === 0) break;
    const res = await sendHybrid(deployer, [bank.send({ fromAddress: deployer.cosmos, toAddress: to, amount })], { gas: 300_000, memo: "vigil: fund PQGuardVault" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    break;
  }
  case "verify": {
    for (const [name, a] of [["drill", drill], ["deployer", deployer]] as const) {
      const w = await windowStatus(a.cosmos);
      console.log(`${name} ${a.cosmos}: window found=${w.found} live=${w.live}; balances ${JSON.stringify(await balances(a.cosmos))}`);
    }
    const v = readDeployments().PQGuardVault;
    if (!v) {
      console.log("no vault deployed yet");
      break;
    }
    const code = await pub.getCode({ address: v.address });
    const guardian = await pub.readContract({ address: v.address, abi: vaultAbi, functionName: "guardian" });
    const native = await pub.getBalance({ address: v.address });
    const fusd = await pub.readContract({ address: FUSD, abi: erc20, functionName: "balanceOf", args: [v.address] });
    console.log(`vault ${v.address}: code ${(code?.length ?? 2) / 2 - 1} B, guardian ${guardian}, ${Number(native) / 1e18} QOR, ${Number(fusd) / 1e6} fUSD`);
    // A real ML-DSA-87 signature from the drill account's key, checked by the deployed vault via pqcVerify.
    const key = await pub.readContract({ address: v.address, abi: vaultAbi, functionName: "guardianKey" });
    console.log(`guardianKey(): ${(key.length - 2) / 2} B, equals drill key: ${key.toLowerCase() === toHex(drill.pqc.publicKey).toLowerCase()}`);
    const nonce = await pub.readContract({ address: v.address, abi: vaultAbi, functionName: "nonce" });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const args5 = ["0x0000000000000000000000000000000000000000", drill.evm as Hex, 1n, deadline, nonce] as const;
    const m = await pub.readContract({ address: v.address, abi: vaultAbi, functionName: "releaseMessage", args: args5 });
    const sig = ml_dsa87.sign(Uint8Array.from(Buffer.from(m.slice(2), "hex")), drill.pqc.secretKey);
    const ok = await pub.readContract({ address: v.address, abi: vaultAbi, functionName: "isValidRelease", args: [args5[0], args5[1], 1n, deadline, toHex(sig)] });
    const bad = await pub.readContract({ address: v.address, abi: vaultAbi, functionName: "isValidRelease", args: [args5[0], args5[1], 2n, deadline, toHex(sig)] });
    console.log(`isValidRelease (eth_call, real ML-DSA-87 sig, 1 wei to drill): ${ok}; same sig with amount changed: ${bad}`);
    break;
  }
  default:
    console.error("usage: deploy-vault.ts <open-window|deploy|close-window|fund|verify> [--broadcast]");
    process.exit(2);
}
