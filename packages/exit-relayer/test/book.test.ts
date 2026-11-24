/**
 * The relayer's inbox bookkeeping, offline: which attestations count, how claims gather a quorum, where
 * payouts come from, and how a batch's withdrawal list is rebuilt and checked against a withdrawals root.
 */
import { createHash } from "node:crypto";
import { bech32ToHex, bytesToHex, hexToBech32, qledgerWithdrawalsRoot } from "@qorechain/rdk";
import { generatePqcKeypair } from "@qorechain/sdk";
import { encodeAttestation, encodePayoutNotice, signClaims, type ExitClaim, type ExitTarget } from "@vigil/qledger-watchtower";
import { describe, expect, it } from "vitest";
import { ExitBook, batchKey, batchWithdrawals, withdrawalKey, withdrawalsMatch, type InboxEntry } from "../src/book.ts";
import { WEI_PER_UQOR, feeCapUqor } from "../src/vault.ts";

const target: ExitTarget = { evmChainId: 9800, vault: "0x" + "aa".repeat(20), chainId: "qorechain-diana", rollupId: "vigil-pay-1" };
const seed = (s: string) => createHash("sha256").update(s).digest();
const m0 = generatePqcKeypair(seed("relayer-test/m0"));
const m1 = generatePqcKeypair(seed("relayer-test/m1"));
const outsider = generatePqcKeypair(seed("relayer-test/outsider"));
const members = ["0x" + "01".repeat(20), "0x" + "02".repeat(20)];
const keys = [bytesToHex(m0.publicKey), bytesToHex(m1.publicKey)];

const EXIT_ADDR = "ee".repeat(20);
const root = "7a".repeat(32);
const claims: ExitClaim[] = [
  { batchIndex: 21, stateRoot: root, withdrawalIndex: 7, amountUqor: 100_000n, recipient: EXIT_ADDR, deadline: 1_800_000_000 },
  { batchIndex: 21, stateRoot: root, withdrawalIndex: 8, amountUqor: 5n, recipient: "44".repeat(20), deadline: 1_800_000_000 },
];
const attest = (sk: Uint8Array, member: string, cs = claims, vault = target.vault) =>
  encodeAttestation({ vault, member: member.slice(2), claims: signClaims({ ...target, vault }, sk, cs) });
let seq = 0;
const entry = (payload: Uint8Array, poster = "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd"): InboxEntry => ({ seq: ++seq, poster, payload });
const fresh = () => new ExitBook(target, members, keys);

describe("attestations", () => {
  it("need every quorum member's valid signature before a claim is ready", () => {
    const book = fresh();
    const r0 = book.ingest([entry(attest(m0.secretKey, members[0]!))]);
    expect(r0).toMatchObject({ attestations: 1, claims: 2, rejected: 0 });
    expect(book.ready(2)).toHaveLength(0);
    book.ingest([entry(attest(m1.secretKey, members[1]!))]);
    const ready = book.ready(2);
    expect(ready).toHaveLength(2);
    expect(ready[0]!.signers).toEqual([0, 1]);
    expect(ready[0]!.claim.withdrawalIndex).toBe(7);
    // the same attestation read twice adds nothing
    expect(book.ingest([entry(attest(m1.secretKey, members[1]!))]).claims).toBe(0);
  });

  it("drop a forged or tampered signature, an outsider, and another vault", () => {
    const book = fresh();
    // an outsider's key, claiming to be member 1
    expect(book.ingest([entry(attest(outsider.secretKey, members[1]!))]).rejected).toBe(2);
    // a member address the quorum does not have
    expect(book.ingest([entry(attest(m0.secretKey, "0x" + "09".repeat(20)))]).rejected).toBe(2);
    // another vault's attestation is not even counted
    expect(book.ingest([entry(attest(m0.secretKey, members[0]!, claims, "0x" + "bb".repeat(20)))])).toMatchObject({ attestations: 0, rejected: 0 });
    // one byte flipped in member 0's first signature (header 70 bytes, then 84 bytes of claim fields)
    const bytes = attest(m0.secretKey, members[0]!);
    bytes[70 + 84 + 100]! ^= 1;
    const r = book.ingest([entry(bytes)]);
    expect(r).toMatchObject({ attestations: 1, claims: 1, rejected: 1 });
    // only the valid claim counts towards member 0's withdrawal list
    expect(book.batches.get(batchKey(21, root))!.withdrawals.map((w) => w.index)).toEqual([8]);
    book.ingest([entry(attest(m1.secretKey, members[1]!))]);
    expect(book.ready(2).map((x) => x.claim.withdrawalIndex)).toEqual([8]);
    // member 1's complete list is now the longest
    expect(book.batches.get(batchKey(21, root))!.withdrawals.map((w) => w.index)).toEqual([7, 8]);
  });

  it("with different deadlines are different claims, but the same withdrawal", () => {
    const book = fresh();
    book.ingest([entry(attest(m0.secretKey, members[0]!)), entry(attest(m1.secretKey, members[1]!, claims.map((c) => ({ ...c, deadline: c.deadline + 60 }))))]);
    expect(book.ready(2)).toHaveLength(0);
    expect(book.withdrawals().map(withdrawalKey)).toEqual([`${batchKey(21, root)}:7`, `${batchKey(21, root)}:8`]);
  });
});

describe("payout candidates", () => {
  it("come from notices for this vault and from posters, not from deposits", () => {
    const book = fresh();
    const r = book.ingest([
      entry(encodePayoutNotice(target.vault, "0x" + "5a".repeat(20))),
      entry(encodePayoutNotice("0x" + "bb".repeat(20), "0x" + "5b".repeat(20))),
      entry(new Uint8Array([1, 2, 3]), "qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k"),
      entry(new Uint8Array([1, 2, 3]), "deposit:qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s"),
    ]);
    expect(r.notices).toBe(1);
    expect(book.candidates.has("5a".repeat(20))).toBe(true);
    expect(book.candidates.has("5b".repeat(20))).toBe(false);
    const hex = (a: string) => bech32ToHex(a).toLowerCase().replace(/^0x/, "");
    // the notice's payout, and the two posters; the other vault's payout and the depositor are not
    expect([...book.candidates].sort()).toEqual(
      ["5a".repeat(20), hex("qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k"), hex("qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd")].sort(),
    );
  });
});

describe("a batch's withdrawal list", () => {
  it("is rebuilt from a complete attestation and must reproduce the withdrawals root", () => {
    const book = fresh();
    book.ingest([entry(attest(m0.secretKey, members[0]!))]);
    const b = book.batches.get(batchKey(21, root))!;
    const ws = batchWithdrawals(b);
    expect(ws.map((w) => [w.index, w.recipient, w.amount])).toEqual([
      [7n, hexToBech32("0x" + EXIT_ADDR, "qor"), 100_000n],
      [8n, hexToBech32("0x" + "44".repeat(20), "qor"), 5n],
    ]);
    const stored = qledgerWithdrawalsRoot("qorechain-diana", "vigil-pay-1", ws);
    expect(withdrawalsMatch("qorechain-diana", "vigil-pay-1", ws, stored, false)).toBe(true);
    expect(withdrawalsMatch("qorechain-diana", "vigil-pay-2", ws, stored, false)).toBe(false);
    expect(withdrawalsMatch("qorechain-diana", "vigil-pay-1", [{ ...ws[0]!, amount: 100_001n }, ws[1]!], stored, false)).toBe(false);
    expect(withdrawalsMatch("qorechain-diana", "vigil-pay-1", ws.slice(0, 1), stored, false)).toBe(false);
  });

  it("is assembled from one-claim posts, as the watchtower now sends them", () => {
    const book = fresh();
    const [c7, c8] = claims;
    book.ingest([entry(attest(m0.secretKey, members[0]!, [c8!])), entry(attest(m0.secretKey, members[0]!, [c7!]))]);
    const ws = batchWithdrawals(book.batches.get(batchKey(21, root))!);
    expect(ws.map((w) => w.index)).toEqual([7n, 8n]);
    expect(withdrawalsMatch("qorechain-diana", "vigil-pay-1", ws, qledgerWithdrawalsRoot("qorechain-diana", "vigil-pay-1", ws), false)).toBe(true);
    // one post alone is an incomplete list: it does not reproduce the full batch's root
    const one = fresh();
    one.ingest([entry(attest(m0.secretKey, members[0]!, [c7!]))]);
    expect(withdrawalsMatch("qorechain-diana", "vigil-pay-1", batchWithdrawals(one.batches.get(batchKey(21, root))!), qledgerWithdrawalsRoot("qorechain-diana", "vigil-pay-1", ws), false)).toBe(false);
  });

  it("is forgotten with the batch", () => {
    const book = fresh();
    book.ingest([entry(attest(m0.secretKey, members[0]!)), entry(attest(m1.secretKey, members[1]!))]);
    book.forget(21, root);
    expect(book.batches.size).toBe(0);
    expect(book.claims.size).toBe(0);
  });
});

describe("window fee cap", () => {
  it("is the calls' maximum fees in uqor, rounded up", () => {
    const calls = [
      { functionName: "front" as const, data: "0x" as const, gas: 613_783n },
      { functionName: "sweep" as const, data: "0x" as const, gas: 294_269n },
    ];
    const price = 112_500_000_000n;
    expect(feeCapUqor(calls, price)).toBe(((613_783n + 294_269n) * price + WEI_PER_UQOR - 1n) / WEI_PER_UQOR);
    expect(feeCapUqor([{ functionName: "sweep", data: "0x", gas: 1n }], 1n)).toBe(1n);
  });
});
