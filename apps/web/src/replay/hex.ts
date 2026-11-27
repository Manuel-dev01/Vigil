/** Byte values from the chain as lowercase hex, with the RDK's own decoder for whatever form the node used. */
import { bytesToHex, decodeWireBytes } from "@qorechain/rdk";

export const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

/** A bytes value from the chain (hex or base64, any case) as lowercase hex; "" for empty or missing. */
export const wireHex = (s: string | null | undefined): string => (s ? hex(decodeWireBytes(s.replace(/^0x/i, ""))) : "");
