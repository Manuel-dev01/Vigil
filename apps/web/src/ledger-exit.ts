/**
 * One exit card's data (exits.ts) as a ledger entry (ledger.ts): the same times the race draws for the
 * latest exit, plus the gas front() used. Type imports only, so it is tested without a chain.
 */
import type { ExitView } from "./exits.ts";
import type { LedgerExit } from "./ledger.ts";

/** 1 uqor is 10^12 wei of the same balance on the EVM side (exits.ts WEI_PER_UQOR). */
const WEI_PER_UQOR = 1_000_000_000_000n;

/** The ledger's view of one exit, or undefined if it was not fronted (or could not be read). A time of 0 means "not read". */
export function ledgerExitOf(x: ExitView): LedgerExit | undefined {
  const f = x.fronted;
  if (!f || x.error) return undefined;
  return {
    id: x.id,
    batchIndex: x.batchIndex,
    withdrawalIndex: x.withdrawalIndex,
    amountUqor: x.claim?.amountUqor ?? (f.paid + f.fee) / WEI_PER_UQOR,
    postedAt: x.withdrawal?.entry.time || undefined,
    batchAt: x.batch?.submittedTime || undefined,
    finalFrom: x.batch?.finalFrom || undefined,
    paidAt: f.time || undefined,
    repaidAt: x.repayment?.completedBy?.time || undefined,
    paidWei: f.paid,
    feeWei: f.fee,
    frontGas: f.gasUsed,
    frontTx: f.tx,
    batchStatus: x.batch?.status,
  };
}
