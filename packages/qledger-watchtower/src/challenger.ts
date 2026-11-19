/**
 * Send MsgChallengeBatch from a watchtower account (unified eth-native,
 * hybrid-signed: secp256k1 + ML-DSA-87). The only transaction the watchtower
 * ever sends, and only for a proof that `checkQledgerFraud` says wins.
 */
import { StargateClient } from "@cosmjs/stargate";
import { challengeBatchMsg } from "@qorechain/rdk";
import { EthNativeSigner, deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import type { Challenge } from "./check.ts";

export interface ChainEndpoints {
  chainId: string;
  rest: string;
  rpc: string;
}

export async function accountFromMnemonic(mnemonic: string): Promise<UnifiedAccount> {
  return deriveUnifiedAccount(mnemonic.trim(), 0);
}

export async function sendChallenge(
  account: UnifiedAccount,
  rollupId: string,
  challenge: Challenge,
  ep: ChainEndpoints,
): Promise<{ transactionHash: string; height?: number; code: number; rawLog?: string }> {
  if (!challenge.wins) throw new Error(`refusing to send a challenge for batch ${challenge.batchIndex} that checkQledgerFraud rejects`);
  const r = await fetch(`${ep.rest}/cosmos/auth/v1beta1/accounts/${account.cosmos}`);
  if (!r.ok) throw new Error(`watchtower account ${account.cosmos} not found on chain (HTTP ${r.status})`);
  const { account: base } = (await r.json()) as { account: { account_number: string; sequence: string } };
  const transport = await StargateClient.connect(ep.rpc);
  try {
    const signer = new EthNativeSigner(account, { rest: ep.rest });
    // Re-execution on chain costs gas in proportion to the proof; leave generous room.
    const gas = 2_000_000 + challenge.proof.length * 20;
    return await signer.signAndBroadcast(transport, {
      chainId: ep.chainId,
      accountNumber: BigInt(base.account_number),
      sequence: BigInt(base.sequence),
      messages: [challengeBatchMsg({ challenger: account.cosmos, rollupId, batchIndex: challenge.batchIndex, proof: challenge.proof })],
      fee: { amount: [{ denom: "uqor", amount: String(Math.ceil(gas * 0.12)) }], gas: String(gas) },
      memo: `vigil watchtower: challenge ${rollupId} batch ${challenge.batchIndex}`,
    });
  } finally {
    transport.disconnect();
  }
}
