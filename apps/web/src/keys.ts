/** The ML-DSA-87 keys the page pins (config.ts), and how a key read from the chain compares. */
import { sha256 } from "viem";
import { PINNED_KEYS } from "./config.ts";

export type PinStatus = "match" | "mismatch" | "unpinned";

export interface KeyPin {
  status: PinStatus;
  /** SHA-256 of the key as read, hex. */
  sha256: string;
  /** The pinned SHA-256, if this account has one. */
  pinned: string | undefined;
}

const bytesOf = (k: Uint8Array | string): Uint8Array => {
  if (typeof k !== "string") return k;
  const s = k.replace(/^0x/i, "");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};

/** Compare the key the chain reports for `qor1` (bytes or hex) with the one pinned in this page. */
export function keyPin(qor1: string, key: Uint8Array | string): KeyPin {
  const digest = sha256(bytesOf(key)).slice(2);
  const pinned = PINNED_KEYS[qor1];
  return { status: pinned === undefined ? "unpinned" : pinned === digest ? "match" : "mismatch", sha256: digest, pinned };
}
