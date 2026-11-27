/**
 * pnpm redteam: try to break Vigil's three deployed contracts the way an attacker would, with free
 * eth_calls only, and record what each one answered.
 *
 * Keyless. Nothing is signed with a real key, no transaction is sent and no EVM window is opened. The
 * attacker's keys (one ML-DSA-87, one secp256k1) are made in memory for the run and dropped at exit.
 * Inputs are public: the watchtowers' real exit attestations from the inbox archive
 * (data/inbox/vigil-pay-1.jsonl), the creator's real anchors (test/vectors/anchors-vigil-pay-1.json)
 * and deployments/diana.json. The cases themselves are in lib/redteam.ts.
 *
 * Requests go one at a time, at least MIN_GAP_MS apart, about 30 in all.
 *
 *   pnpm redteam            print every answer; exit 1 if any differs from the expected one, 2 if a case could not run
 *   pnpm redteam --write    also rewrite docs/REDTEAM.md and docs/redteam.json, only if every case ran
 *                           (add --force to write an incomplete run over the committed one)
 *   pnpm redteam --render   rewrite docs/REDTEAM.md from docs/redteam.json (no network)
 */
import "./lib/net.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorSignBytesV2, bech32ToHex, hexToBytes } from "@qorechain/rdk";
import { generatePqcKeypair, pqcSign } from "@qorechain/sdk";
import { exitMessage, type ExitTarget } from "@vigil/qledger-watchtower";
import {
  BaseError,
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ABIS,
  NOT_RUN,
  VAULT_CTOR,
  buildCases,
  decodeRevert,
  exitCode,
  judge,
  realExits,
  renderMarkdown,
  summarize,
  type AnchorIn,
  type Case,
  type ContractName,
  type Fronted,
  type Inputs,
  type Report,
  type Result,
} from "./lib/redteam.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVM_RPC = "https://evm-testnet.qore.host";
const EVM_CHAIN_ID = 9800;
const CHAIN_ID = "qorechain-diana";
const ROLLUP = "vigil-pay-1";
const MIN_GAP_MS = 1100;
/** The real exits' payout: OoJae's QoreX address (EVIDENCE 91, 104). */
const PAYOUT_QOR1 = "qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k";
/** Where the vault paid each real exit (EVIDENCE 91 and 104). */
const FRONTED: Record<number, Fronted> = {
  15: { frontBlock: 10_629_908n, tx: "0x9705770b52cdb3448277915a778f1e0e6ba4c8ffddcb2ae4ae6d574416637933", evidence: "EVIDENCE 91" },
  18: { frontBlock: 10_686_385n, tx: "0x6542b5f393cd4b37f349ef3b2e9edfe103d81b2f675d4ee48c0bd2f2de627c8f", evidence: "EVIDENCE 104" },
};
const write = process.argv.includes("--write");
const force = process.argv.includes("--force");

if (process.argv.includes("--render")) {
  const saved = JSON.parse(readFileSync(resolve(ROOT, "docs/redteam.json"), "utf8")) as Report;
  writeFileSync(resolve(ROOT, "docs/REDTEAM.md"), renderMarkdown(saved));
  console.log("wrote docs/REDTEAM.md from docs/redteam.json");
  process.exit(0);
}

// ---------------------------------------------------------------- public inputs, read from the repo
type Deployments = {
  InstantExitVault: { address: Hex; deployTx: Hex; quorum: Hex[]; threshold: number; lp: Hex; feeBps: number; rollupId: string };
  SettlementReceiptVerifier: { address: Hex; layerId: string };
  PQGuardVault: { address: Hex };
};
const dep = JSON.parse(readFileSync(resolve(ROOT, "deployments/diana.json"), "utf8")) as Deployments;
const V = dep.InstantExitVault;
if (V.rollupId !== ROLLUP || dep.SettlementReceiptVerifier.layerId !== ROLLUP) throw new Error(`deployments/diana.json is not for ${ROLLUP}`);

const exits = realExits(readFileSync(resolve(ROOT, `data/inbox/${ROLLUP}.jsonl`), "utf8"), V.address, V.quorum);
const withFront = exits.filter((e) => FRONTED[e.batchIndex]).map((e) => ({ ...e, ...FRONTED[e.batchIndex]! }));
if (withFront.length !== 2) throw new Error(`expected the two fronted exits (batches 15 and 18) in the inbox archive, found ${withFront.map((e) => e.batchIndex).join(", ") || "none"}`);
const [e15, e18] = withFront as [(typeof withFront)[number], (typeof withFront)[number]];

const vectors = JSON.parse(readFileSync(resolve(ROOT, `test/vectors/anchors-${ROLLUP}.json`), "utf8")) as { chainId: string; layerId: string; anchors: AnchorIn[] };
const anchors = vectors.anchors.map(({ layerHeight, stateRoot, validatorSetHash, transactionCount, compressedStateProof, signature }) => ({
  layerHeight,
  stateRoot,
  validatorSetHash,
  transactionCount,
  compressedStateProof,
  signature,
}));
const a0 = anchors.find((a) => a.layerHeight === 0)!;

const payout = getAddress(`0x${bech32ToHex(PAYOUT_QOR1).replace(/^0x/, "")}`);

// ---------------------------------------------------------------- the attacker's throwaway keys
const pq = generatePqcKeypair();
const classical = privateKeyToAccount(generatePrivateKey());
const attacker = classical.address;

// ---------------------------------------------------------------- the network, paced
const client = createPublicClient({ transport: http(EVM_RPC, { retryCount: 0, timeout: 90_000 }) });
let requests = 0;
let last = 0;
async function pace(): Promise<void> {
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  requests += 1;
}

async function view<T>(contract: ContractName, to: Hex, functionName: string, args: readonly unknown[], blockNumber: bigint): Promise<T> {
  await pace();
  const { data } = await client.call({ to, data: encodeFunctionData({ abi: ABIS[contract], functionName, args }), blockNumber });
  return decodeFunctionResult({ abi: ABIS[contract], functionName, data: data ?? "0x" }) as T;
}

/** The revert data inside a viem error, if the node returned any. */
function revertData(e: unknown): Hex | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const inner = e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: unknown } | null;
  return typeof inner?.data === "string" && /^0x[0-9a-fA-F]*$/.test(inner.data) ? (inner.data as Hex) : undefined;
}

async function run(c: Case): Promise<string> {
  await pace();
  try {
    await client.call({ account: c.from, data: c.data, blockNumber: c.block, ...(c.code ? { code: c.code } : { to: c.to! }) });
    return "ok";
  } catch (e) {
    const data = revertData(e);
    if (data !== undefined) return decodeRevert(c.contract, data);
    const msg = (e instanceof BaseError ? e.shortMessage : String(e)).split("\n")[0] ?? "";
    return `${NOT_RUN}${msg}`;
  }
}

console.log(`redteam: ${EVM_RPC} (EVM chain ${EVM_CHAIN_ID}); attacker ${attacker} (throwaway keys, this run only)`);
await pace();
const head = await client.getBlockNumber({ cacheTime: 0 });
console.log(`head block ${head}`);

// The vault's deploy-tx input (creation code and its own constructor arguments): run in place, it is the same
// vault at another address.
let vaultCopy: Inputs["vaultCopy"];
try {
  await pace();
  const tx = await client.getTransaction({ hash: V.deployTx });
  const args = encodeAbiParameters(VAULT_CTOR, [CHAIN_ID, ROLLUP, V.quorum, BigInt(V.threshold), V.lp, V.feeBps]);
  if (tx.to !== null || !tx.input.toLowerCase().endsWith(args.slice(2).toLowerCase())) throw new Error("the deploy tx does not end with the recorded constructor arguments");
  vaultCopy = { code: tx.input };
} catch (e) {
  console.log(`  the replay-at-another-vault attack is left out: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  vaultCopy = undefined;
}

// The exact messages the LP and the guardian would sign now, so the attacker's key signs those bytes.
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const lpWithdraw = { amount: 10n ** 18n, nonce: await view<bigint>("InstantExitVault", V.address, "withdrawNonce", [], head), deadline };
const withdrawMsg = await view<Hex>("InstantExitVault", V.address, "withdrawMessage", [attacker, lpWithdraw.amount, lpWithdraw.nonce, deadline], head);
const release = { amount: 25n * 10n ** 18n, nonce: await view<bigint>("PQGuardVault", dep.PQGuardVault.address, "nonce", [], head), deadline };
const releaseMsg = await view<Hex>(
  "PQGuardVault",
  dep.PQGuardVault.address,
  "releaseMessage",
  ["0x0000000000000000000000000000000000000000", attacker, release.amount, deadline, release.nonce],
  head,
);

const target: ExitTarget = { evmChainId: EVM_CHAIN_ID, vault: V.address, chainId: CHAIN_ID, rollupId: ROLLUP };
const exitMsg15 = exitMessage(target, e15);
const anchorMsg0 = anchorSignBytesV2({
  chainId: vectors.chainId,
  layerId: vectors.layerId,
  layerHeight: a0.layerHeight,
  stateRoot: a0.stateRoot.slice(2),
  validatorSetHash: a0.validatorSetHash.slice(2),
  transactionCount: a0.transactionCount,
  compressedStateProof: a0.compressedStateProof.slice(2),
});

const inputs: Inputs = {
  vault: V.address,
  verifier: dep.SettlementReceiptVerifier.address,
  guard: dep.PQGuardVault.address,
  payout,
  attacker,
  head,
  exits: [e15, e18],
  anchors,
  fresh: {
    exitSig: pqcSign(pq.secretKey, exitMsg15),
    anchorSig: pqcSign(pq.secretKey, anchorMsg0),
    withdrawSig: pqcSign(pq.secretKey, hexToBytes(withdrawMsg.slice(2))),
    releaseSig: pqcSign(pq.secretKey, hexToBytes(releaseMsg.slice(2))),
    ecdsaSig: hexToBytes((await classical.sign({ hash: keccak256(exitMsg15) })).slice(2)),
  },
  lpWithdraw,
  release,
  vaultCopy,
};
pq.secretKey.fill(0);

// ---------------------------------------------------------------- run every case
const results: Result[] = [];
for (const c of buildCases(inputs)) {
  const r = judge(c, await run(c));
  results.push(r);
  const mark = r.ok === null ? "-" : r.ok ? "✓" : "✕";
  console.log(`${mark} ${r.id.padEnd(3)} ${c.contract}.${c.fn} @${c.block}: ${r.title}: ${r.got}${r.ok === false ? ` (expected ${r.expect})` : ""}`);
}

const summary = summarize(results);
const report: Report = {
  run: { at: new Date().toISOString(), endpoint: EVM_RPC, evmChainId: EVM_CHAIN_ID, head: head.toString(), requests, minGapMs: MIN_GAP_MS, attacker },
  contracts: { InstantExitVault: V.address, SettlementReceiptVerifier: dep.SettlementReceiptVerifier.address, PQGuardVault: dep.PQGuardVault.address },
  summary,
  results,
};
console.log(
  `\n${summary.refused} of ${summary.attacks} attacks refused, ${summary.asExpected} with the expected error; ` +
    `${summary.controlsPassed} of ${summary.controls} controls passed; ${summary.notRun} not run; ${requests} requests`,
);
if (write && summary.notRun > 0 && !force) {
  console.log(`not writing: ${summary.notRun} case(s) did not run, and docs/redteam.json keeps the last complete run (--force writes this one anyway)`);
} else if (write) {
  writeFileSync(resolve(ROOT, "docs/redteam.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(ROOT, "docs/REDTEAM.md"), renderMarkdown(report));
  console.log("wrote docs/REDTEAM.md and docs/redteam.json");
}
process.exit(exitCode(results));
