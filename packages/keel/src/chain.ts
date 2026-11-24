/**
 * Native-lane transactions from a unified eth-native account, hybrid-signed
 * (secp256k1 + ML-DSA-87). Every send is simulated first and sized from the
 * simulation; nothing here opens an EVM window.
 */
import { StargateClient } from "@cosmjs/stargate";
import type { EncodeObject, Registry } from "@cosmjs/proto-signing";
import { EthNativeSigner, type UnifiedAccount } from "@qorechain/sdk";
import { createRdkRegistry } from "@qorechain/rdk";
import { TESTNET, restGet } from "@vigil/core";

/** What the chain charged for every rollup transaction so far (uqor per unit of gas). */
export const FEE_PER_GAS = 0.15;
const GAS_MULTIPLIER = 1.4;

export interface SimResult {
  ok: boolean;
  gasUsed?: number;
  error?: string;
}

export interface SendResult {
  transactionHash: string;
  height: number;
  gasUsed: bigint;
  gasWanted: bigint;
  feeUqor: number;
  events: readonly { type: string; attributes: readonly { key: string; value: string }[] }[];
}

export class HybridSender {
  readonly signer: EthNativeSigner;

  /** `registry` defaults to the RDK's; pass a larger one to send other message types (EVM windows, say). */
  constructor(
    readonly account: UnifiedAccount,
    registry: Registry = createRdkRegistry(),
  ) {
    this.signer = new EthNativeSigner(account, { signMode: "hybrid", rest: TESTNET.rest, registry });
  }

  get address(): string {
    return this.account.cosmos;
  }

  private async accountSequence(): Promise<{ accountNumber: bigint; sequence: bigint }> {
    const a = await restGet<{
      account: { account_number?: string; sequence?: string; base_account?: { account_number: string; sequence: string } };
    }>(`/cosmos/auth/v1beta1/accounts/${this.address}`);
    const base = a.account.base_account ?? a.account;
    return { accountNumber: BigInt(base.account_number ?? "0"), sequence: BigInt(base.sequence ?? "0") };
  }

  /** Sign the real transaction and ask the chain to dry-run it. Spends nothing. */
  async simulate(messages: EncodeObject[]): Promise<SimResult> {
    const { accountNumber, sequence } = await this.accountSequence();
    const signBytesVersion = await this.signer.resolveSignBytesVersion(TESTNET.chainId);
    const signed = this.signer.sign({
      chainId: TESTNET.chainId,
      accountNumber,
      sequence,
      messages,
      fee: { amount: [{ denom: "uqor", amount: "300000" }], gas: "2000000" },
      signBytesVersion,
    });
    const r = await fetch(`${TESTNET.rest}/cosmos/tx/v1beta1/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_bytes: Buffer.from(signed.txRawBytes).toString("base64") }),
    });
    const j = (await r.json()) as { gas_info?: { gas_used: string }; message?: string };
    if (!r.ok || !j.gas_info) return { ok: false, error: j.message ?? `HTTP ${r.status}` };
    return { ok: true, gasUsed: Number(j.gas_info.gas_used) };
  }

  /** Broadcast with gas = 1.4 × the simulated gas. Throws on a non-zero code. */
  async send(messages: EncodeObject[], simulatedGas: number): Promise<SendResult> {
    const gas = Math.ceil(simulatedGas * GAS_MULTIPLIER);
    const feeUqor = Math.ceil(gas * FEE_PER_GAS);
    const { accountNumber, sequence } = await this.accountSequence();
    const transport = await StargateClient.connect(TESTNET.rpc);
    try {
      const res = await this.signer.signAndBroadcast(transport, {
        chainId: TESTNET.chainId,
        accountNumber,
        sequence,
        messages,
        fee: { amount: [{ denom: "uqor", amount: String(feeUqor) }], gas: String(gas) },
      });
      if (res.code !== 0) throw new Error(`tx ${res.transactionHash} failed with code ${res.code}: ${res.rawLog ?? ""}`);
      const tx = await this.txResult(res.transactionHash);
      return {
        transactionHash: res.transactionHash,
        height: res.height ?? Number(tx?.height ?? 0),
        gasUsed: res.gasUsed ?? BigInt(tx?.gas_used ?? 0),
        gasWanted: res.gasWanted ?? BigInt(tx?.gas_wanted ?? gas),
        feeUqor,
        events: tx?.events ?? [],
      };
    } finally {
      transport.disconnect();
    }
  }

  /** The included transaction as the REST API serves it (events included); undefined if not found in time. */
  async txResult(hash: string): Promise<
    { height: string; gas_used: string; gas_wanted: string; events: SendResult["events"] } | undefined
  > {
    for (let i = 0; i < 10; i++) {
      try {
        const r = await restGet<{ tx_response: { height: string; gas_used: string; gas_wanted: string; events: SendResult["events"] } }>(
          `/cosmos/tx/v1beta1/txs/${hash}`,
        );
        return r.tx_response;
      } catch {
        await new Promise((ok) => setTimeout(ok, 1500));
      }
    }
    return undefined;
  }

  async balanceUqor(): Promise<bigint> {
    const b = await restGet<{ balance: { amount: string } }>(`/cosmos/bank/v1beta1/balances/${this.address}/by_denom?denom=uqor`);
    return BigInt(b.balance.amount);
  }

  async evmWindowOpen(): Promise<boolean> {
    const w = await restGet<{ found: boolean; live: boolean }>(`/qorechain/pqc/v1/evm_window/${this.address}`);
    return w.found && w.live;
  }
}
