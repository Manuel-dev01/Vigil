/**
 * Whether a payslip's salary later left the rollup through an instant exit.
 *
 * The chain does not link a withdrawal to a salary, so the page matches them on the L2 account and the
 * amount: an instant exit (fronted by the vault) whose ML-DSA-44-signed withdrawal came from the account
 * the payslip paid, for the amount it paid, after the payment. If the same account was paid that amount
 * again before the withdrawal, the withdrawal is the later salary's, not this one's. No match, nothing shown.
 *
 * The inbox is already on the payslip page, so it says first whether any withdrawal could match; only
 * then does the page load the exits (exits.ts, which also reads the vault on the EVM endpoint), and only
 * those in the batches that hold such a withdrawal.
 */
import { QLEDGER_KIND_WITHDRAW, bytesToHex, decodeQledgerTx, qledgerAccountId } from "@qorechain/rdk";

export interface SalaryPayment {
  /** The inbox entry of the public transfer. */
  sequence: number;
  /** The L2 account paid, 64 hex. */
  toAccount: string;
  amountUqor: string;
}

/** An incoming transfer seen in the inbox (validly signed). */
export interface TransferSeen {
  sequence: number;
  toAccount: string;
  amountUqor: string;
}

export interface WithdrawalSeen {
  sequence: number;
  /** The withdrawing L2 account, 64 hex. */
  account: string;
  amount: bigint;
}

/** The parts of an exit (exits.ts ExitView) the match needs. */
export interface ExitSeen {
  id: string;
  batchIndex: number;
  withdrawal?: { entry: { sequence: number; time: number }; amount: bigint; account: string; signatureValid: boolean };
  /** The vault's Fronted event; its time in unix seconds (0 if the block time could not be read). */
  fronted?: { time: number };
}

export interface SalaryExit {
  exitId: string;
  batchIndex: number;
  withdrawalSequence: number;
  /** Seconds from the withdrawal's post to the vault paying it; undefined if either time is unknown. */
  seconds: number | undefined;
}

const lower = (h: string): string => h.toLowerCase();

/** Every withdrawal in the inbox, by account and amount (signatures are checked later, on a match). */
export function withdrawalsIn(posts: { sequence: number; payload: Uint8Array }[]): WithdrawalSeen[] {
  return posts.flatMap((p) => {
    try {
      const q = decodeQledgerTx(p.payload);
      return q && q.kind === QLEDGER_KIND_WITHDRAW ? [{ sequence: p.sequence, account: lower(bytesToHex(qledgerAccountId(q.publicKey, q.scheme))), amount: q.amount }] : [];
    } catch {
      return [];
    }
  });
}

/** The withdrawals in the inbox that could be this salary leaving: from the account paid, for the amount paid, after it. */
export const leavingWithdrawals = (payment: SalaryPayment, withdrawals: WithdrawalSeen[]): WithdrawalSeen[] =>
  withdrawals.filter((w) => w.sequence > payment.sequence && w.account === lower(payment.toAccount) && w.amount === BigInt(payment.amountUqor));

/** Whether any withdrawal in the inbox could be this salary leaving: worth loading the exits for. */
export const couldHaveLeft = (payment: SalaryPayment, withdrawals: WithdrawalSeen[]): boolean => leavingWithdrawals(payment, withdrawals).length > 0;

/** The instant exit this salary left through, if one matches. */
export function salaryExit(payment: SalaryPayment, transfers: TransferSeen[], exits: ExitSeen[]): SalaryExit | undefined {
  const account = lower(payment.toAccount);
  const amount = BigInt(payment.amountUqor);
  const sameSalary = (t: { toAccount: string; amountUqor: string }) => lower(t.toAccount) === account && BigInt(t.amountUqor) === amount;
  if (!transfers.some((t) => t.sequence === payment.sequence && sameSalary(t))) return undefined;
  const candidates = exits
    .flatMap((x) => {
      const w = x.withdrawal;
      return x.fronted && w && w.signatureValid && lower(w.account) === account && w.amount === amount && w.entry.sequence > payment.sequence ? [{ x, w, fronted: x.fronted }] : [];
    })
    .sort((a, b) => a.w.entry.sequence - b.w.entry.sequence);
  for (const { x, w, fronted } of candidates) {
    // The salary a withdrawal takes out is the latest payment of that amount to that account before it.
    const latest = transfers.filter((t) => sameSalary(t) && t.sequence < w.entry.sequence).reduce<TransferSeen | undefined>((a, t) => (!a || t.sequence > a.sequence ? t : a), undefined);
    if (latest?.sequence !== payment.sequence) continue;
    const seconds = fronted.time > 0 && w.entry.time > 0 && fronted.time >= w.entry.time ? fronted.time - w.entry.time : undefined;
    return { exitId: x.id, batchIndex: x.batchIndex, withdrawalSequence: w.entry.sequence, seconds };
  }
  return undefined;
}
