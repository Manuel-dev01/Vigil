/** Reading a rollup's inbox: posts with their payloads, payments, and the batch that settles each. */
import {
  QLEDGER_KIND_TRANSFER,
  bytesToHex,
  decodeQledgerTx,
  hexToBytes,
  postedDataHash,
  qledgerAccountId,
  verifyQledgerTx,
  type BatchView,
  type RestClient,
} from "@qorechain/rdk";
import { openInboxReader, type InboxReader } from "@vigil/core/inbox";

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

export interface InboxPost {
  sequence: number;
  height: number;
  poster: string;
  payload: Uint8Array;
  /** SHA-256 of the payload, hex (the entry's data_hash on chain). */
  dataHash: string;
}

/**
 * Every post after `from`, with its payload, checked against the chain's
 * accumulator (read by sequence; entries the chain has pruned come from the
 * committed archive, data/inbox/<rollup>.jsonl, see @vigil/core/inbox).
 */
export async function readInbox(
  rest: RestClient,
  env: { chainId: string; rollupId: string },
  from = 0,
  reader: InboxReader = openInboxReader(env),
): Promise<InboxPost[]> {
  const inbox = await rest.getInbox(env.rollupId);
  if (inbox.headSequence <= from) return [];
  const entries = await reader.read(from, inbox.headSequence);
  return entries.map((e) => {
    const payload = hexToBytes(e.payloadHex);
    return { sequence: e.sequence, height: e.height, poster: e.poster, payload, dataHash: hex(postedDataHash(payload)) };
  });
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
