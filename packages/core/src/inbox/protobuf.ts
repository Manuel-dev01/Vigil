/**
 * Just enough protobuf to find a posted payload inside the transactions of a
 * block without knowing their message types.
 *
 * The chain commits to every post by the SHA-256 of its payload, so any bytes
 * field in the block that has the committed size and hashes to the committed
 * data hash is the payload, whichever message carried it: a top-level
 * `MsgPostRollupData`, or one sent inside another message (an `Any` inside a
 * wrapper's message list, say). Each transaction is decoded field by field and
 * every length-delimited field is both checked and, when it parses as a
 * message, decoded in turn, down to `MAX_DEPTH` levels.
 */
import { bytesToHex, postedDataHash } from "@qorechain/rdk";

/** TxRaw → body → Any → message is 4 levels; this leaves room for several wrappers. */
const MAX_DEPTH = 16;

/** A varint at `i`: [value, next offset], or undefined if it runs off the end or past 64 bits. */
function varint(buf: Uint8Array, i: number): [number, number] | undefined {
  let value = 0;
  let scale = 1;
  for (let n = 0; n < 10; n++) {
    if (i >= buf.length) return undefined;
    const b = buf[i++]!;
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return [value, i];
    scale *= 128;
  }
  return undefined;
}

/**
 * The length-delimited fields of `buf` read as one protobuf message, in order,
 * or undefined if `buf` is not a well-formed message (groups, unknown wire
 * types, field 0, or a length that runs past the end).
 */
export function lengthDelimitedFields(buf: Uint8Array): Uint8Array[] | undefined {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < buf.length) {
    const key = varint(buf, i);
    if (!key) return undefined;
    i = key[1];
    const field = Math.floor(key[0] / 8);
    const wire = key[0] % 8;
    if (field === 0) return undefined;
    if (wire === 0) {
      const v = varint(buf, i);
      if (!v) return undefined;
      i = v[1];
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 2) {
      const len = varint(buf, i);
      if (!len || len[1] + len[0] > buf.length) return undefined;
      out.push(buf.subarray(len[1], len[1] + len[0]));
      i = len[1] + len[0];
    } else {
      return undefined;
    }
    if (i > buf.length) return undefined;
  }
  return out;
}

/**
 * The bytes, anywhere inside `txs` (raw transactions), whose SHA-256 is
 * `dataHash` (hex) and whose length is `size` (when given). A copy, or
 * undefined if no field matches.
 */
export function findPayload(txs: Uint8Array[], dataHash: string, size?: number): Uint8Array | undefined {
  const want = dataHash.toLowerCase().replace(/^0x/, "");
  const visit = (buf: Uint8Array, depth: number): Uint8Array | undefined => {
    const fields = lengthDelimitedFields(buf);
    if (!fields) return undefined;
    for (const f of fields) {
      if ((size === undefined || f.length === size) && bytesToHex(postedDataHash(f)).toLowerCase() === want) return f;
      if (depth < MAX_DEPTH && f.length > 1) {
        const inner = visit(f, depth + 1);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  for (const tx of txs) {
    const hit = visit(tx, 0);
    if (hit) return hit.slice();
  }
  return undefined;
}
