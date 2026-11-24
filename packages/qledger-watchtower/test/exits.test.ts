/**
 * Instant-exit attestations, offline: the exit message layout (pinned against the Solidity layout of
 * InstantExitVault.exitMessage), ML-DSA-87 signing and verification, the inbox payload, and the claims
 * built from a batch's withdrawals. The live check that the deployed vault produces the same bytes and
 * accepts these signatures is scripts/exit/instant-exit.ts simulate.
 */
import { createHash } from "node:crypto";
import { bytesToHex, hexToBech32 } from "@qorechain/rdk";
import { generatePqcKeypair } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import {
  ATTEST_MAGIC,
  EXIT_DOMAIN,
  PAYOUT_MAGIC,
  claimsForBatch,
  decodeAttestation,
  decodePayoutNotice,
  encodeAttestation,
  encodePayoutNotice,
  exitMessage,
  recipientBytes,
  signClaims,
  verifyClaim,
  type ExitClaim,
  type ExitTarget,
} from "../src/exits.ts";

const target: ExitTarget = {
  evmChainId: 9800,
  vault: "0x00000000000000000000000000000000000000aa",
  chainId: "qorechain-diana",
  rollupId: "vigil-pay-1",
};
const claim: ExitClaim = {
  batchIndex: 15,
  stateRoot: "11".repeat(32),
  withdrawalIndex: 2,
  amountUqor: 100_000n,
  recipient: "22".repeat(20),
  deadline: 1_795_463_000,
};
const seed = (s: string) => createHash("sha256").update(s).digest();
const member = generatePqcKeypair(seed("vigil-exit-test/member"));
const other = generatePqcKeypair(seed("vigil-exit-test/other"));

const be64 = (n: number | bigint) => BigInt(n).toString(16).padStart(16, "0");
const ascii = (s: string) => Buffer.from(s).toString("hex");

describe("exit message", () => {
  it("matches InstantExitVault.exitMessage's layout", () => {
    const expected =
      ascii(EXIT_DOMAIN) +
      be64(9800) +
      "00".repeat(19) +
      "aa" +
      be64(15) +
      ascii("qorechain-diana") +
      be64(11) +
      ascii("vigil-pay-1") +
      be64(15) +
      "11".repeat(32) +
      be64(2) +
      be64(100_000) +
      "22".repeat(20) +
      be64(1_795_463_000);
    expect(bytesToHex(exitMessage(target, claim))).toBe(expected);
  });

  it("changes with every field", () => {
    const base = bytesToHex(exitMessage(target, claim));
    const variants: ExitClaim[] = [
      { ...claim, batchIndex: 16 },
      { ...claim, stateRoot: "12".repeat(32) },
      { ...claim, withdrawalIndex: 3 },
      { ...claim, amountUqor: 100_001n },
      { ...claim, recipient: "23".repeat(20) },
      { ...claim, deadline: claim.deadline + 1 },
    ];
    for (const v of variants) expect(bytesToHex(exitMessage(target, v))).not.toBe(base);
    expect(bytesToHex(exitMessage({ ...target, vault: "0x" + "00".repeat(19) + "ab" }, claim))).not.toBe(base);
    expect(bytesToHex(exitMessage({ ...target, evmChainId: 9801 }, claim))).not.toBe(base);
  });

  it("refuses malformed fields", () => {
    expect(() => exitMessage(target, { ...claim, recipient: "22" })).toThrow(/recipient/);
    expect(() => exitMessage({ ...target, vault: "0x1234" }, claim)).toThrow(/vault/);
    expect(() => exitMessage(target, { ...claim, amountUqor: -1n })).toThrow(/u64/);
  });
});

describe("signatures", () => {
  it("verify for the signer and fail for any other key or claim", () => {
    const [s] = signClaims(target, member.secretKey, [claim]);
    const pk = bytesToHex(member.publicKey);
    expect(s!.signature.length).toBe(4627);
    expect(verifyClaim(target, pk, s!)).toBe(true);
    expect(verifyClaim(target, bytesToHex(other.publicKey), s!)).toBe(false);
    expect(verifyClaim(target, pk, { ...s!, claim: { ...claim, amountUqor: 1n } })).toBe(false);
    expect(verifyClaim({ ...target, rollupId: "vigil-pay-2" }, pk, s!)).toBe(false);
  });
});

describe("inbox payload", () => {
  it("round-trips one member's signed claims", () => {
    const claims = [claim, { ...claim, withdrawalIndex: 3, amountUqor: 5n }];
    const signed = signClaims(target, member.secretKey, claims);
    const bytes = encodeAttestation({ vault: target.vault, member: "33".repeat(20), claims: signed });
    expect(new TextDecoder().decode(bytes.subarray(0, ATTEST_MAGIC.length))).toBe(ATTEST_MAGIC);
    const back = decodeAttestation(bytes)!;
    expect(back.vault).toBe(target.vault);
    expect(back.member).toBe("33".repeat(20));
    expect(back.claims.map((c) => c.claim)).toEqual(claims);
    for (const c of back.claims) expect(verifyClaim(target, bytesToHex(member.publicKey), c)).toBe(true);
  });

  it("ignores anything that is not an attestation", () => {
    expect(decodeAttestation(new Uint8Array(0))).toBeUndefined();
    expect(decodeAttestation(new TextEncoder().encode("a qledger tx or a sealed payslip"))).toBeUndefined();
    const [s] = signClaims(target, member.secretKey, [claim]);
    const ok = encodeAttestation({ vault: target.vault, member: "33".repeat(20), claims: [s!] });
    expect(decodeAttestation(ok.subarray(0, ok.length - 1))).toBeUndefined();
  });
});

describe("payout notices", () => {
  it("round-trip, and are told apart from attestations and qledger txs", () => {
    const bytes = encodePayoutNotice(target.vault, "0x" + "5A".repeat(20));
    expect(bytes.length).toBe(PAYOUT_MAGIC.length + 40);
    expect(decodePayoutNotice(bytes)).toEqual({ vault: target.vault, payout: "0x" + "5a".repeat(20) });
    expect(decodeAttestation(bytes)).toBeUndefined();
    const [s] = signClaims(target, member.secretKey, [claim]);
    expect(decodePayoutNotice(encodeAttestation({ vault: target.vault, member: "33".repeat(20), claims: [s!] }))).toBeUndefined();
    expect(decodePayoutNotice(bytes.subarray(0, bytes.length - 1))).toBeUndefined();
    expect(decodePayoutNotice(new Uint8Array([...bytes, 0]))).toBeUndefined();
    expect(() => encodePayoutNotice(target.vault, "0x1234")).toThrow(/payout/);
  });
});

describe("claims for a batch", () => {
  it("signs every withdrawal, with the deadline before the batch can be final", () => {
    const recipient = hexToBech32("0x" + "44".repeat(20), "qor");
    const claims = claimsForBatch(
      { batchIndex: 15, stateRoot: "0x" + "AB".repeat(32), submittedTime: 1_795_460_000 },
      [
        { index: 0n, recipient, amount: 100_000n },
        { index: 1n, recipient, amount: 7n },
      ],
      3600,
      600,
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]).toEqual({
      batchIndex: 15,
      stateRoot: "ab".repeat(32),
      withdrawalIndex: 0,
      amountUqor: 100_000n,
      recipient: "44".repeat(20),
      deadline: 1_795_460_000 + 3600 - 600,
    });
    expect(recipientBytes(recipient)).toBe("44".repeat(20));
  });
});
