/** Native-lane (Cosmos) transactions from a unified eth-native account, hybrid-signed. */
import { StargateClient } from "@cosmjs/stargate";
import type { EncodeObject } from "@cosmjs/proto-signing";
import { EthNativeSigner, deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import { loadRoleEnv, requireVar } from "./env.ts";

export const REST = "https://api-testnet.qore.host";
export const RPC = "https://rpc-testnet.qore.host";
export const EVM_RPC = "https://evm-testnet.qore.host";
export const CHAIN_ID = "qorechain-diana";
export const EVM_CHAIN_ID = 9800;

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${REST}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function loadRoleAccount(role: string): Promise<UnifiedAccount> {
  const env = loadRoleEnv(role);
  const upper = role.toUpperCase().replace(/-/g, "_");
  const acct = await deriveUnifiedAccount(requireVar(env, `${upper}_MNEMONIC`), 0);
  if (acct.cosmos !== requireVar(env, `${upper}_QOR_ADDRESS`)) throw new Error(`${role}: mnemonic does not match saved address`);
  return acct;
}

export interface WindowStatus {
  found: boolean;
  live: boolean;
  opened_height: string;
  expiry_height: string;
  max_txs: string;
  used_txs: string;
  max_value: string;
  used_value: string;
  native_only: boolean;
  allowed_targets: string[];
}

export const windowStatus = (addr: string) => getJson<WindowStatus>(`/qorechain/pqc/v1/evm_window/${addr}`);

export async function balances(addr: string): Promise<Record<string, string>> {
  const b = await getJson<{ balances: { denom: string; amount: string }[] }>(`/cosmos/bank/v1beta1/balances/${addr}`);
  return Object.fromEntries(b.balances.map((x) => [x.denom, x.amount]));
}

/** Sign (hybrid: secp256k1 + ML-DSA-87) and broadcast native messages; throws on a non-zero code. */
export async function sendHybrid(
  account: UnifiedAccount,
  messages: EncodeObject[],
  opts: { gas: number; memo?: string },
): Promise<{ transactionHash: string; height?: number; gasUsed?: bigint }> {
  const auth = await getJson<{ account: { account_number: string; sequence: string } }>(
    `/cosmos/auth/v1beta1/accounts/${account.cosmos}`,
  );
  const transport = await StargateClient.connect(RPC);
  const signer = new EthNativeSigner(account, { rest: REST });
  const feeUqor = Math.ceil(opts.gas * 0.12);
  const res = await signer.signAndBroadcast(transport, {
    chainId: CHAIN_ID,
    accountNumber: BigInt(auth.account.account_number),
    sequence: BigInt(auth.account.sequence),
    messages,
    fee: { amount: [{ denom: "uqor", amount: String(feeUqor) }], gas: String(opts.gas) },
    ...(opts.memo ? { memo: opts.memo } : {}),
  });
  transport.disconnect();
  if (res.code !== 0) throw new Error(`tx ${res.transactionHash} failed code ${res.code}: ${res.rawLog ?? ""}`);
  return res;
}
