/**
 * InstantExitVault on qorechain-diana: check it against the live chain, deploy it, and run it.
 *
 * Quorum: watchtower-2 and watchtower-3 (both must sign). LP: the rollup creator, whose ML-DSA-87 key alone can
 * take liquidity out. Fee: 0.5%. See contracts/src/InstantExitVault.sol and
 * packages/qledger-watchtower/src/exits.ts.
 *
 * Steps. Those that send need --broadcast; without it they print the plan and stop.
 *   simulate               free: runs the vault's code in place with eth_call (nothing deployed). Checks that its
 *                          exit message equals the watchtower library's byte for byte, and that real watchtower-2
 *                          and watchtower-3 signatures (made locally; nothing is sent) pass verifyExit against the
 *                          live pqcKeyStatus and pqcVerify, while a changed amount, one signer, or a repeated
 *                          signer fail.
 *   plan                   deployer balance and window, CREATE gas
 *   open-window [--scoped] evm-deployer window: unscoped (contract creation needs it), or --scoped to the vault
 *   deploy                 CREATE the vault; writes deployments/diana.json
 *   close-window
 *   status                 free: config, liquidity, debts, quorum keys
 *   exit-address --payout <qor1…|0x…>   free: the L2 withdrawal recipient for that payout
 *   relay --payout <…>     read exit attestations from the rollup's inbox and front every exit to that payout's
 *                          exit address with enough valid signatures (each is checked with verifyExit first)
 *   sweep --payout <…>     create and sweep that payout's exit address
 *
 *   pnpm --filter @vigil/scripts exec tsx exit/instant-exit.ts <step> [--payout …] [--broadcast]
 */
import "../lib/net.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMPTY_INBOX_ACC,
  bech32ToHex,
  bytesToHex,
  createRdkClient,
  decodeWireBytes,
  fetchQledgerEntries,
  hexToBech32,
  type QledgerEntry,
} from "@qorechain/rdk";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import { decodeAttestation, exitMessage, signClaims, verifyClaim, type ExitClaim, type ExitTarget } from "@vigil/qledger-watchtower";
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
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
import { CHAIN_ID, EVM_CHAIN_ID, EVM_RPC, balances, loadRoleAccount, sendHybrid, windowStatus } from "../lib/native.ts";

const args = process.argv.slice(2);
const step = args[0];
const broadcast = args.includes("--broadcast");
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const rollupId = opt("--rollup") ?? "vigil-pay-1";
const FEE_BPS = 50;
const THRESHOLD = 2n;
const QUORUM_ROLES = ["watchtower-2", "watchtower-3"] as const;
const PROBE_CALLER = "0x000000000000000000000000000000000000dEaD" as const;

const DEPLOYMENTS = resolve(REPO_ROOT, "deployments/diana.json");
const art = JSON.parse(readFileSync(resolve(REPO_ROOT, "contracts/out/InstantExitVault.sol/InstantExitVault.json"), "utf8")) as {
  abi: Abi;
  bytecode: { object: Hex };
};
const chain = defineChain({
  id: EVM_CHAIN_ID,
  name: CHAIN_ID,
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
const pub = createPublicClient({ chain, transport: http(EVM_RPC, { timeout: 120_000, retryCount: 3 }) });
const rdk = createRdkClient({ network: "testnet" });
const qor = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} QOR`;
const evmOf = (qor1: string) => getAddress(`0x${bech32ToHex(qor1).replace(/^0x/, "")}`);

// ---------------------------------------------------------------- configuration from chain
const rollup = await rdk.rest.getRollup(rollupId);
const lp = evmOf(rollup.creator);
const quorum = await Promise.all(QUORUM_ROLES.map(async (r) => (await loadRoleAccount(r)).evm as Hex)).then((a) => a.map((x) => getAddress(x)));
const ctorArgs = [CHAIN_ID, rollupId, quorum, THRESHOLD, lp, FEE_BPS] as const;
const deployData = encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: ctorArgs });

type Deployments = Record<string, unknown> & { InstantExitVault?: { address: Hex; deployTx: Hex; block: string; quorum: Hex[]; threshold: number; lp: Hex; feeBps: number; rollupId: string; deployer: Hex } };
const readDeployments = (): Deployments => (existsSync(DEPLOYMENTS) ? (JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) as Deployments) : { network: CHAIN_ID });
const deployed = () => {
  const d = readDeployments().InstantExitVault;
  if (!d) throw new Error("InstantExitVault is not in deployments/diana.json yet");
  return d;
};

/** eth_call: on the deployed vault, or (address undefined) its code run in place without deploying. */
async function read<T>(address: Hex | undefined, functionName: string, fnArgs: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: art.abi, functionName, args: fnArgs });
  const { data: ret } = address ? await pub.call({ to: address, data }) : await pub.call({ code: deployData, data, account: PROBE_CALLER });
  if (!ret) throw new Error(`${functionName}: empty reply`);
  return decodeFunctionResult({ abi: art.abi, functionName, data: ret }) as T;
}

/** The revert name of an eth_call, or "ok". */
async function outcome(address: Hex | undefined, functionName: string, fnArgs: readonly unknown[]): Promise<string> {
  try {
    await read(address, functionName, fnArgs);
    return "ok";
  } catch (e) {
    const raw = (e as { walk?: (f: (x: unknown) => boolean) => unknown }).walk?.((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | undefined;
    if (raw?.data) {
      try {
        const d = decodeErrorResult({ abi: art.abi, data: raw.data });
        return `${d.errorName}(${(d.args ?? []).join(", ")})`;
      } catch {
        return `revert ${raw.data.slice(0, 10)}`;
      }
    }
    return `error: ${(e as Error).message.split("\n")[0]}`;
  }
}

const target = (vault: Hex): ExitTarget => ({ evmChainId: EVM_CHAIN_ID, vault, chainId: CHAIN_ID, rollupId });

function payoutArg(): Hex {
  const p = opt("--payout");
  if (!p) throw new Error("--payout <qor1…|0x…> is required");
  return p.startsWith("qor1") ? evmOf(p) : getAddress(p);
}

/** Every inbox entry of the rollup, read back from the node and checked against the inbox accumulator. */
async function inboxEntries(): Promise<QledgerEntry[]> {
  const head = Number((await rdk.rest.getInbox(rollupId)).headSequence);
  const out: QledgerEntry[] = [];
  for (let from = 0; from < head; from += 64) {
    const to = Math.min(from + 64, head);
    const accFrom = from === 0 ? EMPTY_INBOX_ACC : decodeWireBytes((await rdk.rest.getPostedData(rollupId, from)).inboxAcc);
    out.push(...(await fetchQledgerEntries(rdk.rest, { chainId: CHAIN_ID, rollupId, from: BigInt(from), to: BigInt(to), accFrom })));
  }
  return out;
}

console.log(`${rollupId}: LP ${lp} (the creator), quorum ${quorum.join(", ")} (${THRESHOLD} of ${quorum.length}), fee ${FEE_BPS / 100}%`);

// ---------------------------------------------------------------- free steps
if (step === "simulate") {
  const gas = await pub.estimateGas({ account: PROBE_CALLER, data: deployData });
  console.log(`vault code run in place with eth_call (nothing deployed); CREATE would use ~${gas} gas`);
  const keys = await Promise.all(quorum.map((m) => read<Hex>(undefined, "keyOf", [m])));
  keys.forEach((k, i) => console.log(`  keyOf(${QUORUM_ROLES[i]}) via pqcKeyStatus: ${(k.length - 2) / 2} B`));
  const payout = evmOf("qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k");
  const exitAddr = await read<Hex>(undefined, "exitAddressOf", [payout]);
  const now = Math.floor(Date.now() / 1000);
  const e = { batchIndex: 15n, stateRoot: `0x${"ab".repeat(32)}` as Hex, withdrawalIndex: 0n, amountUqor: 100_000n, payout, deadline: BigInt(now + 3000) };
  const onChain = await read<Hex>(undefined, "exitMessage", [e]);
  // The in-place vault has a throwaway address, which the message carries at bytes 34..54.
  const vault = getAddress(`0x${onChain.slice(2 + 34 * 2, 2 + 54 * 2)}`);
  const claim: ExitClaim = { batchIndex: 15, stateRoot: "ab".repeat(32), withdrawalIndex: 0, amountUqor: 100_000n, recipient: exitAddr.slice(2).toLowerCase(), deadline: now + 3000 };
  const ours = `0x${bytesToHex(exitMessage(target(vault), claim))}`;
  const same = ours.toLowerCase() === onChain.toLowerCase();
  console.log(`  exitMessage: contract ${(onChain.length - 2) / 2} B, library ${(ours.length - 2) / 2} B, identical: ${same}`);
  const sigs: Hex[] = [];
  for (const [i, role] of QUORUM_ROLES.entries()) {
    const acct = await loadRoleAccount(role);
    const [s] = signClaims(target(vault), acct.pqc.secretKey, [claim]);
    if (!verifyClaim(target(vault), keys[i]!.slice(2), s!)) throw new Error(`${role}: its signature does not verify locally against its chain key`);
    sigs.push(`0x${bytesToHex(s!.signature)}`);
  }
  const results = {
    "both members sign": await outcome(undefined, "verifyExit", [e, [0n, 1n], sigs]),
    "amount changed after signing": await outcome(undefined, "verifyExit", [{ ...e, amountUqor: 100_001n }, [0n, 1n], sigs]),
    "payout changed after signing": await outcome(undefined, "verifyExit", [{ ...e, payout: lp }, [0n, 1n], sigs]),
    "only one member": await outcome(undefined, "verifyExit", [e, [0n], [sigs[0]!]]),
    "the same member twice": await outcome(undefined, "verifyExit", [e, [0n, 0n], [sigs[0]!, sigs[0]!]]),
    "signatures swapped": await outcome(undefined, "verifyExit", [e, [0n, 1n], [sigs[1]!, sigs[0]!]]),
  };
  for (const [k, v] of Object.entries(results)) console.log(`  verifyExit, ${k}: ${v}`);
  const expected = [/^ok$/, /^BadSignature\(0\)$/, /^BadSignature\(0\)$/, /^NotEnoughSigners/, /^SignersNotAscending/, /^BadSignature\(0\)$/];
  const ok = same && Object.values(results).every((v, i) => expected[i]!.test(v));
  console.log(ok ? "ALL AS EXPECTED" : "UNEXPECTED RESULT");
  process.exit(ok ? 0 : 1);
}

if (step === "status") {
  const d = deployed();
  const [q, th, feeBps, lpAddr, avail, totalOwed, nonce] = await Promise.all([
    read<Hex[]>(d.address, "quorum"),
    read<bigint>(d.address, "threshold"),
    read<number>(d.address, "feeBps"),
    read<Hex>(d.address, "lp"),
    read<bigint>(d.address, "available"),
    read<bigint>(d.address, "totalOwed"),
    read<bigint>(d.address, "withdrawNonce"),
  ]);
  console.log(`vault ${d.address} (tx ${d.deployTx}, block ${d.block})`);
  console.log(`  quorum ${q.join(", ")}; threshold ${th}; fee ${feeBps} bps; LP ${lpAddr}; liquidity ${qor(avail)}; owed to the vault ${qor(totalOwed)}; LP withdraw nonce ${nonce}`);
  for (const m of [...q, lpAddr]) console.log(`  keyOf(${m}): ${((await read<Hex>(d.address, "keyOf", [m])).length - 2) / 2} B`);
  const p = opt("--payout");
  if (p) {
    const payout = payoutArg();
    const ea = await read<Hex>(d.address, "exitAddressOf", [payout]);
    console.log(`  payout ${payout}: exit address ${ea} (${hexToBech32(ea, "qor")}), owes ${qor(await read<bigint>(d.address, "owed", [payout]))}, holds ${qor(await pub.getBalance({ address: ea }))}`);
  }
  process.exit(0);
}

if (step === "exit-address") {
  const payout = payoutArg();
  const ea = await read<Hex>(deployed().address, "exitAddressOf", [payout]);
  console.log(`payout ${payout}: withdraw on L2 to ${hexToBech32(ea, "qor")} (${ea})`);
  process.exit(0);
}

// ---------------------------------------------------------------- steps that need the deployer key
const deployer = await loadRoleAccount("evm-deployer");
if (deployer.cosmos === rollup.creator) throw new Error("the deployer must not be the rollup creator");
const wallet = createWalletClient({ chain, account: privateKeyToAccount(deployer.privateKey as Hex), transport: http(EVM_RPC, { timeout: 120_000 }) });
const gasPrice = await pub.getGasPrice();
console.log(`deployer ${deployer.cosmos} / ${deployer.evm}; gas price ${gasPrice} wei`);
const creatorWindow = await windowStatus(rollup.creator);
if (creatorWindow.found && creatorWindow.live) throw new Error(`THE CREATOR ${rollup.creator} HAS A LIVE EVM WINDOW. Close it now.`);

async function sendEvm(label: string, tx: { to?: Hex; data: Hex }) {
  const gas = ((await pub.estimateGas({ account: deployer.evm as Hex, ...tx })) * 13n) / 10n;
  console.log(`plan: ${label}: gas limit ${gas}, max fee ${qor(gas * gasPrice)}`);
  if (!broadcast) return undefined;
  const w = await windowStatus(deployer.cosmos);
  if (!w.found || !w.live) throw new Error("the deployer has no live window: run open-window first");
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
    console.log(`CREATE InstantExitVault: ~${gas} gas = ${qor(gas * gasPrice)}`);
    break;
  }
  case "open-window": {
    const scoped = args.includes("--scoped");
    const msg = scoped
      ? openEvmWindowMsg({ sender: deployer.cosmos, blocks: 300, maxTxs: 4, maxValue: "400000", allowedTargets: [deployed().address] })
      : openEvmWindowMsg({ sender: deployer.cosmos, blocks: 300, maxTxs: 2, maxValue: "800000" });
    console.log(scoped ? `plan: window scoped to the vault ${deployed().address}: 300 blocks, 4 txs, 0.4 QOR cap` : "plan: unscoped window (contract creation needs it): 300 blocks, 2 txs, 0.8 QOR cap");
    if (!broadcast) break;
    const res = await sendHybrid(deployer, [msg], { gas: 500_000, memo: "vigil: window for the instant-exit vault" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(JSON.stringify(await windowStatus(deployer.cosmos)));
    break;
  }
  case "close-window": {
    console.log("plan: MsgCloseEVMWindow from evm-deployer");
    if (!broadcast) break;
    const res = await sendHybrid(deployer, [closeEvmWindowMsg(deployer.cosmos)], { gas: 400_000, memo: "vigil: close the instant-exit window" });
    console.log(`tx ${res.transactionHash} height ${res.height}`);
    console.log(JSON.stringify(await windowStatus(deployer.cosmos)));
    break;
  }
  case "deploy": {
    if (readDeployments().InstantExitVault) throw new Error("already deployed (see deployments/diana.json)");
    const rcpt = await sendEvm(`CREATE InstantExitVault(${ctorArgs.join(", ")})`, { data: deployData });
    if (!rcpt?.contractAddress) break;
    const d = readDeployments();
    d.InstantExitVault = {
      address: rcpt.contractAddress,
      deployTx: rcpt.transactionHash,
      block: rcpt.blockNumber.toString(),
      quorum,
      threshold: Number(THRESHOLD),
      lp,
      feeBps: FEE_BPS,
      rollupId,
      deployer: deployer.evm as Hex,
    };
    writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + "\n");
    console.log(`deployed at ${rcpt.contractAddress} (${hexToBech32(rcpt.contractAddress, "qor")}): fund it with a bank send to that qor1 address`);
    break;
  }
  case "relay": {
    const d = deployed();
    const payout = payoutArg();
    const ea = (await read<Hex>(d.address, "exitAddressOf", [payout])).slice(2).toLowerCase();
    const members = (await read<Hex[]>(d.address, "quorum")).map((m) => m.slice(2).toLowerCase());
    const keys = await Promise.all(members.map((m) => read<Hex>(d.address, "keyOf", [`0x${m}`])));
    const t = target(d.address);
    // exit key -> member index -> signature
    const found = new Map<string, { claim: ExitClaim; sigs: Map<number, Uint8Array> }>();
    for (const entry of await inboxEntries()) {
      const a = decodeAttestation(entry.payload);
      if (!a || a.vault.toLowerCase() !== d.address.toLowerCase()) continue;
      const m = members.indexOf(a.member);
      if (m < 0) continue;
      for (const s of a.claims) {
        if (s.claim.recipient !== ea || !verifyClaim(t, keys[m]!.slice(2), s)) continue;
        const k = `${s.claim.batchIndex}:${s.claim.stateRoot}:${s.claim.withdrawalIndex}`;
        const cur = found.get(k) ?? { claim: s.claim, sigs: new Map() };
        cur.sigs.set(m, s.signature);
        found.set(k, cur);
      }
    }
    console.log(`${found.size} attested exit(s) to ${hexToBech32(`0x${ea}`, "qor")} (payout ${payout})`);
    for (const [k, { claim, sigs }] of found) {
      const signers = [...sigs.keys()].sort((x, y) => x - y);
      const e = { batchIndex: BigInt(claim.batchIndex), stateRoot: `0x${claim.stateRoot}` as Hex, withdrawalIndex: BigInt(claim.withdrawalIndex), amountUqor: claim.amountUqor, payout, deadline: BigInt(claim.deadline) };
      const batch = await rdk.rest.getBatch(rollupId, claim.batchIndex).catch(() => undefined);
      const live = batch && bytesToHex(decodeWireBytes(batch.stateRoot)).toLowerCase() === claim.stateRoot;
      const callArgs = [e, signers.map(BigInt), signers.map((i) => `0x${bytesToHex(sigs.get(i)!)}` as Hex)] as const;
      const check = await outcome(d.address, "verifyExit", callArgs);
      console.log(`  exit ${k}: ${Number(claim.amountUqor) / 1e6} QOR, signed by members ${signers.join(",")}, batch ${batch ? `${batch.status}${live ? "" : " (different root now)"}` : "not found"}, deadline ${new Date(claim.deadline * 1000).toISOString()}; verifyExit: ${check}`);
      if (check !== "ok" || !live || batch!.status === "rejected") continue;
      await sendEvm(`front(${k}) to ${payout}`, { to: d.address, data: encodeFunctionData({ abi: art.abi, functionName: "front", args: callArgs }) });
    }
    break;
  }
  case "sweep": {
    const d = deployed();
    const payout = payoutArg();
    const ea = await read<Hex>(d.address, "exitAddressOf", [payout]);
    console.log(`exit address ${ea} holds ${qor(await pub.getBalance({ address: ea }))}; payout owes the vault ${qor(await read<bigint>(d.address, "owed", [payout]))}`);
    await sendEvm(`sweep(${payout})`, { to: d.address, data: encodeFunctionData({ abi: art.abi, functionName: "sweep", args: [payout] }) });
    break;
  }
  default:
    console.error("usage: instant-exit.ts <simulate|plan|open-window|deploy|close-window|status|exit-address|relay|sweep> [--payout …] [--broadcast]");
    process.exit(2);
}
