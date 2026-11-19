/**
 * Data receipts: proof that one inbox post (a sealed envelope, say) sits
 * inside a particular settled batch.
 *
 * A based batch commits to its inbox range through `data_hash`:
 *
 *   acc_n = SHA-256("qorechain/rdk/inbox/v1" | chain | rollup | acc_{n-1} | n | height | poster | SHA-256(data))
 *   data_hash = SHA-256("qorechain/rdk/inbox-range/v1" | chain | rollup | from | to | acc_from | acc_to)
 *
 * The receipt carries `acc_from` and, for every post in the range, its
 * sequence, height, poster and payload hash, never the payloads themselves.
 * Re-folding them with the RDK's `inboxAccumulate` and `inboxRangeHash` must
 * give the batch's `data_hash`, and the proven post must be in the range with
 * the payload's SHA-256. The fold binds `acc_from` too, so no field can change
 * without breaking it.
 *
 * What this proves, and what it leaves to the chain:
 * - Offline (`verifyDataReceipt`): the post is entry `sequence` of the range
 *   that hashes to `batch.dataHash`.
 * - Live (`checkDataReceiptOnChain`): the chain's batch `batchIndex` carries
 *   that `data_hash` and that range, and is finalized. The chain computed the
 *   range commitment from its own accumulator when it accepted the batch.
 *   The batch's ML-DSA-87 anchor (its settlement receipt) signs the state
 *   root, not `data_hash`, so `data_hash` is trusted through chain state.
 */
import {
  EMPTY_INBOX_ACC,
  bytesToHex,
  inboxAccumulate,
  inboxRangeHash,
  isRestNotFound,
  postedDataHash,
  type RestClient,
} from "@qorechain/rdk";

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();
const norm = (h: string): string => h.replace(/^0x/, "").toLowerCase();

export interface ReceiptPost {
  sequence: number;
  height: number;
  poster: string;
  /** SHA-256 of the payload, hex. */
  dataHash: string;
}

export interface DataReceipt {
  version: 1;
  kind: "vigil/data-receipt";
  chainId: string;
  rollupId: string;
  /** The inbox entry this receipt proves. */
  sequence: number;
  /** SHA-256 of that entry's payload, hex. */
  dataHash: string;
  batch: {
    batchIndex: number;
    inboxStart: number;
    inboxEnd: number;
    /** The batch's inbox range commitment. */
    dataHash: string;
    stateRoot: string;
    status: string;
  };
  /** The inbox accumulator after `batch.inboxStart` (32 zero bytes at 0). */
  accFrom: string;
  /** Every post in (inboxStart, inboxEnd], in order. */
  posts: ReceiptPost[];
  builtAt: string;
}

export interface DataReceiptCheck {
  valid: boolean;
  checks: {
    /** The posts are exactly inboxStart+1 … inboxEnd, in order. */
    rangeComplete: boolean;
    /** The proven sequence is in the range with the receipt's payload hash. */
    postInRange: boolean;
    /** Re-folding the posts gives the batch's data_hash. */
    dataHashMatches: boolean;
    /** The payload given hashes to the receipt's dataHash (undefined if no payload was given). */
    payloadMatches?: boolean;
  };
}

/** Assemble a receipt from the range's posts (from REST, recorded data, anything). */
export function dataReceiptFrom(input: Omit<DataReceipt, "version" | "kind" | "dataHash" | "builtAt"> & { builtAt?: string }): DataReceipt {
  const post = input.posts.find((p) => p.sequence === input.sequence);
  if (!post) throw new Error(`inbox entry ${input.sequence} is not in batch ${input.batch.batchIndex} (entries ${input.batch.inboxStart + 1}-${input.batch.inboxEnd})`);
  return {
    version: 1,
    kind: "vigil/data-receipt",
    chainId: input.chainId,
    rollupId: input.rollupId,
    sequence: input.sequence,
    dataHash: norm(post.dataHash),
    batch: { ...input.batch, dataHash: norm(input.batch.dataHash), stateRoot: norm(input.batch.stateRoot) },
    accFrom: norm(input.accFrom),
    posts: input.posts.map((p) => ({ ...p, dataHash: norm(p.dataHash) })),
    builtAt: input.builtAt ?? new Date().toISOString(),
  };
}

/** Check a receipt with no network: the fold, the range, and optionally the payload. */
export function verifyDataReceipt(r: DataReceipt, payload?: Uint8Array): DataReceiptCheck {
  const { chainId, rollupId, batch } = r;
  const rangeComplete =
    r.posts.length === batch.inboxEnd - batch.inboxStart && r.posts.every((p, i) => p.sequence === batch.inboxStart + 1 + i);
  const target = r.posts.find((p) => p.sequence === r.sequence);
  const postInRange = !!target && norm(target.dataHash) === norm(r.dataHash);
  let dataHashMatches = false;
  if (rangeComplete) {
    let acc: Uint8Array | string = r.accFrom;
    for (const p of r.posts) {
      acc = inboxAccumulate({ chainId, rollupId, prevAcc: acc, sequence: p.sequence, height: p.height, poster: p.poster, dataHash: p.dataHash });
    }
    const range = inboxRangeHash({ chainId, rollupId, from: batch.inboxStart, to: batch.inboxEnd, accFrom: r.accFrom, accTo: acc });
    dataHashMatches = hex(range) === norm(batch.dataHash);
  }
  const payloadMatches = payload === undefined ? undefined : hex(postedDataHash(payload)) === norm(r.dataHash);
  return {
    valid: rangeComplete && postInRange && dataHashMatches && payloadMatches !== false,
    checks: { rangeComplete, postInRange, dataHashMatches, ...(payloadMatches !== undefined && { payloadMatches }) },
  };
}

/** Build the receipt for inbox entry `sequence` from the chain. */
export async function buildDataReceipt(rest: RestClient, env: { chainId: string; rollupId: string }, sequence: number): Promise<DataReceipt> {
  const batches = (await rest.listBatches(env.rollupId)).filter((b) => b.status !== "rejected");
  const batch = batches.find((b) => b.inboxStart < sequence && sequence <= b.inboxEnd);
  if (!batch) throw new Error(`no settled batch of ${env.rollupId} covers inbox entry ${sequence} yet`);
  const accFrom = batch.inboxStart === 0 ? hex(EMPTY_INBOX_ACC) : (await rest.getPostedData(env.rollupId, batch.inboxStart)).inboxAcc;
  const posts: ReceiptPost[] = [];
  let acc: Uint8Array | string = accFrom;
  for (let s = batch.inboxStart + 1; s <= batch.inboxEnd; s++) {
    const d = await rest.getPostedData(env.rollupId, s);
    posts.push({ sequence: s, height: d.height, poster: d.poster, dataHash: d.dataHash });
    // Each step must land on the accumulator the chain stored for that post.
    acc = inboxAccumulate({ ...env, prevAcc: acc, sequence: s, height: d.height, poster: d.poster, dataHash: d.dataHash });
    if (hex(acc) !== norm(d.inboxAcc)) throw new Error(`inbox entry ${s}: the fold gives ${hex(acc)}, the chain stores ${norm(d.inboxAcc)}`);
  }
  return dataReceiptFrom({
    ...env,
    sequence,
    batch: {
      batchIndex: batch.batchIndex,
      inboxStart: batch.inboxStart,
      inboxEnd: batch.inboxEnd,
      dataHash: batch.dataHash,
      stateRoot: batch.stateRoot,
      status: batch.status,
    },
    accFrom,
    posts,
  });
}

/** Check a receipt's batch against the chain: same range, same data_hash, finalized. */
export async function checkDataReceiptOnChain(
  rest: RestClient,
  r: DataReceipt,
): Promise<{ onChain: boolean; finalized: boolean; detail: string }> {
  let b;
  try {
    b = await rest.getBatch(r.rollupId, r.batch.batchIndex);
  } catch (err) {
    if (isRestNotFound(err)) return { onChain: false, finalized: false, detail: `the chain has no batch ${r.batch.batchIndex}` };
    throw err;
  }
  const same =
    b.status !== "rejected" &&
    norm(b.dataHash) === norm(r.batch.dataHash) &&
    b.inboxStart === r.batch.inboxStart &&
    b.inboxEnd === r.batch.inboxEnd &&
    norm(b.stateRoot) === norm(r.batch.stateRoot);
  return {
    onChain: same,
    finalized: same && b.status === "finalized",
    detail: same ? `batch ${b.batchIndex} is ${b.status}` : `batch ${b.batchIndex} on chain differs (status ${b.status}, data_hash ${norm(b.dataHash).slice(0, 12)}…)`,
  };
}
