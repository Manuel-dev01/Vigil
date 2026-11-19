/**
 * The sealed data lane, offline: payslip envelopes, the qledger no-op rule
 * they rely on, data receipts against vigil-1's recorded inbox, and recipient
 * cards.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_INBOX_ACC,
  QLEDGER_MAX_POST_BYTES,
  bytesToHex,
  executeQledger,
  hexToBytes,
  inboxAccumulate,
  inboxRangeHash,
  postedDataHash,
} from "@qorechain/rdk";
import { envelopeSize, parseEnvelope, recipientOf, sealKeysFromSeed, verifyRecipientCard } from "@qorechain/qoreseal";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { checkBatches, toEntry, type ReplayVector } from "../../../scripts/lib/replay.ts";
import { signCard } from "../src/card.ts";
import { dataReceiptFrom, verifyDataReceipt, type DataReceipt, type ReceiptPost } from "../src/data-receipt.ts";
import { checkPayslip, isSealedEnvelope, openPayslip, sealPayslip, type Payslip } from "../src/payslip.ts";

const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../test/vectors/replay-vigil-1.json"), "utf8"),
) as ReplayVector;
const chainId = "qorechain-diana";
const rollupId = "vigil-pay-1";
const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
const seedKeys = (n: number) => sealKeysFromSeed(new Uint8Array(32).fill(n));
const [employee, auditor, employer, outsider] = [1, 2, 3, 4].map(seedKeys) as [ReturnType<typeof seedKeys>, ReturnType<typeof seedKeys>, ReturnType<typeof seedKeys>, ReturnType<typeof seedKeys>];

const payslip: Payslip = {
  v: 1,
  kind: "vigil/payslip",
  rollupId,
  period: "2026-11",
  employer: "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s",
  employee: "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd",
  payment: { postDataHash: "11".repeat(32), fromAccount: "aa".repeat(32), toAccount: "bb".repeat(32), amountUqor: "80000" },
  lines: [
    { label: "Gross pay", amountUqor: "100000" },
    { label: "Income tax", amountUqor: "-15000" },
    { label: "Pension", amountUqor: "-5000" },
  ],
  note: "November, testnet payroll drill",
  issuedAt: "2026-11-19T10:00:00Z",
};

describe("sealed payslips", () => {
  const envelope = sealPayslip({ chainId, payslip, recipients: [employee, auditor, employer].map(recipientOf) });

  it("opens for every recipient and for nobody else", () => {
    for (const keys of [employee, auditor, employer]) expect(openPayslip({ chainId, rollupId, envelope, keys })).toEqual(payslip);
    expect(() => openPayslip({ chainId, rollupId, envelope, keys: outsider })).toThrow();
  });

  it("does not open for another rollup or chain", () => {
    expect(() => openPayslip({ chainId, rollupId: "vigil-1", envelope, keys: employee })).toThrow();
    expect(() => openPayslip({ chainId: "qorechain-mainnet", rollupId, envelope, keys: employee })).toThrow();
  });

  it("fits a qledger post, hides its recipients and is recognised as an envelope", () => {
    expect(envelope.length).toBeLessThanOrEqual(QLEDGER_MAX_POST_BYTES);
    expect(envelope.length).toBe(envelopeSize({ mode: "hybrid", recipients: 3, plaintextLength: JSON.stringify(payslip).length }));
    expect(parseEnvelope(envelope).anonymous).toBe(true);
    expect(isSealedEnvelope(envelope)).toBe(true);
    expect(isSealedEnvelope(new TextEncoder().encode("not an envelope"))).toBe(false);
  });

  it("refuses a payslip whose lines do not add up to the payment", () => {
    const bad = { ...payslip, lines: [{ label: "Gross pay", amountUqor: "100000" }] };
    expect(() => checkPayslip(bad)).toThrow(/add up/);
    expect(() => sealPayslip({ chainId, payslip: bad, recipients: [recipientOf(employee)] })).toThrow(/add up/);
  });

  it("refuses an envelope over the 6 KiB post limit", () => {
    const many = [1, 2, 3, 4].map((n) => recipientOf(seedKeys(n)));
    expect(() => sealPayslip({ chainId, payslip, recipients: many })).toThrow(/post limit/);
  });

  it("is a no-op for the rollup: a batch with an envelope inside settles to the same roots", () => {
    // Batch 28 of vigil-1 (entries 39-41), with a sealed envelope posted in the middle.
    const batches = [...vector.batches].sort((a, b) => a.batchIndex - b.batchIndex);
    const target = batches.at(-1)!;
    const { ledger } = checkBatches({ ...vector, batches: batches.slice(0, -1) });
    const entries = vector.entries.filter((e) => e.sequence > target.inboxStart && e.sequence <= target.inboxEnd).map(toEntry);
    const withEnvelope = [entries[0]!, { height: entries[0]!.height, poster: payslip.employer, payload: envelope }, ...entries.slice(1)];
    const result = executeQledger({ chainId: vector.chainId, rollupId: vector.rollupId }, ledger, withEnvelope);
    expect(hex(result.stateRoot)).toBe(target.stateRoot.toLowerCase());
    expect(hex(result.withdrawalsRoot)).toBe(target.withdrawalsRoot.toLowerCase());
  });
});

describe("data receipts", () => {
  // vigil-1 batch 28 covers inbox entries 39 to 41; prove entry 40.
  const batch = [...vector.batches].sort((a, b) => a.batchIndex - b.batchIndex).at(-1)!;
  const payloadOf = (s: number) => hexToBytes(vector.entries.find((e) => e.sequence === s)!.payloadHex);
  const posts: ReceiptPost[] = vector.entries
    .filter((e) => e.sequence > batch.inboxStart && e.sequence <= batch.inboxEnd)
    .map((e) => ({ sequence: e.sequence, height: e.height, poster: e.poster, dataHash: hex(postedDataHash(hexToBytes(e.payloadHex))) }));
  const receipt = dataReceiptFrom({
    chainId: vector.chainId,
    rollupId: vector.rollupId,
    sequence: batch.inboxStart + 2,
    batch: { batchIndex: batch.batchIndex, inboxStart: batch.inboxStart, inboxEnd: batch.inboxEnd, dataHash: batch.dataHash, stateRoot: batch.stateRoot, status: batch.status },
    accFrom: vector.inboxAcc[String(batch.inboxStart)]!,
    posts,
    builtAt: "2026-11-19T10:00:00Z",
  });
  const copy = (): DataReceipt => JSON.parse(JSON.stringify(receipt)) as DataReceipt;

  it("folds a recorded batch's posts back to the data_hash the chain published", () => {
    const v = verifyDataReceipt(receipt, payloadOf(receipt.sequence));
    expect(v).toEqual({ valid: true, checks: { rangeComplete: true, postInRange: true, dataHashMatches: true, payloadMatches: true } });
  });

  it("fails if any post, the accumulator or the payload is changed", () => {
    const poster = copy();
    poster.posts[0]!.poster = "qor1someoneelse";
    expect(verifyDataReceipt(poster).checks.dataHashMatches).toBe(false);
    const digest = copy();
    digest.posts[2]!.dataHash = "00".repeat(32);
    expect(verifyDataReceipt(digest).valid).toBe(false);
    const acc = copy();
    acc.accFrom = "00".repeat(32);
    expect(verifyDataReceipt(acc).checks.dataHashMatches).toBe(false);
    const dropped = copy();
    dropped.posts.splice(0, 1);
    expect(verifyDataReceipt(dropped).checks.rangeComplete).toBe(false);
    expect(verifyDataReceipt(receipt, payloadOf(receipt.sequence + 1)).checks.payloadMatches).toBe(false);
  });

  it("refuses to prove an entry outside the batch", () => {
    expect(() => dataReceiptFrom({ ...receipt, sequence: batch.inboxEnd + 1 })).toThrow(/not in batch/);
  });

  it("proves a sealed payslip inside a batch, end to end", () => {
    const envelope = sealPayslip({ chainId, payslip, recipients: [employee, auditor].map(recipientOf) });
    const p: ReceiptPost[] = [
      { sequence: 1, height: 100, poster: "deposit:qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", dataHash: "22".repeat(32) },
      { sequence: 2, height: 101, poster: payslip.employer, dataHash: hex(postedDataHash(envelope)) },
    ];
    let acc: Uint8Array | string = EMPTY_INBOX_ACC;
    for (const x of p) acc = inboxAccumulate({ chainId, rollupId, prevAcc: acc, sequence: x.sequence, height: x.height, poster: x.poster, dataHash: x.dataHash });
    const dataHash = hex(inboxRangeHash({ chainId, rollupId, from: 0, to: 2, accFrom: EMPTY_INBOX_ACC, accTo: acc }));
    const r = dataReceiptFrom({
      chainId,
      rollupId,
      sequence: 2,
      batch: { batchIndex: 0, inboxStart: 0, inboxEnd: 2, dataHash, stateRoot: "33".repeat(32), status: "finalized" },
      accFrom: hex(EMPTY_INBOX_ACC),
      posts: p,
    });
    expect(verifyDataReceipt(r, envelope).valid).toBe(true);
    expect(openPayslip({ chainId, rollupId, envelope, keys: auditor })).toEqual(payslip);
  });
});

describe("recipient cards", async () => {
  // A throwaway test account (the BIP-39 test mnemonic): never funded, never used on chain.
  const account = await deriveUnifiedAccount("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", 0);
  const card = signCard(account, employee, chainId, new Date("2026-11-19T10:00:00Z"));
  const verify = (c = card, pq = account.pqc.publicKey, kem = employee.mlkemPublicKey) =>
    verifyRecipientCard({ card: c, chainId, address: account.cosmos, pqPublicKey: pq, mlkemPublicKey: kem });

  it("binds the account's X25519 key to its registered ML-KEM key, signed by both account keys", () => {
    const r = verify();
    expect(hex(r.x25519PublicKey!)).toBe(hex(employee.x25519PublicKey));
    expect(hex(r.mlkemPublicKey)).toBe(hex(employee.mlkemPublicKey));
  });

  it("is refused with another X25519 key, another ML-KEM key or another ML-DSA key", () => {
    expect(() => verify({ ...card, x25519PublicKey: hex(auditor.x25519PublicKey) })).toThrow();
    expect(() => verify(card, account.pqc.publicKey, auditor.mlkemPublicKey)).toThrow();
    const other = new Uint8Array(account.pqc.publicKey);
    other[100] = other[100]! ^ 1;
    expect(() => verify(card, other)).toThrow();
  });
});
