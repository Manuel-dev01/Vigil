/**
 * Instant exits: what a watchtower signs so an InstantExitVault
 * (contracts/src/InstantExitVault.sol) can pay a withdrawal before its batch is final.
 *
 * After the watchtower has re-executed a batch from an honest parent and found it valid, it signs one
 * exit message per withdrawal in the batch with its ML-DSA-87 key, and posts the signatures into the
 * rollup's inbox as one payload. The inbox is the public message bus: no server, and no EVM window on
 * the watchtower's key. Anyone (the user, a relayer) reads the payloads back and calls the vault's
 * `front` with a threshold of them. qledger-v1 execution treats the payload as a no-op entry.
 *
 * The exit message must match InstantExitVault.exitMessage byte for byte:
 *   "vigil/instant-exit/v1/exit" | u64be evmChainId | vault (20) | u64be len | chainId | u64be len | rollupId
 *   | u64be batchIndex | stateRoot (32) | u64be withdrawalIndex | u64be amountUqor | recipient (20) | u64be deadline
 * `recipient` is the withdrawal's recipient as the batch records it. Only a withdrawal to
 * `exitAddressOf(payout)` of that vault can be fronted, so signing every withdrawal of a valid batch is safe.
 */
import { bech32ToHex, bytesToHex, hexToBytes } from "@qorechain/rdk";
import { pqcSign, pqcVerify } from "@qorechain/sdk";

export const EXIT_DOMAIN = "vigil/instant-exit/v1/exit";
export const ATTEST_MAGIC = "vigil/instant-exit/v1/attest";
export const ML_DSA_87_SIG_LEN = 4627;

export interface ExitTarget {
  /** EVM chain id (9800 on qorechain-diana). */
  evmChainId: number;
  /** The InstantExitVault address, 0x-prefixed. */
  vault: string;
  chainId: string;
  rollupId: string;
}

export interface ExitClaim {
  batchIndex: number;
  /** The batch's state root, 64 hex. */
  stateRoot: string;
  withdrawalIndex: number;
  amountUqor: bigint;
  /** The withdrawal's recipient, 20 bytes as 40 hex (no 0x). */
  recipient: string;
  /** Unix seconds after which the vault refuses to front it. */
  deadline: number;
}

export interface SignedClaim {
  claim: ExitClaim;
  signature: Uint8Array;
}

export interface Attestation {
  vault: string;
  /** The signing member's 20-byte address, 40 hex. */
  member: string;
  claims: SignedClaim[];
}

const enc = new TextEncoder();
const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

function u64(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}

function fixedHex(h: string, bytes: number, what: string): Uint8Array {
  const s = norm(h);
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s)) throw new Error(`${what} must be ${bytes} bytes of hex`);
  return hexToBytes(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The 20-byte recipient (40 hex) of a canonical qor1 address. */
export function recipientBytes(qor1: string): string {
  return norm(bech32ToHex(qor1));
}

/** The bytes a quorum member signs for `c`; equal to InstantExitVault.exitMessage. */
export function exitMessage(t: ExitTarget, c: ExitClaim): Uint8Array {
  const chain = enc.encode(t.chainId);
  const rollup = enc.encode(t.rollupId);
  return concat([
    enc.encode(EXIT_DOMAIN),
    u64(t.evmChainId),
    fixedHex(t.vault, 20, "vault"),
    u64(chain.length),
    chain,
    u64(rollup.length),
    rollup,
    u64(c.batchIndex),
    fixedHex(c.stateRoot, 32, "stateRoot"),
    u64(c.withdrawalIndex),
    u64(c.amountUqor),
    fixedHex(c.recipient, 20, "recipient"),
    u64(c.deadline),
  ]);
}

/** Sign every claim with an ML-DSA-87 secret key. */
export function signClaims(t: ExitTarget, secretKey: Uint8Array, claims: ExitClaim[]): SignedClaim[] {
  return claims.map((claim) => ({ claim, signature: pqcSign(secretKey, exitMessage(t, claim)) }));
}

/** Check one signed claim against a member's ML-DSA-87 public key (hex). */
export function verifyClaim(t: ExitTarget, publicKeyHex: string, s: SignedClaim): boolean {
  try {
    return pqcVerify(hexToBytes(norm(publicKeyHex)), exitMessage(t, s.claim), s.signature);
  } catch {
    return false;
  }
}

/**
 * The inbox payload carrying one member's signatures:
 *   ATTEST_MAGIC | vault (20) | member (20) | u16be n | n × (u64 batchIndex | stateRoot 32 | u64 withdrawalIndex
 *   | u64 amountUqor | recipient 20 | u64 deadline | signature 4627)
 */
export function encodeAttestation(a: Attestation): Uint8Array {
  if (a.claims.length === 0 || a.claims.length > 0xffff) throw new Error("an attestation carries 1 to 65535 claims");
  const n = new Uint8Array(2);
  new DataView(n.buffer).setUint16(0, a.claims.length);
  const parts = [enc.encode(ATTEST_MAGIC), fixedHex(a.vault, 20, "vault"), fixedHex(a.member, 20, "member"), n];
  for (const { claim: c, signature } of a.claims) {
    if (signature.length !== ML_DSA_87_SIG_LEN) throw new Error(`signature must be ${ML_DSA_87_SIG_LEN} bytes`);
    parts.push(
      u64(c.batchIndex),
      fixedHex(c.stateRoot, 32, "stateRoot"),
      u64(c.withdrawalIndex),
      u64(c.amountUqor),
      fixedHex(c.recipient, 20, "recipient"),
      u64(c.deadline),
      signature,
    );
  }
  return concat(parts);
}

const CLAIM_LEN = 8 + 32 + 8 + 8 + 20 + 8 + ML_DSA_87_SIG_LEN;

/** Parse an inbox payload; undefined if it is not an exit attestation (most entries are not). */
export function decodeAttestation(bytes: Uint8Array): Attestation | undefined {
  const magic = enc.encode(ATTEST_MAGIC);
  const head = magic.length + 20 + 20 + 2;
  if (bytes.length < head + CLAIM_LEN) return undefined;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = magic.length;
  const vault = `0x${bytesToHex(bytes.subarray(o, o + 20))}`;
  o += 20;
  const member = bytesToHex(bytes.subarray(o, o + 20));
  o += 20;
  const n = dv.getUint16(o);
  o += 2;
  if (bytes.length !== head + n * CLAIM_LEN) return undefined;
  const claims: SignedClaim[] = [];
  for (let k = 0; k < n; k++) {
    const batchIndex = Number(dv.getBigUint64(o));
    const stateRoot = bytesToHex(bytes.subarray(o + 8, o + 40));
    const withdrawalIndex = Number(dv.getBigUint64(o + 40));
    const amountUqor = dv.getBigUint64(o + 48);
    const recipient = bytesToHex(bytes.subarray(o + 56, o + 76));
    const deadline = Number(dv.getBigUint64(o + 76));
    const signature = bytes.slice(o + 84, o + 84 + ML_DSA_87_SIG_LEN);
    claims.push({ claim: { batchIndex, stateRoot, withdrawalIndex, amountUqor, recipient, deadline }, signature });
    o += CLAIM_LEN;
  }
  return { vault, member, claims };
}

/**
 * The claims for a valid batch's withdrawals. `deadline` is when the batch could first be final
 * (submitted time plus the challenge window) less `marginSec`, so the vault stops fronting before the
 * withdrawal can be paid on L1.
 */
export function claimsForBatch(
  batch: { batchIndex: number; stateRoot: string; submittedTime: number },
  withdrawals: { index: bigint | number; recipient: string; amount: bigint }[],
  challengeWindowSec: number,
  marginSec: number,
): ExitClaim[] {
  const deadline = batch.submittedTime + challengeWindowSec - marginSec;
  return withdrawals.map((w) => ({
    batchIndex: batch.batchIndex,
    stateRoot: norm(batch.stateRoot),
    withdrawalIndex: Number(w.index),
    amountUqor: w.amount,
    recipient: recipientBytes(w.recipient),
    deadline,
  }));
}
