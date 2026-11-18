/**
 * Create Vigil's own qledger-v1 rollup and bond its creator as a submitter.
 *
 * Simulates by default: signs the real transaction and asks the chain to
 * dry-run it (/cosmos/tx/v1beta1/simulate), so nothing is spent. Only
 * `--broadcast` sends anything, and it locks 11,000 QOR for the life of the
 * rollup (a based rollup can only be stopped by governance). Both team members
 * agree in writing first (vigil-kit HANDOVER §7.5).
 *
 * The settings match every qledger-v1 rollup on qorechain-diana, including the
 * RDK team's own reference rollup: profile "nft", VM "cosmwasm", based
 * sequencing, qledger-v1 execution, optimistic with fraud proofs.
 *
 *   tsx rollup/create-rollup.ts --env <path to the creator's .env> [--id vigil-pay-1]
 *                               [--step create|bond|all] [--broadcast]
 *
 * The .env holds either QORE_MNEMONIC, or PRIVATE_KEY (0x + 64 hex) together
 * with QORE_PQC_RECOVERY_CODE (QRC1-…). Secrets are read into memory only and
 * never printed.
 */
import "../lib/net.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EthNativeSigner,
  deriveUnifiedAccount,
  fetchPqcStatus,
  isRegisteredPqcKey,
  isValidRecoveryCode,
  unifiedAccountFromSeed,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { bondRollupSubmitterMsg, createRdkRegistry, createRollupMsg } from "@qorechain/rdk";
import { StargateClient } from "@cosmjs/stargate";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { CHAIN_ID, REST, RPC, getJson } from "../lib/native.ts";

const ROLLUP = {
  profile: "nft",
  vmType: "cosmwasm",
  sequencing: "based" as const,
  executionVm: "qledger-v1" as const,
};
const STAKE_UQOR = 10_000_000_000n; // 10,000 QOR; the chain burns rollup_creation_burn_rate (1%) of it
const BOND_UQOR = 1_000_000_000n; // 1,000 QOR, the chain's min_submitter_bond
const FEE_PER_GAS = 0.15; // uqor; what the chain charged vigil-1's creation (69,530 for 463,528 gas)
/** The Q-Day Drill ends at 18 Nov 23:59:59 UTC. The drill account must not be funded or used before then. */
const DRILL_END = Date.parse("2026-11-19T00:00:00Z");

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const broadcast = argv.includes("--broadcast");
const rollupId = arg("--id") ?? "vigil-pay-1";
const step = (arg("--step") ?? "all") as "create" | "bond" | "all";
const envPath = arg("--env") ?? process.env.VIGIL_CREATOR_ENV;
if (!envPath) throw new Error("Pass --env <path to the creator's .env> (or set VIGIL_CREATOR_ENV)");
if (!["create", "bond", "all"].includes(step)) throw new Error(`--step must be create, bond or all, got ${step}`);
if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(rollupId)) throw new Error(`unexpected rollup id ${rollupId}`);

function readEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(resolve(path), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined && m[2] !== "") out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").trim();
  }
  return out;
}

async function loadAccount(env: Record<string, string>): Promise<UnifiedAccount> {
  if (env.QORE_MNEMONIC) return deriveUnifiedAccount(env.QORE_MNEMONIC, 0);
  const key = env.PRIVATE_KEY;
  const code = env.QORE_PQC_RECOVERY_CODE;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the .env needs QORE_MNEMONIC, or PRIVATE_KEY as 0x + 64 hex");
  if (!code || !isValidRecoveryCode(code)) throw new Error("the .env needs a valid QORE_PQC_RECOVERY_CODE (QRC1-…) with PRIVATE_KEY");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

const fmtQor = (uqor: bigint) => `${(Number(uqor) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;

async function rollupExists(id: string): Promise<boolean> {
  const r = await fetch(`${REST}/qorechain/rdk/v1/rollup/${encodeURIComponent(id)}`);
  if (r.ok) return true;
  const body = (await r.json().catch(() => ({}))) as { code?: number };
  if (body.code === 5) return false; // NotFound
  throw new Error(`rollup lookup failed: HTTP ${r.status}`);
}

async function uqorBalance(addr: string): Promise<bigint> {
  const b = await getJson<{ balance: { amount: string } }>(`/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=uqor`);
  return BigInt(b.balance.amount);
}

async function accountSequence(addr: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  const a = await getJson<{ account: { account_number?: string; sequence?: string; base_account?: { account_number: string; sequence: string } } }>(
    `/cosmos/auth/v1beta1/accounts/${addr}`,
  );
  const base = a.account.base_account ?? a.account;
  return { accountNumber: BigInt(base.account_number ?? "0"), sequence: BigInt(base.sequence ?? "0") };
}

interface SimResult {
  ok: boolean;
  gasUsed?: number;
  error?: string;
}

async function simulate(signer: EthNativeSigner, messages: EncodeObject[], addr: string): Promise<SimResult> {
  const { accountNumber, sequence } = await accountSequence(addr);
  const signBytesVersion = await signer.resolveSignBytesVersion(CHAIN_ID);
  const signed = signer.sign({
    chainId: CHAIN_ID,
    accountNumber,
    sequence,
    messages,
    fee: { amount: [{ denom: "uqor", amount: "300000" }], gas: "2000000" },
    signBytesVersion,
  });
  const r = await fetch(`${REST}/cosmos/tx/v1beta1/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_bytes: Buffer.from(signed.txRawBytes).toString("base64") }),
  });
  const j = (await r.json()) as { gas_info?: { gas_used: string }; message?: string; code?: number };
  if (!r.ok || !j.gas_info) return { ok: false, error: j.message ?? `HTTP ${r.status}` };
  return { ok: true, gasUsed: Number(j.gas_info.gas_used) };
}

async function send(signer: EthNativeSigner, messages: EncodeObject[], addr: string, gasUsed: number) {
  const gas = Math.ceil(gasUsed * 1.4);
  const { accountNumber, sequence } = await accountSequence(addr);
  const transport = await StargateClient.connect(RPC);
  try {
    const res = await signer.signAndBroadcast(transport, {
      chainId: CHAIN_ID,
      accountNumber,
      sequence,
      messages,
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * FEE_PER_GAS)) }], gas: String(gas) },
    });
    if (res.code !== 0) throw new Error(`tx ${res.transactionHash} failed with code ${res.code}: ${res.rawLog ?? ""}`);
    return res;
  } finally {
    transport.disconnect();
  }
}

// ------------------------------------------------------------------ preflight
const account = await loadAccount(readEnv(envPath));
const creator = account.cosmos;
const params = await getJson<{ params: { min_stake_for_rollup: string; min_submitter_bond: string; rollup_creation_burn_rate: string } }>(
  "/qorechain/rdk/v1/params",
);
const pqc = await fetchPqcStatus({ rest: REST, address: creator });
const window = await getJson<{ found: boolean; live: boolean }>(`/qorechain/pqc/v1/evm_window/${creator}`);
const exists = await rollupExists(rollupId);
const balance = await uqorBalance(creator);
const burn = (STAKE_UQOR * BigInt(Math.round(Number(params.params.rollup_creation_burn_rate) * 10_000))) / 10_000n;

console.log(`creator         ${creator}`);
console.log(`rollup          ${rollupId} (${exists ? "ALREADY EXISTS" : "id is free"})`);
console.log(`settings        profile=${ROLLUP.profile} vm=${ROLLUP.vmType} sequencing=${ROLLUP.sequencing} execution=${ROLLUP.executionVm}`);
console.log(`stake           ${fmtQor(STAKE_UQOR)} (chain minimum ${fmtQor(BigInt(params.params.min_stake_for_rollup))}; ${fmtQor(burn)} burned)`);
console.log(`submitter bond  ${fmtQor(BOND_UQOR)} (chain minimum ${fmtQor(BigInt(params.params.min_submitter_bond))})`);
console.log(`balance         ${fmtQor(balance)}`);
console.log(`PQ key          registered=${pqc.registered} matchesLocalKey=${isRegisteredPqcKey(pqc, account.pqc.publicKey)}`);
console.log(`EVM window      ${window.found ? (window.live ? "OPEN" : "found, not live") : "none"}`);

const problems: string[] = [];
if (STAKE_UQOR < BigInt(params.params.min_stake_for_rollup)) problems.push("stake is below the chain minimum");
if (BOND_UQOR < BigInt(params.params.min_submitter_bond)) problems.push("bond is below the chain minimum");
if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) problems.push("the creator's ML-DSA-87 key is not registered, or is not the key in this .env");
if (window.found && window.live) problems.push("the creator has an open EVM window; close it first");
if (step !== "bond" && exists) problems.push(`rollup ${rollupId} already exists`);
if (step === "bond" && !exists) problems.push(`rollup ${rollupId} does not exist yet; run --step create first`);
if (broadcast && Date.now() < DRILL_END) problems.push("the Q-Day Drill is still running (ends 18 Nov 23:59:59 UTC); the drill account must not be used before then");
if (problems.length) {
  for (const p of problems) console.error(`refused: ${p}`);
  process.exit(1);
}

const signer = new EthNativeSigner(account, { signMode: "hybrid", rest: REST, registry: createRdkRegistry() });
const createMsg = createRollupMsg({ creator, rollupId, stakeAmount: STAKE_UQOR, ...ROLLUP });
const bondMsg = bondRollupSubmitterMsg({ submitter: creator, rollupId, amount: BOND_UQOR });

// ------------------------------------------------------------------ create
if (step === "create" || step === "all") {
  const sim = await simulate(signer, [createMsg], creator);
  console.log(`simulate create ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
  if (!sim.ok || sim.gasUsed === undefined) process.exit(broadcast ? 1 : 0);
  if (broadcast) {
    const res = await send(signer, [createMsg], creator, sim.gasUsed);
    console.log(`created         tx ${res.transactionHash} at height ${res.height ?? "?"}`);
  }
}

// ------------------------------------------------------------------ bond
if (step === "bond" || step === "all") {
  if (!(await rollupExists(rollupId))) {
    console.log("simulate bond   skipped: the rollup does not exist yet (simulate it after --step create --broadcast)");
  } else {
    const sim = await simulate(signer, [bondMsg], creator);
    console.log(`simulate bond   ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
    if (sim.ok && sim.gasUsed !== undefined && broadcast) {
      const res = await send(signer, [bondMsg], creator, sim.gasUsed);
      console.log(`bonded          tx ${res.transactionHash} at height ${res.height ?? "?"}`);
    }
  }
}

if (broadcast) {
  const r = await getJson<{ rollup: Record<string, string> }>(`/qorechain/rdk/v1/rollup/${rollupId}`);
  const { rollup_id, creator: c, status, settlement_mode, proof_system, sequencing, execution_vm, created_height, escrow_balance } = r.rollup;
  console.log("on chain        ", { rollup_id, creator: c, status, settlement_mode, proof_system, sequencing, execution_vm, created_height, escrow_balance });
  console.log("Add an EVIDENCE.md row for each tx above.");
}
