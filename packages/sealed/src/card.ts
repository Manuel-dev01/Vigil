/**
 * Recipient cards: an account's public statement of its seal keys.
 *
 * QoreSeal's hybrid mode needs each recipient's X25519 key next to the
 * ML-KEM-1024 key the chain's KEM registry holds. The card binds the two: it
 * carries the X25519 key and the SHA3-256 of the ML-KEM key, signed by the
 * account's secp256k1 key and its registered ML-DSA-87 key. Senders check a
 * card against the chain (`resolveRecipient`: the registered ML-DSA-87 key and
 * the registered ML-KEM key) before sealing to it. Cards are public and live in
 * the repository under `cards/<qor1…>.json`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signRecipientCard, type RecipientCard, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";
import { resolveRecipient } from "@qorechain/qoreseal/network";
import type { UnifiedAccount } from "@qorechain/sdk";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

export function signCard(account: UnifiedAccount, keys: SealKeyPair, chainId: string, issuedAt?: Date): RecipientCard {
  return signRecipientCard({
    chainId,
    address: account.cosmos,
    keys,
    classicalKey: { type: "eth_secp256k1", privateKey: bytes(account.privateKey), publicKey: bytes(account.publicKey) },
    pqKey: { secretKey: account.pqc.secretKey },
    ...(issuedAt && { issuedAt }),
  });
}

export const cardPath = (repoRoot: string, address: string): string => resolve(repoRoot, "cards", `${address}.json`);

export function loadCard(path: string): RecipientCard {
  return JSON.parse(readFileSync(path, "utf8")) as RecipientCard;
}

/**
 * The sealing key of `address`, after checking its card against the chain: the
 * card's signatures against the account's registered ML-DSA-87 key, and its
 * ML-KEM fingerprint against the account's registered KEM key.
 */
export function recipientFromChain(rest: string, chainId: string, address: string, card: RecipientCard): Promise<SealRecipient> {
  return resolveRecipient({ rest, chainId, address, card, mode: "hybrid" });
}
