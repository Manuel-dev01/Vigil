/**
 * The exit canary's decisions, as pure functions so each one is tested offline: which keys it refuses,
 * how much it may move, how often, and the two inbox posts it makes. main.ts does the reading and sending.
 *
 * A canary run is one small instant exit of its own money: an L2 withdrawal to exitAddressOf(its own L1
 * address), with a payout notice in the same transaction so the relayer knows whose exit address it is.
 * The watchtowers attest it, the relayer fronts it, and after finality executes it and sweeps the exit
 * address back to the vault. The money comes back to the canary's L1 account, less the vault's fee and
 * the post's gas.
 */
import { QledgerLedger, QLEDGER_KIND_WITHDRAW, decodeQledgerTx, encodeQledgerTx, executeQledger, signQledgerTx, verifyQledgerTx } from "@qorechain/rdk";
import { encodePayoutNotice } from "@vigil/qledger-watchtower";

/**
 * Every team key listed in the README's testnet addresses. The canary needs its own key: one it shares
 * with any of these would post as that role (the keep-alive, an operator, a watchtower, the relayer) or
 * spend its budget.
 */
export const REFUSED: Readonly<Record<string, string>> = {
  qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s: "the rollup creator and sequencer (Keel), the Q-Day Drill account and the vault's LP",
  qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft: "the standby sequencer (keel-b)",
  qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd: "watchtower-2",
  qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33: "watchtower-3",
  qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m: "watchtower-1 (retired)",
  qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l: "the keep-alive poster",
  qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn: "the exit relayer",
  qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6: "the EVM deployer",
  qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws: "employer-1 (sealed payroll demo)",
  qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv: "the first deployer (PQGuardVault)",
};

/** Smallest and largest canary exit: 0.01 QOR (the relayer's minimum exit) to 0.05 QOR. */
export const MIN_UQOR = 10_000n;
export const MAX_UQOR = 50_000n;
export const DEFAULT_UQOR = 20_000n;
/** At most this many canary exits in any 24 hours: each costs the watchtowers two attestation posts. */
export const MAX_PER_DAY = 2;

const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

/**
 * Why this key must not be the canary's, or undefined. `chain` is what the chain says now: the rollup's
 * creator, and the vault's quorum and LP (0x).
 */
export function refusal(account: { cosmos: string; evm: string }, chain: { creator: string; quorum: string[]; lp: string }): string | undefined {
  const role = REFUSED[account.cosmos];
  if (role) return `${account.cosmos} is ${role}; the canary needs a key of its own`;
  if (account.cosmos === chain.creator) return `${account.cosmos} is the rollup's creator`;
  if (chain.quorum.some((m) => norm(m) === norm(account.evm))) return `${account.evm} is a member of the vault's quorum`;
  if (norm(chain.lp) === norm(account.evm)) return `${account.evm} is the vault's LP`;
  return undefined;
}

/** A canary amount in QOR ("0.02") as uqor, within MIN_UQOR..MAX_UQOR. Throws otherwise. */
export function parseAmount(qor: string): bigint {
  if (!/^0\.\d{1,6}$/.test(qor)) throw new Error(`--amount must be QOR between 0.01 and 0.05 with at most 6 decimals, not "${qor}"`);
  const u = BigInt(qor.slice(2).padEnd(6, "0"));
  if (u < MIN_UQOR || u > MAX_UQOR) throw new Error(`--amount must be between 0.01 and 0.05 QOR, not ${qor}`);
  return u;
}

/**
 * Whether another run now would exceed MAX_PER_DAY: `postTimes` are the unix times of the canary's earlier
 * posts (one per run). Returns why, or undefined.
 */
export function tooSoon(postTimes: readonly number[], nowSec: number, maxPerDay = MAX_PER_DAY): string | undefined {
  const recent = postTimes.filter((t) => t > nowSec - 86_400);
  return recent.length >= maxPerDay ? `${recent.length} canary exits in the last 24 hours (at most ${maxPerDay})` : undefined;
}

export interface CanaryPlan {
  /** The payout notice: vigil/instant-exit/v1/payout | vault | payout. */
  notice: Uint8Array;
  /** The signed L2 withdrawal, as posted. */
  withdrawal: Uint8Array;
  /** The global withdrawal index it will have, from executing both posts on a copy of the ledger. */
  withdrawalIndex: bigint;
}

/**
 * The two posts of one run, checked on a copy of the ledger: the withdrawal must apply (nonce + 1) and pay
 * exactly `amount` to `exitAddress`. Throws if the rollup would skip it.
 */
export function planCanary(input: {
  env: { chainId: string; rollupId: string };
  ledger: QledgerLedger;
  l2: { publicKey: Uint8Array; secretKey: Uint8Array; accountId: Uint8Array };
  vault: string;
  payout: string;
  /** exitAddressOf(payout), qor1. */
  exitAddress: string;
  amount: bigint;
}): CanaryPlan {
  const { env, l2, amount } = input;
  if (amount < MIN_UQOR || amount > MAX_UQOR) throw new Error(`amount ${amount} uqor is outside ${MIN_UQOR}..${MAX_UQOR}`);
  const before = input.ledger.get(l2.accountId);
  const tx = signQledgerTx({ ...env, secretKey: l2.secretKey, publicKey: l2.publicKey, nonce: before.nonce, amount, recipient: input.exitAddress });
  if (!verifyQledgerTx(tx, env.chainId, env.rollupId)) throw new Error("the signed withdrawal does not verify");
  const withdrawal = encodeQledgerTx(tx);
  const decoded = decodeQledgerTx(withdrawal);
  if (!decoded || decoded.kind !== QLEDGER_KIND_WITHDRAW || decoded.recipient !== input.exitAddress || decoded.amount !== amount) {
    throw new Error("the encoded withdrawal does not read back as written");
  }
  const notice = encodePayoutNotice(input.vault, input.payout);
  const trial = input.ledger.clone();
  const r = executeQledger(env, trial, [
    { height: 0n, poster: "", payload: notice },
    { height: 0n, poster: "", payload: withdrawal },
  ]);
  const w = r.withdrawals.find((x) => x.recipient === input.exitAddress && x.amount === amount);
  if (trial.get(l2.accountId).nonce !== before.nonce + 1n || r.withdrawals.length !== 1 || !w) {
    throw new Error(`the rollup would skip this withdrawal (L2 balance ${before.balance} uqor, nonce ${before.nonce})`);
  }
  return { notice, withdrawal, withdrawalIndex: w.index };
}
