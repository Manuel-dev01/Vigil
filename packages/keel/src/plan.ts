/**
 * Plan the next qledger-v1 batch: RDK 0.9.0's `planQledgerBatch`, step for
 * step, except that the inbox entries come from the `InboxReader` (by sequence,
 * checked against the chain's accumulator, archived) instead of the node's
 * transaction search, which reads every post the rollup ever had and stops at
 * 5,000. The admission rules are the RDK's own (`chooseQledgerBatchEnd`,
 * `qledgerBatchErrors`), and the entries must hash to the chain's inbox range
 * commitment for the batch before anything is executed.
 */
import {
  bytesToHex,
  chooseQledgerBatchEnd,
  executeQledger,
  hexToBytes,
  inboxRangeHash,
  isRestNotFound,
  qledgerAccumulate,
  qledgerBatchErrors,
  qledgerEmptyRoot,
  type BatchView,
  type QledgerBatchPlan,
  type QledgerLedger,
  type RestClient,
} from "@qorechain/rdk";
import type { InboxReader } from "@vigil/core/inbox";

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

/** The chain reads planning needs (a `RestClient` serves them; tests serve recorded data). */
export type PlanRest = Pick<RestClient, "getRollup" | "getParams" | "getSubmitterBond" | "getInbox" | "getPostedData" | "getLatestHeight" | "getLatestBatch">;

export async function planBatch(
  rest: PlanRest,
  reader: InboxReader,
  input: {
    chainId: string;
    rollupId: string;
    submitter: string;
    /** The state after the rollup's latest batch (an empty ledger before the first). */
    ledger: QledgerLedger;
    /** Blocks added to the current height for the 20-block rule (default 5). */
    inclusionMargin?: number;
  },
): Promise<QledgerBatchPlan> {
  const { chainId, rollupId } = input;
  const [rollup, params, bond, inbox] = await Promise.all([
    rest.getRollup(rollupId),
    rest.getParams(),
    rest.getSubmitterBond(rollupId, input.submitter),
    rest.getInbox(rollupId),
  ]);
  if (rollup.executionVm !== "qledger-v1") throw new Error(`rollup ${rollupId} is not a qledger-v1 rollup`);
  const consumed = BigInt(inbox.consumedSequence);
  const head = BigInt(inbox.headSequence);
  const retained = async (x: bigint) => x === head || (await rest.getInbox(rollupId, x)).rangeDataHash !== "";
  const end = await chooseQledgerBatchEnd({ consumed, head, retained });
  if (end === undefined) throw new Error(`rollup ${rollupId} has nothing to settle: its inbox is fully consumed`);
  let nextRetained: boolean | undefined;
  let nextHeight: number | undefined;
  if (end < head) {
    try {
      nextHeight = (await rest.getPostedData(rollupId, end + 1n)).height;
      nextRetained = true;
    } catch (err) {
      if (!isRestNotFound(err)) throw err;
      nextRetained = false;
    }
  }
  const inclusionHeight = (await rest.getLatestHeight()) + (input.inclusionMargin ?? 5);
  const errors = qledgerBatchErrors({
    consumed,
    head,
    end,
    bond: bond.amount,
    minBond: params.minSubmitterBond ?? "1000000000",
    pending: bond.pending,
    endRetained: await retained(end),
    ...(nextRetained !== undefined && { nextRetained }),
    ...(nextHeight !== undefined && { nextHeight }),
    inclusionHeight,
  });
  if (errors.length > 0) throw new Error(`no qledger-v1 batch can be admitted now: ${errors.join("; ")}`);

  const range = await rest.getInbox(rollupId, end);
  const entries = await reader.entries(Number(consumed), Number(end));
  const accFrom = hexToBytes(norm(inbox.consumedAcc));
  const accTo = qledgerAccumulate({ chainId, rollupId, from: consumed, accFrom, entries });
  const dataHash = inboxRangeHash({ chainId, rollupId, from: consumed, to: end, accFrom, accTo });
  if (range.rangeDataHash && hex(dataHash) !== norm(range.rangeDataHash)) {
    throw new Error("qledger: the fetched entries do not hash to the chain's inbox range commitment");
  }

  let latest: BatchView | undefined;
  try {
    latest = await rest.getLatestBatch(rollupId);
  } catch (err) {
    if (!isRestNotFound(err)) throw err;
  }
  const prevStateRoot = latest ? hexToBytes(norm(latest.stateRoot)) : qledgerEmptyRoot();
  if (hex(input.ledger.root()) !== hex(prevStateRoot)) {
    throw new Error(`qledger: the ledger you passed has root ${hex(input.ledger.root())}, but the rollup's latest state root is ${hex(prevStateRoot)}`);
  }
  const ledger = input.ledger.clone();
  const result = executeQledger({ chainId, rollupId }, ledger, entries);
  return {
    input: {
      rollupId,
      batchIndex: latest ? BigInt(latest.batchIndex) + 1n : 0n,
      prevStateRoot,
      stateRoot: result.stateRoot,
      txCount: BigInt(entries.length),
      dataHash,
      withdrawalsRoot: result.withdrawalsRoot,
      inboxEnd: end,
    },
    entries,
    result,
    ledger,
  };
}
