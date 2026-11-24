/** Matching an exit to the L1 payment of its withdrawal (MsgExecuteWithdrawal). */

export interface ExecutedLike {
  batchIndex: number;
  withdrawalIndex: number;
  /** The L1 recipient, qor1. */
  recipient: string;
  amount: bigint;
  /** The block the withdrawal was executed in. */
  height: number;
}

export interface ExitLike {
  batchIndex: number;
  withdrawalIndex: number;
  /** The exit address (the withdrawal's recipient), qor1, if known. */
  recipientQor1: string | undefined;
  amountUqor: bigint | undefined;
  /** The chain's batch at this index, as far as it was read. */
  batch: { status: string; sameRoot: boolean | undefined; submittedHeight: number | undefined } | undefined;
}

/**
 * The L1 payment of this exact withdrawal: same batch and index, and the same recipient and amount. An
 * index alone is not enough, because a rejected batch's index is reused by the next batch, so the chain's
 * batch at that index must also carry the attested root and have been submitted before the payment.
 */
export function matchExecuted<E extends ExecutedLike>(executed: readonly E[], x: ExitLike): E | undefined {
  const b = x.batch;
  if (b && (b.sameRoot === false || b.status === "rejected" || b.status === "replaced")) return undefined;
  return executed.find(
    (e) =>
      e.batchIndex === x.batchIndex &&
      e.withdrawalIndex === x.withdrawalIndex &&
      (x.recipientQor1 === undefined || e.recipient === x.recipientQor1) &&
      (x.amountUqor === undefined || e.amount === x.amountUqor) &&
      (b?.submittedHeight === undefined || e.height >= b.submittedHeight),
  );
}
