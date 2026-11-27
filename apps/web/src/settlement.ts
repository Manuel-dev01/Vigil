/**
 * Where a sealed envelope's data receipt stands, for the payslip page.
 *
 * The receipt is built from the inbox entries the page read (each from the transaction that posted it,
 * all together checked against the chain's inbox accumulator), so it does not need the chain's posted-data
 * records, which are pruned after 648,000 blocks. It is checked offline, then against the batch record as
 * the node reports it.
 *
 * "Could not check" is kept apart from "checked and failed": a node that times out or refuses a request,
 * or an inbox read that ends before the batch does, says nothing about the envelope. Only a receipt that
 * does not fold to the batch's data commitment, or a batch record that differs, is a failure.
 */
import { EMPTY_INBOX_ACC, bytesToHex, qledgerAccumulate, type BatchView, type RestClient } from "@qorechain/rdk";
import { checkDataReceiptOnChain, dataReceiptFrom, verifyDataReceipt } from "@vigil/sealed/data-receipt";
import type { InboxPost } from "@vigil/sealed/inbox";

export type Settlement =
  /** A batch record holds the entry; `valid` is the receipt rebuilt here, `onChain` the batch record against it. */
  | { kind: "receipt"; batch: BatchView; valid: boolean; onChain: boolean; finalized: boolean; detail: string }
  /** A batch holds the entry, but the page could not check it this time (the node did not answer, say). */
  | { kind: "unchecked"; batch: BatchView; detail: string }
  /** The inbox says the entry was consumed, but no batch record holding it is left (pruned). */
  | { kind: "record pruned"; consumed: number }
  /** Not consumed by any batch yet. */
  | { kind: "not batched" }
  | { kind: "checking" };

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);
const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

/** The data receipt of `post` in `batch`, rebuilt from `posts` (every inbox entry the page read). */
export async function settlementOf(
  rest: Pick<RestClient, "getBatch">,
  env: { chainId: string; rollupId: string },
  posts: InboxPost[],
  post: InboxPost,
  batch: BatchView,
): Promise<Settlement> {
  const unchecked = (detail: string): Settlement => ({ kind: "unchecked", batch, detail });
  // The inbox may have grown past what the page read: that is a read to redo, not a failed receipt.
  const read = posts.filter((p) => p.sequence <= batch.inboxEnd).length;
  if (read !== batch.inboxEnd) return unchecked(`The page read ${read} of the ${batch.inboxEnd} inbox entries up to the end of batch ${batch.batchIndex}`);

  let local: ReturnType<typeof verifyDataReceipt>;
  let receipt: ReturnType<typeof dataReceiptFrom>;
  try {
    const before = posts.filter((p) => p.sequence <= batch.inboxStart);
    const accFrom = hex(qledgerAccumulate({ ...env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: before.map((p) => ({ height: BigInt(p.height), poster: p.poster, payload: p.payload })) }));
    const range = posts.filter((p) => p.sequence > batch.inboxStart && p.sequence <= batch.inboxEnd);
    receipt = dataReceiptFrom({
      ...env,
      sequence: post.sequence,
      batch: { batchIndex: batch.batchIndex, inboxStart: batch.inboxStart, inboxEnd: batch.inboxEnd, dataHash: batch.dataHash, stateRoot: batch.stateRoot, status: batch.status },
      accFrom,
      posts: range.map((p) => ({ sequence: p.sequence, height: p.height, poster: p.poster, dataHash: p.dataHash })),
    });
    local = verifyDataReceipt(receipt, post.payload);
  } catch (e) {
    return unchecked(`The page could not build the data receipt for batch ${batch.batchIndex}: ${errText(e)}`);
  }
  if (!local.valid) {
    const failed = Object.entries(local.checks)
      .filter(([, ok]) => ok === false)
      .map(([k]) => k)
      .join(", ");
    return { kind: "receipt", batch, valid: false, onChain: false, finalized: false, detail: `The data receipt rebuilt here does not fold to batch ${batch.batchIndex}'s data commitment (${failed})` };
  }
  try {
    return { kind: "receipt", batch, valid: true, ...(await checkDataReceiptOnChain(rest as RestClient, receipt)) };
  } catch (e) {
    return unchecked(`Could not read batch ${batch.batchIndex} from the node: ${errText(e)}`);
  }
}
