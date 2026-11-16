/**
 * Register a role account's ML-DSA-87 key on chain (MsgRegisterPQCKeyV2 with
 * proof of possession). This must be the account's FIRST transaction, on its
 * own; it is the one classical-signed, hybrid-exempt transaction.
 *
 *   tsx drill/register-pqc.ts --role drill              # build and check only
 *   tsx drill/register-pqc.ts --role drill --broadcast  # actually send (~0.06 QOR fee)
 *
 * Afterwards it reads GET /qorechain/pqc/v1/account/{addr} and the EVM window
 * route, and prints what an EVIDENCE.md row needs.
 */
import "../lib/net.ts";
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  signProofOfPossession,
  sha256Hex,
} from "@qorechain/sdk";
import { loadRoleEnv, requireVar } from "../lib/env.ts";

const REST = "https://api-testnet.qore.host";
const RPC = "https://rpc-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";

const args = process.argv.slice(2);
const role = args[args.indexOf("--role") + 1];
if (!args.includes("--role") || !role) {
  console.error("usage: register-pqc.ts --role <role> [--broadcast]");
  process.exit(2);
}
const broadcast = args.includes("--broadcast");
const env = loadRoleEnv(role);
const upper = role.toUpperCase().replace(/-/g, "_");
const account = await deriveUnifiedAccount(requireVar(env, `${upper}_MNEMONIC`), 0);
if (account.cosmos !== requireVar(env, `${upper}_QOR_ADDRESS`)) throw new Error("mnemonic does not match the saved address");

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const r = await fetch(`${REST}${path}`);
  return { status: r.status, body: (await r.json()) as T };
}

const pqcBefore = await getJson<{ found: boolean }>(`/qorechain/pqc/v1/account/${account.cosmos}`);
if (pqcBefore.body.found) {
  console.log(`${account.cosmos} already has a PQC key registered; nothing to do.`);
  process.exit(0);
}
const auth = await getJson<{ account?: { account_number: string; sequence: string } }>(
  `/cosmos/auth/v1beta1/accounts/${account.cosmos}`,
);
if (auth.status !== 200 || !auth.body.account) {
  console.error(`${account.cosmos} does not exist on chain yet (HTTP ${auth.status}): fund it from the faucet first.`);
  process.exit(1);
}
const bal = await getJson<{ balances: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${account.cosmos}`);
const uqor = BigInt(bal.body.balances.find((b) => b.denom === "uqor")?.amount ?? "0");
console.log(`account ${account.cosmos} (${account.evm}): ${Number(uqor) / 1e6} QOR, sequence ${auth.body.account.sequence}`);
if (auth.body.account.sequence !== "0") {
  console.error("sequence is not 0: this account has already sent a transaction. Registration must be its first; stopping.");
  process.exit(1);
}

const msg = buildRegisterPqcKeyMsg(account.cosmos, {
  pqcKeypair: account.pqc,
  ecdsaPubkey: Uint8Array.from(Buffer.from(account.publicKey.slice(2), "hex")),
  proofOfPossession: signProofOfPossession({ chainId: CHAIN_ID, account: account.cosmos, keypair: account.pqc }),
});
const fee = { amount: [{ denom: "uqor", amount: "90000" }], gas: "900000" };
console.log(`message: ${msg.typeUrl}; key sha256 ${sha256Hex(account.pqc.publicKey)}; fee ${Number(fee.amount[0]?.amount) / 1e6} QOR (gas ${fee.gas})`);

if (!broadcast) {
  console.log("dry run: pass --broadcast to send it.");
  process.exit(0);
}

const transport = await StargateClient.connect(RPC);
const signer = new EthNativeSigner(account, { signMode: "classical" });
const res = await signer.signAndBroadcast(transport, {
  chainId: CHAIN_ID,
  accountNumber: BigInt(auth.body.account.account_number),
  sequence: BigInt(auth.body.account.sequence),
  messages: [msg],
  fee,
  memo: `vigil ${role}: register ML-DSA-87 key`,
});
console.log(`tx ${res.transactionHash} code ${res.code} height ${res.height ?? "?"} gasUsed ${res.gasUsed ?? "?"}`);
if (res.code !== 0) {
  console.error(res.rawLog);
  process.exit(1);
}

// Verify on chain.
for (let i = 0; i < 20; i++) {
  const after = await getJson<{ found: boolean; account?: Record<string, unknown> }>(`/qorechain/pqc/v1/account/${account.cosmos}`);
  if (after.body.found) {
    const a = after.body.account ?? {};
    console.log(`GET /qorechain/pqc/v1/account/${account.cosmos}: found; fields ${Object.keys(a).join(", ")}`);
    console.log(JSON.stringify({ ...a, public_key: a["public_key"] ? `<${String(a["public_key"]).length} chars>` : undefined }, null, 2));
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const win = await getJson<{ found: boolean; live: boolean }>(`/qorechain/pqc/v1/evm_window/${account.cosmos}`);
console.log(`EVM window: found=${win.body.found} live=${win.body.live}`);
console.log(`explorer: https://explore.qore.network/tx/${res.transactionHash}`);
