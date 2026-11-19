/** Reading a rollup's inbox: posts with their payloads, payments, and the batch that settles each. */
import {
  EMPTY_INBOX_ACC,
  QLEDGER_KIND_TRANSFER,
  bytesToHex,
  decodeQledgerTx,
  fetchQledgerEntries,
  postedDataHash,
  qledgerAccountId,
  verifyQledgerTx,
  type BatchView,
  type RestClient,
} from "@qorechain/rdk";

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

export interface InboxPost {
  sequence: number;
  height: number;
  poster: string;
  payload: Uint8Array;
  /** SHA-256 of the payload, hex (the entry's data_hash on chain). */
  dataHash: string;
}

/** Every post after `from`, with its payload, checked against the chain's accumulator. */
export async function readInbox(rest: RestClient, env: { chainId: string; rollupId: string }, from = 0): Promise<InboxPost[]> {
  const inbox = await rest.getInbox(env.rollupId);
  if (inbox.headSequence <= from) return [];
  const accFrom = from === 0 ? EMPTY_INBOX_ACC : (await rest.getPostedData(env.rollupId, from)).inboxAcc;
  const entries = await fetchQledgerEntries(rest, { ...env, from, to: inbox.headSequence, accFrom });
  return entries.map((e, i) => ({
    sequence: from + 1 + i,
    height: Number(e.height),
    poster: e.poster,
    payload: e.payload,
    dataHash: hex(postedDataHash(e.payload)),
  }));
}

/** The transfer a post carries, if it is a validly signed qledger transfer. */
export function transferOf(
  payload: Uint8Array,
  env: { chainId: string; rollupId: string },
): { fromAccount: string; toAccount: string; amountUqor: string; nonce: string } | undefined {
  const tx = decodeQledgerTx(payload);
  if (!tx || tx.kind !== QLEDGER_KIND_TRANSFER || !tx.to || !verifyQledgerTx(tx, env.chainId, env.rollupId)) return undefined;
  return {
    fromAccount: hex(qledgerAccountId(tx.publicKey, tx.scheme)),
    toAccount: hex(tx.to),
    amountUqor: tx.amount.toString(),
    nonce: tx.nonce.toString(),
  };
}

/** The settled batch whose range holds inbox entry `sequence`, if any yet. */
export function batchHolding(batches: BatchView[], sequence: number): BatchView | undefined {
  return batches.find((b) => b.status !== "rejected" && b.inboxStart < sequence && sequence <= b.inboxEnd);
}
