/**
 * The InstantExitVault (contracts/src/InstantExitVault.sol) over the EVM JSON-RPC: free reads with
 * eth_call, revert reasons decoded by name, and the two calls the relayer sends (`front`, `sweep`).
 * Nothing here sends value; every transaction goes to the vault.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ExitClaim } from "@vigil/qledger-watchtower";

export const VAULT_ABI = parseAbi([
  "struct Exit { uint64 batchIndex; bytes32 stateRoot; uint64 withdrawalIndex; uint64 amountUqor; address payout; uint64 deadline; }",
  "function chainId() view returns (string)",
  "function rollupId() view returns (string)",
  "function quorum() view returns (address[])",
  "function threshold() view returns (uint256)",
  "function lp() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function available() view returns (uint256)",
  "function totalOwed() view returns (uint256)",
  "function owed(address payout) view returns (uint256)",
  "function keyOf(address account) view returns (bytes)",
  "function exitAddressOf(address payout) view returns (address)",
  "function verifyExit(Exit e, uint256[] signers, bytes[] sigs) view returns (bytes32)",
  "function front(Exit e, uint256[] signers, bytes[] sigs)",
  "function sweep(address payout)",
  "error BadConfig()",
  "error UnknownChain()",
  "error Expired()",
  "error AlreadyFronted()",
  "error NotEnoughSigners()",
  "error SignersNotAscending()",
  "error BadSignature(uint256 member)",
  "error KeyNotUsable(address member)",
  "error NotEnoughLiquidity(uint256 available, uint256 needed)",
  "error NotExitAddress()",
  "error BadNonce()",
  "error PrecompileUnavailable()",
  "error TransferFailed()",
]);

/** 1 uqor (the rollup's withdrawal unit) is 10^12 wei on the EVM side of the same balance. */
export const WEI_PER_UQOR = 1_000_000_000_000n;

export interface ExitArg {
  batchIndex: bigint;
  stateRoot: Hex;
  withdrawalIndex: bigint;
  amountUqor: bigint;
  payout: Hex;
  deadline: bigint;
}

export const exitArg = (c: ExitClaim, payout: string): ExitArg => ({
  batchIndex: BigInt(c.batchIndex),
  stateRoot: `0x${c.stateRoot.replace(/^0x/, "")}`,
  withdrawalIndex: BigInt(c.withdrawalIndex),
  amountUqor: c.amountUqor,
  payout: getAddress(`0x${payout.replace(/^0x/, "")}`),
  deadline: BigInt(c.deadline),
});

/** A view call's outcome: "ok" with its value, or the revert's error name and arguments. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export class Vault {
  readonly pub: PublicClient;
  private readonly chain: ReturnType<typeof defineChain>;
  private wallet?: WalletClient;

  constructor(
    readonly address: Hex,
    evmRpc: string,
    evmChainId: number,
  ) {
    const chain = defineChain({
      id: evmChainId,
      name: `qorechain-${evmChainId}`,
      nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
      rpcUrls: { default: { http: [evmRpc] } },
    });
    this.pub = createPublicClient({ chain, transport: http(evmRpc, { timeout: 60_000, retryCount: 3 }) });
    this.chain = chain;
  }

  /** Attach the relayer's ECDSA key for sending. It can only send while its EVM window is open. */
  withSigner(privateKey: Hex): this {
    this.wallet = createWalletClient({ chain: this.chain, account: privateKeyToAccount(privateKey), transport: http(this.chain.rpcUrls.default.http[0], { timeout: 60_000 }) });
    return this;
  }

  read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.address, abi: VAULT_ABI, functionName: functionName as never, args: args as never }) as Promise<T>;
  }

  async outcome<T>(functionName: string, args: readonly unknown[]): Promise<Outcome<T>> {
    try {
      return { ok: true, value: await this.read<T>(functionName, args) };
    } catch (e) {
      return { ok: false, reason: revertReason(e) };
    }
  }

  balance(address: Hex): Promise<bigint> {
    return this.pub.getBalance({ address });
  }

  /**
   * Build one call and size it: gas = 1.3 × the estimate. Estimating needs no EVM window, so the
   * relayer can size a window to exactly the calls it is about to make before it opens one.
   */
  async prepare(from: Hex, functionName: "front" | "sweep", args: readonly unknown[], gasPrice: bigint): Promise<PreparedCall> {
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName, args: args as never });
    // Estimated at the gas price it will be sent with: without one, this chain runs the estimate with
    // tx.gasprice = 0, which a hostile payout contract could tell apart from the real call.
    const gas = ((await this.pub.estimateGas({ account: from, to: this.address, data, gasPrice })) * 13n) / 10n;
    return { functionName, data, gas };
  }

  /**
   * Send prepared calls in order with explicit nonces, each at exactly its gas limit and `gasPrice`
   * (so the window's fee cap holds), waiting for each receipt. Call only while the window is open:
   * opening it was a native transaction that advanced the nonce, so the nonce is read here, after.
   */
  async sendAll(calls: PreparedCall[], gasPrice: bigint, onReceipt: (c: PreparedCall, r: TransactionReceipt) => void): Promise<void> {
    if (!this.wallet?.account) throw new Error("no signer attached");
    let nonce = await this.pub.getTransactionCount({ address: this.wallet.account.address, blockTag: "pending" });
    for (const c of calls) {
      const hash = await this.wallet.sendTransaction({ account: this.wallet.account, chain: this.chain, to: this.address, data: c.data, gas: c.gas, gasPrice, value: 0n, nonce: nonce++ });
      onReceipt(c, await this.pub.waitForTransactionReceipt({ hash, timeout: 180_000 }));
    }
  }
}

export interface PreparedCall {
  functionName: "front" | "sweep";
  data: Hex;
  gas: bigint;
}

/** The most `calls` can spend in fees at `gasPrice`, in uqor rounded up (what a window's cap counts). */
export function feeCapUqor(calls: PreparedCall[], gasPrice: bigint): bigint {
  const wei = calls.reduce((n, c) => n + c.gas * gasPrice, 0n);
  return (wei + WEI_PER_UQOR - 1n) / WEI_PER_UQOR;
}

/** The custom error a call reverted with, as `Name(arg, …)`, or the first line of the failure. */
export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) {
      return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
    }
    return e.shortMessage;
  }
  return (e as Error).message.split("\n")[0] ?? String(e);
}
