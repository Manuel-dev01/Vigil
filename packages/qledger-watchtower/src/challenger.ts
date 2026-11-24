/**
 * Send MsgChallengeBatch from a watchtower account (unified eth-native,
 * hybrid-signed: secp256k1 + ML-DSA-87). The only transaction the watchtower
 * ever sends, and only for a proof that `checkQledgerFraud` says wins.
 *
 * In drill 1 (19 Nov) our challenge reached the same block as the winning one
 * and lost on its position within the block. Each challenge opened a fresh RPC
 * connection, looked up its account, then waited for the block. `Challenger`
 * does all of that ahead of time and pays a higher gas price.
 */
import { StargateClient } from "@cosmjs/stargate";
import { challengeBatchMsg, createRdkRegistry, postRollupDataMsg } from "@qorechain/rdk";
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

/** What the challenger needs from the chain. `rpcTransport` is the real one; tests pass a fake. */
export interface ChallengeTransport {
  account(address: string): Promise<{ accountNumber: bigint; sequence: bigint }>;
  /** Broadcast and return after CheckTx: the tx hash, or a throw carrying `code` when CheckTx refuses it. */
  broadcastSync(tx: Uint8Array): Promise<string>;
  /** The delivered result, or undefined while the tx is not yet in a block. */
  result(hash: string): Promise<{ code: number; height: number; rawLog: string; gasUsed: bigint } | undefined>;
}

/** A ChallengeTransport over one kept-open RPC connection plus REST for the account. */
export async function rpcTransport(ep: ChainEndpoints): Promise<ChallengeTransport> {
  const client = await StargateClient.connect(ep.rpc);
  return {
    async account(address) {
      const r = await fetch(`${ep.rest}/cosmos/auth/v1beta1/accounts/${address}`);
      if (!r.ok) throw new Error(`watchtower account ${address} not found on chain (HTTP ${r.status})`);
      const { account } = (await r.json()) as { account: { account_number: string; sequence: string } };
      return { accountNumber: BigInt(account.account_number), sequence: BigInt(account.sequence) };
    },
    broadcastSync: (tx) => client.broadcastTxSync(tx),
    async result(hash) {
      const t = await client.getTx(hash);
      return t ? { code: t.code, height: t.height, rawLog: t.rawLog, gasUsed: t.gasUsed } : undefined;
    },
  };
}

export interface ChallengerOptions {
  /** uqor per unit of gas. Default 0.3: twice the 0.15 the winning challenge paid in drill 1 (19 Nov). */
  gasPrice?: number;
}

/** Code the chain answers when a tx runs out of gas. */
export const OUT_OF_GAS = 11;
/** Cosmos SDK "account sequence mismatch". */
const WRONG_SEQUENCE = 32;
/** A broadcast that has not returned after this long is abandoned, so it cannot block the send lane. */
const BROADCAST_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * A challenger that is ready before fraud happens: the account number and
 * sequence, the hybrid sign-bytes form and the RPC connection are fetched once,
 * so a challenge is signed locally and handed to the node with a single
 * broadcast that returns after CheckTx (it does not wait for a block).
 */
export class Challenger {
  readonly address: string;
  private readonly signer: EthNativeSigner;
  private accountNumber = 0n;
  private sequence = 0n;
  private signBytesVersion?: Awaited<ReturnType<EthNativeSigner["resolveSignBytesVersion"]>>;
  readonly gasPrice: number;
  /** Sends run one at a time, so a challenge and an inbox post never race for a sequence number. */
  private lane: Promise<unknown> = Promise.resolve();
  private readonly rest: string | undefined;

  constructor(
    account: UnifiedAccount,
    private readonly chainId: string,
    private readonly transport: ChallengeTransport,
    opts: ChallengerOptions & { rest?: string; signBytesVersion?: "v1" | "v2" } = {},
  ) {
    this.address = account.cosmos;
    // The RDK registry: the SDK's default one cannot encode MsgPostRollupData (exit attestations).
    this.signer = new EthNativeSigner(account, { registry: createRdkRegistry(), ...(opts.rest && { rest: opts.rest }) });
    this.gasPrice = opts.gasPrice ?? 0.3;
    this.rest = opts.rest;
    if (opts.signBytesVersion) this.signBytesVersion = opts.signBytesVersion;
  }

  /** Fetch the account and the sign-bytes form. Call once at start-up. */
  async ready(): Promise<void> {
    this.signBytesVersion ??= await this.signer.resolveSignBytesVersion(this.chainId);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const a = await this.transport.account(this.address);
    this.accountNumber = a.accountNumber;
    this.sequence = a.sequence;
  }

  /**
   * Gas for a challenge. Calibrated on drill 1: a one-entry challenge with a
   * 149-byte proof used 343,412 gas. A proof grows with the batch's payloads
   * (about 139 KB for 41 vigil-1 entries), and the chain re-executes every entry.
   */
  static gasFor(proofBytes: number, entries: number, factor = 1): number {
    return Math.min(Math.ceil((500_000 + 40 * proofBytes + 100_000 * entries) * factor), 50_000_000);
  }

  /**
   * Sign and broadcast one challenge. Resolves once the node has accepted it into its mempool. The gas
   * is the calibrated estimate unless `gas` is given (e.g. from `simulateChallenge` after running out).
   */
  async send(rollupId: string, challenge: Challenge, entries: number, opts: { factor?: number; gas?: number } = {}): Promise<{ hash: string; gas: number; feeUqor: number }> {
    if (!challenge.wins) throw new Error(`refusing to send a challenge for batch ${challenge.batchIndex} that checkQledgerFraud rejects`);
    const gas = opts.gas ?? Challenger.gasFor(challenge.proof.length, entries, opts.factor ?? 1);
    const msg = challengeBatchMsg({ challenger: this.address, rollupId, batchIndex: challenge.batchIndex, proof: challenge.proof });
    return this.broadcast(msg, gas, `vigil watchtower: challenge ${rollupId} batch ${challenge.batchIndex}`);
  }

  /**
   * The gas the chain actually needs for this challenge: the real signed transaction, dry-run with the
   * node's simulate endpoint (spends nothing). Undefined if the node cannot simulate it. Used after an
   * out-of-gas failure instead of guessing, because a failed delivery still pays its whole fee.
   */
  async simulateChallenge(rollupId: string, challenge: Challenge): Promise<number | undefined> {
    if (!this.rest) return undefined;
    if (!this.signBytesVersion) await this.ready();
    const msg = challengeBatchMsg({ challenger: this.address, rollupId, batchIndex: challenge.batchIndex, proof: challenge.proof });
    const tx = this.signer.sign({
      chainId: this.chainId,
      accountNumber: this.accountNumber,
      sequence: this.sequence,
      messages: [msg],
      fee: { amount: [{ denom: "uqor", amount: "1000" }], gas: "50000000" },
      memo: "simulate",
      signBytesVersion: this.signBytesVersion!,
    }).txRawBytes;
    const r = await withTimeout(
      fetch(`${this.rest}/cosmos/tx/v1beta1/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_bytes: Buffer.from(tx).toString("base64") }),
      }),
      BROADCAST_TIMEOUT_MS,
      "simulate",
    );
    const j = (await r.json()) as { gas_info?: { gas_used?: string } };
    const used = Number(j.gas_info?.gas_used ?? NaN);
    return Number.isFinite(used) && used > 0 ? used : undefined;
  }

  /** Gas for posting `bytes` of data to a rollup inbox (a 3,783-byte post used 349,859 gas on 23 Nov 2026). */
  static gasForPost(bytes: number, factor = 1): number {
    return Math.ceil((250_000 + 45 * bytes) * factor);
  }

  /** Post `data` into a rollup's inbox, hybrid-signed. Resolves once the node has accepted it into its mempool. */
  async post(rollupId: string, data: Uint8Array, memo: string, factor = 1): Promise<{ hash: string; gas: number; feeUqor: number }> {
    return this.broadcast(postRollupDataMsg({ poster: this.address, rollupId, data }), Challenger.gasForPost(data.length, factor), memo);
  }

  private broadcast(msg: ReturnType<typeof challengeBatchMsg>, gas: number, memo: string): Promise<{ hash: string; gas: number; feeUqor: number }> {
    const run = this.lane.then(async () => {
      if (!this.signBytesVersion) await this.ready();
      const feeUqor = Math.ceil(gas * this.gasPrice);
      const build = () =>
        this.signer.sign({
          chainId: this.chainId,
          accountNumber: this.accountNumber,
          sequence: this.sequence,
          messages: [msg],
          fee: { amount: [{ denom: "uqor", amount: String(feeUqor) }], gas: String(gas) },
          memo,
          signBytesVersion: this.signBytesVersion!,
        }).txRawBytes;
      let hash: string;
      try {
        hash = await withTimeout(this.transport.broadcastSync(build()), BROADCAST_TIMEOUT_MS, "broadcast");
      } catch (e) {
        if ((e as { code?: number }).code !== WRONG_SEQUENCE) {
          // The node may or may not have taken it; re-read the sequence before the next send.
          await this.refresh().catch(() => undefined);
          throw e;
        }
        await this.refresh();
        hash = await withTimeout(this.transport.broadcastSync(build()), BROADCAST_TIMEOUT_MS, "broadcast");
      }
      this.sequence += 1n;
      return { hash, gas, feeUqor };
    });
    this.lane = run.catch(() => undefined);
    return run;
  }

  /** Wait for a sent challenge to land in a block (undefined if it has not after `timeoutMs`). */
  async outcome(hash: string, timeoutMs = 60_000, pollMs = 1_000): Promise<{ code: number; height: number; rawLog: string; gasUsed: bigint } | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.transport.result(hash).catch(() => undefined);
      if (r) {
        // A tx that failed in delivery still consumed its sequence; one refused at CheckTx never got here.
        return r;
      }
      await new Promise((res) => setTimeout(res, pollMs));
    }
    await this.refresh().catch(() => undefined);
    return undefined;
  }
}

/** One-off challenge (opens and closes its own connection). Kept for scripts; the watchtower uses Challenger. */
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
