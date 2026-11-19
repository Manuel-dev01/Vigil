/**
 * SettlementReceiptVerifier on qorechain-diana: check it against the live chain, deploy it, and
 * attest vigil-pay-1's anchors in the EVM.
 *
 * The deployer is its own account (role `evm-deployer`, key in `.env.evm-deployer`, gitignored).
 * The rollup creator (the drill / Glass Key account) never opens an EVM window: every step refuses
 * to run if it has one.
 *
 * Steps. Those that send need --broadcast; without it they print the plan and stop.
 *   simulate      free: runs the contract's code against the live precompiles with eth_call
 *                 (nothing deployed): every anchor must check Valid, a forged root and a signature
 *                 replayed at another height must fail. Needs no key.
 *   plan          deployer balance, window and gas estimates
 *   open-window   deployer opens an unscoped window (contract creation needs one)
 *   deploy        CREATE SettlementReceiptVerifier(creator, "qorechain-diana", layer id)
 *   probe         spike S3b: CREATE BlockhashProbe, compare BLOCKHASH in a mined tx with CometBFT
 *   attest        attest anchors not yet recorded (--one <height> for a single attest() call)
 *   close-window  deployer closes its window
 *   status        free: config, records, and a live check() of every anchor on the deployed contract
 *
 *   pnpm --filter @vigil/scripts exec tsx evm/receipt-verifier.ts <step> [--broadcast] [--rollup vigil-pay-1]
 */
import "../lib/net.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bech32ToHex, createRdkClient, type AnchorView } from "@qorechain/rdk";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionResult,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REPO_ROOT } from "../lib/env.ts";
import { CHAIN_ID, EVM_CHAIN_ID, EVM_RPC, RPC, balances, loadRoleAccount, sendHybrid, windowStatus } from "../lib/native.ts";

const args = process.argv.slice(2);
const step = args[0];
const broadcast = args.includes("--broadcast");
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const rollupId = opt("--rollup") ?? "vigil-pay-1";

const DEPLOYMENTS = resolve(REPO_ROOT, "deployments/diana.json");
const artifact = (name: string, file = `${name}.sol`) =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, `contracts/out/${file}/${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
const V = artifact("SettlementReceiptVerifier");
const P = artifact("BlockhashProbe");
const RESULT = ["Valid", "BadSignatureLength", "KeyNotUsable", "BadSignature"] as const;
const PROBE_CALLER = "0x000000000000000000000000000000000000dEaD" as const;

const chain = defineChain({
  id: EVM_CHAIN_ID,
  name: CHAIN_ID,
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
const pub = createPublicClient({ chain, transport: http(EVM_RPC, { timeout: 120_000, retryCount: 3 }) });
const rdk = createRdkClient({ network: "testnet" });

// ---------------------------------------------------------------- chain facts
const rollup = await rdk.rest.getRollup(rollupId);
const layerId = rollup.layerId || rollupId;
const creatorEvm = getAddress(`0x${bech32ToHex(rollup.creator).replace(/^0x/, "")}`);
const ctorArgs = [creatorEvm, CHAIN_ID, layerId] as const;
const deployData = encodeDeployData({ abi: V.abi, bytecode: V.bytecode.object, args: ctorArgs });

type Anchor = {
  layerHeight: bigint;
  stateRoot: Hex;
  validatorSetHash: Hex;
  transactionCount: bigint;
  compressedStateProof: Hex;
  signature: Hex;
};
const toAnchor = (a: AnchorView): Anchor => ({
  layerHeight: BigInt(a.layerHeight),
  stateRoot: `0x${a.stateRoot}`,
  validatorSetHash: `0x${a.validatorSetHash}`,
  transactionCount: BigInt(a.transactionCount),
  compressedStateProof: `0x${a.compressedStateProof}`,
  signature: `0x${a.pqcSignature}`,
});
const anchors = (await rdk.rest.getAnchors(layerId)).sort((a, b) => a.layerHeight - b.layerHeight).map(toAnchor);

type Deployments = Record<string, unknown> & {
  SettlementReceiptVerifier?: { address: Hex; creator: Hex; chainId: string; layerId: string; rollupId: string; deployTx: Hex; block: string; deployer: Hex; gasUsed: string };
  BlockhashProbe?: Record<string, unknown>;
};
const readDeployments = (): Deployments =>
  existsSync(DEPLOYMENTS) ? (JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments) : { network: CHAIN_ID };
const writeDeployments = (d: Deployments) => {
  mkdirSync(resolve(REPO_ROOT, "deployments"), { recursive: true });
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
};
const deployed = () => {
  const d = readDeployments().SettlementReceiptVerifier;
  if (!d) throw new Error("SettlementReceiptVerifier is not in deployments/diana.json yet");
  if (d.layerId !== layerId || getAddress(d.creator) !== creatorEvm) throw new Error("deployments/diana.json is for another rollup");
  return d;
};

/** eth_call against the contract: the deployed one, or (address undefined) its code run in place without deploying. */
async function read<T>(address: Hex | undefined, functionName: string, fnArgs: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: V.abi, functionName, args: fnArgs });
  const { data: ret } = address ? await pub.call({ to: address, data }) : await pub.call({ code: deployData, data, account: PROBE_CALLER });
  if (!ret) throw new Error(`${functionName}: empty reply`);
  return decodeFunctionResult({ abi: V.abi, functionName, data: ret }) as T;
}

async function checkAll(address: Hex | undefined): Promise<boolean> {
  let ok = true;
  for (const a of anchors) {
    const r = RESULT[await read<number>(address, "check", [a])];
    ok &&= r === "Valid";
    console.log(`  layer height ${a.layerHeight}: root ${a.stateRoot.slice(2, 10)}… -> ${r}`);
  }
  const first = anchors[0]!;
  const forged = { ...first, stateRoot: `0x${(BigInt(first.stateRoot) ^ (1n << 255n)).toString(16).padStart(64, "0")}` as Hex };
  const forgedR = RESULT[await read<number>(address, "check", [forged])];
  console.log(`  forged root (one bit flipped) at height ${first.layerHeight}: ${forgedR}`);
  // Two neighbouring anchors with the same root: one's signature must not pass for the other's height.
  const pair = anchors.findIndex((a, i) => i > 0 && a.stateRoot === anchors[i - 1]!.stateRoot);
  if (pair > 0) {
    const replay = { ...anchors[pair]!, signature: anchors[pair - 1]!.signature };
    const replayR = RESULT[await read<number>(address, "check", [replay])];
    console.log(`  height ${anchors[pair - 1]!.layerHeight}'s signature replayed at height ${anchors[pair]!.layerHeight} (same root): ${replayR}`);
    ok &&= replayR === "BadSignature";
  }
  return ok && forgedR === "BadSignature";
}

async function assertCreatorHasNoWindow() {
  const w = await windowStatus(rollup.creator);
  if (w.found && w.live) throw new Error(`THE CREATOR ${rollup.creator} HAS A LIVE EVM WINDOW: ${JSON.stringify(w)}. Close it now.`);
}

async function cometHash(height: bigint): Promise<string> {
  const r = await fetch(`${RPC}/block?height=${height}`);
  if (!r.ok) return `HTTP ${r.status}`;
  const j = (await r.json()) as { result?: { block_id: { hash: string } } };
  return j.result ? `0x${j.result.block_id.hash.toLowerCase()}` : "none";
}

console.log(`${rollupId}: layer ${layerId}, creator ${rollup.creator} = ${creatorEvm}; ${anchors.length} anchors on chain`);
await assertCreatorHasNoWindow();

if (step === "simulate" || step === "status") {
  const address = step === "status" ? deployed().address : undefined;
  if (address) {
    const d = deployed();
    const [creator, cid, lid, count, highest, conflicts] = await Promise.all([
      read<Hex>(address, "creator"),
      read<string>(address, "chainId"),
      read<string>(address, "layerId"),
      read<bigint>(address, "attestedCount"),
      read<bigint>(address, "highestHeight"),
      read<bigint>(address, "conflictCount"),
    ]);
    const code = await pub.getCode({ address });
    console.log(`deployed ${address} (tx ${d.deployTx}, block ${d.block}): ${(code!.length - 2) / 2} B of code`);
    console.log(`config: creator ${creator}, chain ${cid}, layer ${lid}; attested ${count}, highest ${highest}, conflicts ${conflicts}`);
    for (const a of anchors) {
      const [root, at, blockNo, conflicted] = await read<readonly [Hex, bigint, bigint, boolean]>(address, "records", [a.layerHeight]);
      const okNow = await read<boolean>(address, "isAttested", [a.layerHeight, a.stateRoot]);
      console.log(`  record ${a.layerHeight}: ${at === 0n ? "not attested" : `root ${root.slice(2, 10)}… at block ${blockNo}${conflicted ? " CONFLICTED" : ""}`}; isAttested(chain root) = ${okNow}`);
    }
  } else {
    const gas = await pub.estimateGas({ account: PROBE_CALLER, data: deployData });
    console.log(`contract code run in place with eth_call (nothing deployed); CREATE would use ~${gas} gas`);
  }
  const key = await read<Hex>(address, "creatorKey");
  console.log(`creatorKey() via pqcKeyStatus: ${(key.length - 2) / 2} B`);
  const msg0 = await read<Hex>(address, "anchorMessage", [anchors[0]!]);
  console.log(`anchorMessage(height 0): ${(msg0.length - 2) / 2} B`);
  console.log(`check() of every anchor against the live pqcVerify precompile:`);
  const ok = await checkAll(address);
  console.log(ok ? "ALL AS EXPECTED" : "UNEXPECTED RESULT");
  if (!ok) process.exit(1);
  process.exit(0);
}

// ---------------------------------------------------------------- steps that need the deployer key
const deployer = await loadRoleAccount("evm-deployer");
if (deployer.cosmos === rollup.creator) throw new Error("the deployer must not be the rollup creator");
const wallet = createWalletClient({ chain, account: privateKeyToAccount(deployer.privateKey as Hex), transport: http(EVM_RPC, { timeout: 120_000 }) });
const gasPrice = await pub.getGasPrice();
const qor = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} QOR`;
console.log(`deployer ${deployer.cosmos} / ${deployer.evm}; gas price ${gasPrice} wei`);

async function requireLiveWindow() {
  const w = await windowStatus(deployer.cosmos);
  if (!w.found || !w.live) throw new Error("the deployer has no live window: run open-window first");
  return w;
}

async function sendEvm(label: string, tx: { to?: Hex; data: Hex }) {
  const gas = ((await pub.estimateGas({ account: deployer.evm as Hex, ...tx })) * 13n) / 10n;
  console.log(`plan: ${label}: gas limit ${gas}, max fee ${qor(gas * gasPrice)}`);
  if (!broadcast) return undefined;
  await requireLiveWindow();
  const hash = await wallet.sendTransaction({ ...tx, gas, gasPrice });
  const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rcpt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  console.log(`${label}: tx ${hash} block ${rcpt.blockNumber} gas used ${rcpt.gasUsed} (${qor(rcpt.gasUsed * rcpt.effectiveGasPrice)})`);
  return rcpt;
}

switch (step) {
  case "plan": {
    console.log(`balances ${JSON.stringify(await balances(deployer.cosmos))}; window ${JSON.stringify(await windowStatus(deployer.cosmos))}`);
    const gas = await pub.estimateGas({ account: deployer.evm as Hex, data: deployData });
    console.log(`CREATE SettlementReceiptVerifier: ~${gas} gas = ${qor(gas * gasPrice)}`);
    break;
  }
  case "open-window": {
    // Unscoped: contract creation is refused under a scoped window. Bounded by time, count and value.
    const msg = openEvmWindowMsg({ sender: deployer.cosmos, blocks: 600, maxTxs: 6, maxValue: "1500000" });
    console.log("plan: MsgOpenEVMWindow from evm-deployer: unscoped, 600 blocks (~20 min), 6 txs, 1.5 QOR value+fee cap");
    if (!broadcast) break;
    const res = await sendHybrid(deployer, [msg], { gas: 500_000, memo: "vigil: window to deploy the settlement receipt verifier" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(JSON.stringify(await windowStatus(deployer.cosmos)));
    break;
  }
  case "deploy": {
    if (readDeployments().SettlementReceiptVerifier) throw new Error("already deployed (see deployments/diana.json)");
    const rcpt = await sendEvm(`CREATE SettlementReceiptVerifier(${ctorArgs.join(", ")})`, { data: deployData });
    if (!rcpt?.contractAddress) break;
    const d = readDeployments();
    d.SettlementReceiptVerifier = {
      address: rcpt.contractAddress,
      creator: creatorEvm,
      chainId: CHAIN_ID,
      layerId,
      rollupId,
      deployTx: rcpt.transactionHash,
      block: rcpt.blockNumber.toString(),
      deployer: deployer.evm as Hex,
      gasUsed: rcpt.gasUsed.toString(),
    };
    writeDeployments(d);
    console.log(`deployed at ${rcpt.contractAddress}`);
    break;
  }
  case "probe": {
    const rcpt = await sendEvm("CREATE BlockhashProbe (spike S3b)", { data: P.bytecode.object });
    if (!rcpt) break;
    const log = rcpt.logs.find((l) => l.address.toLowerCase() === rcpt.contractAddress?.toLowerCase());
    if (!log) throw new Error("no Probe event");
    const ev = decodeEventLog({ abi: P.abi, data: log.data, topics: log.topics }) as unknown as {
      args: { number: bigint; depths: readonly bigint[]; hashes: readonly Hex[]; historyCallOk: boolean; historyReturn: Hex };
    };
    const rows = [];
    for (let i = 0; i < ev.args.depths.length; i++) {
      const h = ev.args.number - ev.args.depths[i]!;
      const comet = await cometHash(h);
      const evm = ev.args.hashes[i]!;
      rows.push({ depth: Number(ev.args.depths[i]), height: Number(h), evm, comet, match: evm.toLowerCase() === comet });
      console.log(`  BLOCKHASH(${h}) depth ${ev.args.depths[i]}: ${evm} | comet ${comet} | ${evm.toLowerCase() === comet ? "MATCH" : "differs"}`);
    }
    console.log(`  EIP-2935 call ok=${ev.args.historyCallOk} return ${ev.args.historyReturn}`);
    const d = readDeployments();
    d.BlockhashProbe = {
      spike: "S3b",
      address: rcpt.contractAddress,
      tx: rcpt.transactionHash,
      block: rcpt.blockNumber.toString(),
      results: rows,
      eip2935: { ok: ev.args.historyCallOk, ret: ev.args.historyReturn },
    };
    writeDeployments(d);
    break;
  }
  case "attest": {
    const { address } = deployed();
    const one = opt("--one");
    if (one !== undefined) {
      const a = anchors.find((x) => x.layerHeight === BigInt(one));
      if (!a) throw new Error(`no anchor at layer height ${one}`);
      await sendEvm(`attest(height ${one})`, { to: address, data: encodeFunctionData({ abi: V.abi, functionName: "attest", args: [a] }) });
      break;
    }
    const todo = [];
    for (const a of anchors) {
      const [, at] = await read<readonly [Hex, bigint, bigint, boolean]>(address, "records", [a.layerHeight]);
      if (at === 0n) todo.push(a);
    }
    console.log(`${todo.length} anchors not yet attested: heights ${todo.map((a) => a.layerHeight).join(", ") || "none"}`);
    if (todo.length === 0) break;
    await sendEvm(`attestMany(${todo.length} anchors)`, { to: address, data: encodeFunctionData({ abi: V.abi, functionName: "attestMany", args: [todo] }) });
    break;
  }
  case "close-window": {
    console.log("plan: MsgCloseEVMWindow from evm-deployer");
    if (!broadcast) break;
    const res = await sendHybrid(deployer, [closeEvmWindowMsg(deployer.cosmos)], { gas: 400_000, memo: "vigil: close the deploy window" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(JSON.stringify(await windowStatus(deployer.cosmos)));
    break;
  }
  default:
    console.error("usage: receipt-verifier.ts <simulate|plan|open-window|deploy|probe|attest|close-window|status> [--broadcast]");
    process.exit(2);
}
