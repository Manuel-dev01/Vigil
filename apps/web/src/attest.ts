/**
 * Watchtower exit attestations, read from the rollup's public inbox and checked in the browser.
 *
 * Anyone can post into the inbox, so an inbox entry that looks like an attestation proves nothing on
 * its own. One is accepted only when:
 * - it decodes exactly, every integer in range (u64 fields above 2^53 cannot name a real batch);
 * - it is for this vault and names a quorum member;
 * - the chain says it was posted by that member's own qor1 address (the watchtowers post their own);
 * - each claim's ML-DSA-87 signature verifies here, with @noble/post-quantum (FIPS 204, pure mode,
 *   empty context: what QoreChain's pqcVerify precompile checks), against the member's key.
 * Claims are grouped by everything signed (batch, root, withdrawal, amount, recipient, deadline), not
 * by the first one seen, so a later post cannot replace what the quorum signed.
 *
 * The layouts are copied from packages/qledger-watchtower/src/exits.ts, which the page cannot import
 * (it pulls in the full SDK). Since posts are limited to 6,144 bytes, each post carries one claim, so
 * a member's claims for a batch arrive as several inbox entries.
 */
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "viem";

export const EXIT_DOMAIN = "vigil/instant-exit/v1/exit";
export const ATTEST_MAGIC = "vigil/instant-exit/v1/attest";
export const ML_DSA_87_SIG_LEN = 4627;
export const ML_DSA_87_PUBKEY_LEN = 2592;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

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
  /** 0x-prefixed, lowercase. */
  vault: string;
  /** The signing member's 20-byte address, 40 lowercase hex (no 0x). */
  member: string;
  claims: SignedClaim[];
}

const enc = new TextEncoder();
const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");
export const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function bytesOf(hex: string): Uint8Array {
  const s = norm(hex);
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error("not hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function u64(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v > U64_MAX) throw new Error(`u64 out of range: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
}

function fixedHex(h: string, bytes: number, what: string): Uint8Array {
  const s = norm(h);
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s)) throw new Error(`${what} must be ${bytes} bytes of hex`);
  return bytesOf(s);
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

/**
 * The bytes a quorum member signs for `c`; equal to InstantExitVault.exitMessage:
 *   "vigil/instant-exit/v1/exit" | u64be evmChainId | vault (20) | u64be len | chainId | u64be len | rollupId
 *   | u64be batchIndex | stateRoot (32) | u64be withdrawalIndex | u64be amountUqor | recipient (20) | u64be deadline
 */
export function exitMessage(t: ExitTarget, c: ExitClaim): Uint8Array {
  const chainId = enc.encode(t.chainId);
  const rollup = enc.encode(t.rollupId);
  return concat([
    enc.encode(EXIT_DOMAIN),
    u64(t.evmChainId),
    fixedHex(t.vault, 20, "vault"),
    u64(chainId.length),
    chainId,
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

const CLAIM_LEN = 8 + 32 + 8 + 8 + 20 + 8 + ML_DSA_87_SIG_LEN;

/** Thrown for a payload that starts like an attestation but cannot be one. */
export class MalformedAttestation extends Error {}

/** A u64 field as a JavaScript number, or an error if it is above 2^53 (no real batch, index or time is). */
function safe(v: bigint, what: string): number {
  if (v > SAFE) throw new MalformedAttestation(`${what} ${v} is out of range`);
  return Number(v);
}

/**
 * Parse an inbox payload:
 *   ATTEST_MAGIC | vault (20) | member (20) | u16be n | n × (u64 batchIndex | stateRoot 32 | u64 withdrawalIndex
 *   | u64 amountUqor | recipient 20 | u64 deadline | signature 4627)
 * Undefined if it is not an attestation at all (most entries are not); throws MalformedAttestation if it
 * carries the magic but its length or integers are wrong.
 */
export function decodeAttestation(bytes: Uint8Array): Attestation | undefined {
  const magic = enc.encode(ATTEST_MAGIC);
  if (bytes.length < magic.length) return undefined;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return undefined;
  const head = magic.length + 20 + 20 + 2;
  if (bytes.length < head + CLAIM_LEN) throw new MalformedAttestation(`${bytes.length} bytes is too short for an attestation`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = magic.length;
  const vault = `0x${hexOf(bytes.subarray(o, o + 20))}`;
  o += 20;
  const member = hexOf(bytes.subarray(o, o + 20));
  o += 20;
  const n = dv.getUint16(o);
  o += 2;
  if (n === 0 || bytes.length !== head + n * CLAIM_LEN) throw new MalformedAttestation(`${bytes.length} bytes does not hold ${n} claims`);
  const claims: SignedClaim[] = [];
  for (let k = 0; k < n; k++) {
    const batchIndex = safe(dv.getBigUint64(o), "batchIndex");
    const stateRoot = hexOf(bytes.subarray(o + 8, o + 40));
    const withdrawalIndex = safe(dv.getBigUint64(o + 40), "withdrawalIndex");
    const amountUqor = dv.getBigUint64(o + 48);
    const recipient = hexOf(bytes.subarray(o + 56, o + 76));
    const deadline = safe(dv.getBigUint64(o + 76), "deadline");
    const signature = bytes.slice(o + 84, o + 84 + ML_DSA_87_SIG_LEN);
    claims.push({ claim: { batchIndex, stateRoot, withdrawalIndex, amountUqor, recipient, deadline }, signature });
    o += CLAIM_LEN;
  }
  return { vault, member, claims };
}

/** ML-DSA-87 (FIPS 204 pure, empty context) in this browser. False for any malformed input. */
export function verifyMlDsa87(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== ML_DSA_87_PUBKEY_LEN || signature.length !== ML_DSA_87_SIG_LEN) return false;
  try {
    return ml_dsa87.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ acceptance

export interface PostLike {
  sequence: number;
  /** The account the chain says posted the entry (qor1…). */
  poster: string;
  payload: Uint8Array;
}

export interface QuorumKey {
  /** 40 lowercase hex, no 0x. */
  address: string;
  qor1: string;
  /** The member's ML-DSA-87 public key, if it could be read. */
  key: Uint8Array | undefined;
  /** A fingerprint of `key` (its SHA-256, say), so verdicts can be cached across refreshes. */
  keyId?: string;
}

export type Rejection = "malformed" | "other vault" | "not a quorum member" | "wrong poster" | "bad signature";

export interface AcceptedClaim<P extends PostLike = PostLike> {
  post: P;
  memberIndex: number;
  claim: ExitClaim;
  signature: Uint8Array;
  /** The local ML-DSA-87 check: true, or undefined when the member's key could not be read. */
  localValid: true | undefined;
}

export interface Screened<P extends PostLike = PostLike> {
  accepted: AcceptedClaim<P>[];
  rejected: { post: P; reason: Rejection; detail: string }[];
}

/**
 * Screen inbox posts for attestations to `target.vault` by `members`. Posts that are not attestations
 * are ignored; ones that are but fail a rule are rejected, with the reason. A claim whose member key
 * could not be read is kept with `localValid` undefined (shown, never counted).
 *
 * `verdicts` caches signature checks across calls, by key fingerprint and the SHA-256 of message and
 * signature, so each signature is verified once per page rather than on every refresh.
 */
export function screenAttestations<P extends PostLike>(posts: readonly P[], target: ExitTarget, members: readonly QuorumKey[], verdicts?: Map<string, boolean>): Screened<P> {
  const out: Screened<P> = { accepted: [], rejected: [] };
  const vault = norm(target.vault);
  for (const post of posts) {
    let a: Attestation | undefined;
    try {
      a = decodeAttestation(post.payload);
    } catch (e) {
      out.rejected.push({ post, reason: "malformed", detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!a) continue;
    if (norm(a.vault) !== vault) {
      out.rejected.push({ post, reason: "other vault", detail: `for vault ${a.vault}` });
      continue;
    }
    const memberIndex = members.findIndex((m) => norm(m.address) === a.member);
    if (memberIndex < 0) {
      out.rejected.push({ post, reason: "not a quorum member", detail: `names 0x${a.member}` });
      continue;
    }
    const m = members[memberIndex]!;
    if (post.poster !== m.qor1) {
      out.rejected.push({ post, reason: "wrong poster", detail: `names ${m.qor1} but was posted by ${post.poster}` });
      continue;
    }
    const bad: number[] = [];
    const ok: AcceptedClaim<P>[] = [];
    a.claims.forEach((s, k) => {
      if (!m.key) {
        ok.push({ post, memberIndex, claim: s.claim, signature: s.signature, localValid: undefined });
        return;
      }
      let message: Uint8Array;
      try {
        message = exitMessage(target, s.claim);
      } catch {
        bad.push(k);
        return;
      }
      const ck = verdicts && m.keyId !== undefined ? `${m.keyId}:${sha256(concat([message, s.signature]))}` : undefined;
      const known = ck === undefined ? undefined : verdicts?.get(ck);
      const valid = known ?? verifyMlDsa87(m.key, message, s.signature);
      if (ck !== undefined) verdicts?.set(ck, valid);
      if (valid) ok.push({ post, memberIndex, claim: s.claim, signature: s.signature, localValid: true });
      else bad.push(k);
    });
    if (bad.length) out.rejected.push({ post, reason: "bad signature", detail: `${bad.length} of ${a.claims.length} claims do not verify against ${m.qor1}'s key` });
    out.accepted.push(...ok);
  }
  return out;
}

// ------------------------------------------------------------ grouping

/** One exit: a withdrawal (batch, root, index), the vault's exitId. */
export const exitKey = (c: Pick<ExitClaim, "batchIndex" | "stateRoot" | "withdrawalIndex">): string => `${c.batchIndex}:${norm(c.stateRoot)}:${c.withdrawalIndex}`;
/** Everything a member signs about it. */
export const claimKey = (c: ExitClaim): string => `${exitKey(c)}:${c.amountUqor}:${norm(c.recipient)}:${c.deadline}`;

export interface ClaimVariant<P extends PostLike = PostLike> {
  claim: ExitClaim;
  /** One attestation per member (their earliest post of this exact claim). */
  atts: AcceptedClaim<P>[];
  /** Members whose signature verified here. */
  verified: number;
}

export interface ExitGroup<P extends PostLike = PostLike> {
  key: string;
  /** The claim most members verifiably signed (ties: the earliest posted). */
  headline: ClaimVariant<P>;
  /** Other claims members signed for the same withdrawal. */
  others: ClaimVariant<P>[];
}

/** Group accepted claims by exit, and within an exit by the full signed claim. */
export function groupByExit<P extends PostLike>(accepted: readonly AcceptedClaim<P>[]): Map<string, ExitGroup<P>> {
  const variants = new Map<string, Map<string, ClaimVariant<P>>>();
  const sorted = [...accepted].sort((x, y) => x.post.sequence - y.post.sequence);
  for (const a of sorted) {
    const ek = exitKey(a.claim);
    const byClaim = variants.get(ek) ?? new Map<string, ClaimVariant<P>>();
    variants.set(ek, byClaim);
    const ck = claimKey(a.claim);
    const v = byClaim.get(ck) ?? { claim: a.claim, atts: [], verified: 0 };
    byClaim.set(ck, v);
    if (v.atts.some((x) => x.memberIndex === a.memberIndex)) continue;
    v.atts.push(a);
    if (a.localValid) v.verified++;
  }
  const out = new Map<string, ExitGroup<P>>();
  for (const [key, byClaim] of variants) {
    const all = [...byClaim.values()];
    const first = (v: ClaimVariant<P>) => Math.min(...v.atts.map((a) => a.post.sequence));
    all.sort((x, y) => y.verified - x.verified || y.atts.length - x.atts.length || first(x) - first(y));
    out.set(key, { key, headline: all[0]!, others: all.slice(1) });
  }
  return out;
}
