/**
 * Exit attestations as the Exits page reads them: real ones from vigil-pay-1's inbox verify in the
 * browser with ML-DSA-87, and forged or broken posts are rejected for the right reason.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATTEST_MAGIC,
  bytesOf,
  decodeAttestation,
  exitMessage,
  groupByExit,
  MalformedAttestation,
  screenAttestations,
  verifyMlDsa87,
  type ExitTarget,
  type PostLike,
  type QuorumKey,
} from "../src/attest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "attestations.json"), "utf8")) as {
  vault: string;
  evmChainId: number;
  chainId: string;
  rollupId: string;
  members: { address: string; qor1: string; publicKey: string }[];
  entries: { sequence: number; height: number; poster: string; payload: string }[];
};

const target: ExitTarget = { evmChainId: fx.evmChainId, vault: fx.vault, chainId: fx.chainId, rollupId: fx.rollupId };
const members: QuorumKey[] = fx.members.map((m) => ({ address: m.address, qor1: m.qor1, key: bytesOf(m.publicKey) }));
const posts: PostLike[] = fx.entries.map((e) => ({ sequence: e.sequence, poster: e.poster, payload: bytesOf(e.payload) }));
const post = (seq: number): PostLike => posts.find((p) => p.sequence === seq)!;
const keyOf = (qor1: string): Uint8Array => members.find((m) => m.qor1 === qor1)!.key!;

/** A copy of `p` with one bit flipped at byte `at` (counted from the end when negative). */
function flip(p: Uint8Array, at: number): Uint8Array {
  const c = p.slice();
  const i = at < 0 ? c.length + at : at;
  c[i] = c[i]! ^ 1;
  return c;
}

describe("ML-DSA-87 in the browser", () => {
  it("verifies the watchtowers' real attestations (entries 18, 19, 21, 22) and rejects a flipped bit", () => {
    for (const p of posts) {
      const a = decodeAttestation(p.payload)!;
      expect(a.claims).toHaveLength(1);
      const { claim, signature } = a.claims[0]!;
      const msg = exitMessage(target, claim);
      expect(msg.length).toBe(180);
      expect(verifyMlDsa87(keyOf(p.poster), msg, signature)).toBe(true);
      expect(verifyMlDsa87(keyOf(p.poster), msg, flip(signature, 100))).toBe(false);
      expect(verifyMlDsa87(keyOf(p.poster), flip(msg, -1), signature)).toBe(false);
    }
  });

  it("does not accept a signature under the other member's key", () => {
    const a = decodeAttestation(post(21).payload)!;
    const other = fx.members.find((m) => m.qor1 !== post(21).poster)!;
    expect(verifyMlDsa87(bytesOf(other.publicKey), exitMessage(target, a.claims[0]!.claim), a.claims[0]!.signature)).toBe(false);
  });
});

describe("screening inbox posts", () => {
  it("accepts the real attestations, each from its own member", () => {
    const s = screenAttestations(posts, target, members);
    expect(s.rejected).toEqual([]);
    expect(s.accepted).toHaveLength(4);
    for (const a of s.accepted) {
      expect(a.localValid).toBe(true);
      expect(members[a.memberIndex]!.qor1).toBe(a.post.poster);
    }
  });

  it("rejects a member's attestation posted by someone else", () => {
    const forged = { ...post(21), sequence: 99, poster: "qor1fvrd7gscnq6xkmrcrdm4gzzwnv4f3lfk0ummn2" };
    const s = screenAttestations([forged], target, members);
    expect(s.accepted).toHaveLength(0);
    expect(s.rejected[0]?.reason).toBe("wrong poster");
  });

  it("rejects a claim whose signature does not verify, even from the right poster", () => {
    const tampered = { ...post(21), payload: flip(post(21).payload, -10) };
    const s = screenAttestations([tampered], target, members);
    expect(s.accepted).toHaveLength(0);
    expect(s.rejected[0]?.reason).toBe("bad signature");
  });

  it("rejects a changed claim (amount) with the member's real signature", () => {
    const p = post(22).payload.slice();
    // amountUqor sits 48 bytes into the first claim, after magic, vault, member and the count.
    const amountAt = ATTEST_MAGIC.length + 20 + 20 + 2 + 48 + 7;
    p[amountAt] = p[amountAt]! ^ 0xff;
    const s = screenAttestations([{ ...post(22), payload: p }], target, members);
    expect(s.accepted).toHaveLength(0);
    expect(s.rejected[0]?.reason).toBe("bad signature");
  });

  it("rejects out-of-range integers instead of throwing (batch index 2^64-1)", () => {
    const p = post(21).payload.slice();
    p.fill(0xff, ATTEST_MAGIC.length + 42, ATTEST_MAGIC.length + 50);
    expect(() => decodeAttestation(p)).toThrow(MalformedAttestation);
    const s = screenAttestations([{ ...post(21), payload: p }], target, members);
    expect(s.accepted).toHaveLength(0);
    expect(s.rejected[0]?.reason).toBe("malformed");
    expect(s.rejected[0]?.detail).toMatch(/batchIndex 18446744073709551615 is out of range/);
  });

  it("rejects a wrong length, another vault and a non-member, and ignores ordinary entries", () => {
    const short = post(21).payload.slice(0, -1);
    const otherVault = post(21).payload.slice();
    otherVault[ATTEST_MAGIC.length] = otherVault[ATTEST_MAGIC.length]! ^ 1;
    const stranger = post(21).payload.slice();
    stranger[ATTEST_MAGIC.length + 20] = stranger[ATTEST_MAGIC.length + 20]! ^ 1;
    const s = screenAttestations(
      [
        { ...post(21), payload: short },
        { ...post(21), payload: otherVault },
        { ...post(21), payload: stranger },
        { sequence: 1, poster: "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", payload: new TextEncoder().encode("hello") },
      ],
      target,
      members,
    );
    expect(s.rejected.map((r) => r.reason)).toEqual(["malformed", "other vault", "not a quorum member"]);
    expect(s.accepted).toHaveLength(0);
  });

  it("caches verdicts by the signed bytes, so a changed post is checked afresh", () => {
    const verdicts = new Map<string, boolean>();
    const keyed = members.map((m, i) => ({ ...m, keyId: `k${i}` }));
    expect(screenAttestations(posts, target, keyed, verdicts).accepted).toHaveLength(4);
    expect(verdicts.size).toBe(4);
    // The same sequence number with a different signature is not served from the cache.
    const tampered = { ...post(21), payload: flip(post(21).payload, -10) };
    const s = screenAttestations([tampered], target, keyed, verdicts);
    expect(s.accepted).toHaveLength(0);
    expect(s.rejected[0]?.reason).toBe("bad signature");
    expect(screenAttestations(posts, target, keyed, verdicts).accepted).toHaveLength(4);
  });

  it("keeps an attestation whose member key could not be read, but never as verified", () => {
    const noKeys = members.map((m) => ({ ...m, key: undefined }));
    const s = screenAttestations([post(21)], target, noKeys);
    expect(s.accepted).toHaveLength(1);
    expect(s.accepted[0]!.localValid).toBeUndefined();
  });
});

describe("grouping by the full claim", () => {
  it("puts each member's separate post for the same claim in one exit", () => {
    const g = groupByExit(screenAttestations(posts, target, members).accepted);
    expect(g.size).toBe(2); // batch 15 and batch 18
    for (const e of g.values()) {
      expect(e.headline.atts).toHaveLength(2);
      expect(e.headline.verified).toBe(2);
      expect(e.others).toHaveLength(0);
    }
  });

  it("does not let an earlier, less-signed claim become the headline", () => {
    const real = screenAttestations(posts, target, members).accepted.filter((a) => a.claim.batchIndex === 18);
    // A claim for the same withdrawal with a later deadline, posted first and signed by only one member.
    const lone = { ...real[0]!, post: { ...real[0]!.post, sequence: 1 }, claim: { ...real[0]!.claim, deadline: real[0]!.claim.deadline + 999 } };
    const g = groupByExit([lone, ...real]);
    const e = [...g.values()][0]!;
    expect(e.headline.claim.deadline).toBe(real[0]!.claim.deadline);
    expect(e.headline.verified).toBe(2);
    expect(e.others).toHaveLength(1);
  });
});
