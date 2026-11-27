/**
 * Disclosing one payslip by its data key, offline. Every envelope here is sealed in the test to
 * throwaway keys; the archived envelopes from the chain are only tried with a key made at run time.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@qorechain/rdk";
import { generateSealKeys, recipientOf, seal, sealKeysFromSeed, toBase64Url } from "@qorechain/qoreseal";
import { dataKeyFromText, dataKeyToText, openPayslipWithDataKey, payslipDataKey } from "../src/disclose.ts";
import { PAYSLIP_PURPOSE, isSealedEnvelope, openPayslip, sealPayslip, sealedLaneAad, type Payslip } from "../src/payslip.ts";

const chainId = "qorechain-diana";
const rollupId = "vigil-pay-1";
const seedKeys = (n: number) => sealKeysFromSeed(new Uint8Array(32).fill(n));
const [employee, auditor, employer, outsider] = [11, 12, 13, 14].map(seedKeys) as [ReturnType<typeof seedKeys>, ReturnType<typeof seedKeys>, ReturnType<typeof seedKeys>, ReturnType<typeof seedKeys>];
const enc = new TextEncoder();

const payslip: Payslip = {
  v: 1,
  kind: "vigil/payslip",
  rollupId,
  period: "2027-01",
  employer: "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws",
  employee: "qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry",
  payment: { postDataHash: "22".repeat(32), fromAccount: "aa".repeat(32), toAccount: "bb".repeat(32), amountUqor: "100000" },
  lines: [
    { label: "Gross pay", amountUqor: "120000" },
    { label: "Income tax", amountUqor: "-14000" },
    { label: "Pension", amountUqor: "-6000" },
  ],
  note: "Test fixture, sealed to throwaway keys",
  issuedAt: "2026-11-27T12:00:00Z",
};

const recipients = [employee, auditor, employer];
const envelope = sealPayslip({ chainId, payslip, recipients: recipients.map(recipientOf) });

describe("payslipDataKey", () => {
  it("gives every recipient the same 32-byte key, and that key alone opens what openPayslip opens", () => {
    const keys = recipients.map((k) => payslipDataKey({ chainId, rollupId, envelope, keys: k }));
    for (const k of keys) {
      expect(k.length).toBe(32);
      expect(k).toEqual(keys[0]);
    }
    for (const k of recipients) {
      const dataKey = payslipDataKey({ chainId, rollupId, envelope, keys: k });
      expect(openPayslipWithDataKey({ rollupId, envelope, dataKey })).toEqual(openPayslip({ chainId, rollupId, envelope, keys: k }));
    }
  });

  it("refuses a key the envelope is not sealed to, and another chain or rollup", () => {
    expect(() => payslipDataKey({ chainId, rollupId, envelope, keys: outsider })).toThrow(/no entry/);
    expect(() => payslipDataKey({ chainId, rollupId, envelope, keys: generateSealKeys() })).toThrow(/no entry/);
    expect(() => payslipDataKey({ chainId: "qorechain-mainnet", rollupId, envelope, keys: employee })).toThrow(/no entry/);
    expect(() => payslipDataKey({ chainId, rollupId: "vigil-1", envelope, keys: employee })).toThrow(/no entry/);
  });

  it("matches openPayslip on a fresh random key and on envelopes with hints and without X25519", () => {
    const fresh = generateSealKeys();
    const withHints = seal({ chainId, purpose: PAYSLIP_PURPOSE, recipients: [recipientOf(auditor), recipientOf(fresh)], plaintext: enc.encode(JSON.stringify(payslip)), aad: sealedLaneAad(rollupId), mode: "hybrid" });
    const mlkemOnly = seal({ chainId, purpose: PAYSLIP_PURPOSE, recipients: [{ mlkemPublicKey: fresh.mlkemPublicKey }], plaintext: enc.encode(JSON.stringify(payslip)), aad: sealedLaneAad(rollupId), mode: "mlkem", anonymous: true });
    for (const env of [withHints, mlkemOnly]) {
      const dataKey = payslipDataKey({ chainId, rollupId, envelope: env, keys: fresh });
      expect(openPayslipWithDataKey({ rollupId, envelope: env, dataKey })).toEqual(openPayslip({ chainId, rollupId, envelope: env, keys: fresh }));
    }
  });
});

describe("openPayslipWithDataKey", () => {
  const dataKey = payslipDataKey({ chainId, rollupId, envelope, keys: employee });

  it("opens only its own envelope, only for its rollup, and not with a key one bit off", () => {
    const other = sealPayslip({ chainId, payslip: { ...payslip, period: "2027-02" }, recipients: recipients.map(recipientOf) });
    expect(() => openPayslipWithDataKey({ rollupId, envelope: other, dataKey })).toThrow(/does not open/);
    expect(() => openPayslipWithDataKey({ rollupId: "vigil-1", envelope, dataKey })).toThrow(/does not open/);
    const flipped = dataKey.slice();
    flipped[0]! ^= 1;
    expect(() => openPayslipWithDataKey({ rollupId, envelope, dataKey: flipped })).toThrow(/does not open/);
    expect(() => openPayslipWithDataKey({ rollupId, envelope, dataKey: dataKey.slice(0, 31) })).toThrow(/does not open/);
  });

  it("fails if one byte of the envelope changes", () => {
    const tampered = envelope.slice();
    tampered[tampered.length - 20]! ^= 1;
    expect(() => openPayslipWithDataKey({ rollupId, envelope: tampered, dataKey })).toThrow(/does not open/);
  });

  it("leaves the lines-add-up check to the disclosure: it opens a payslip whose lines do not add up, which openPayslip refuses", () => {
    const off: Payslip = { ...payslip, lines: [{ label: "Gross pay", amountUqor: "999999" }] };
    const fresh = generateSealKeys();
    // Sealed with QoreSeal directly: sealPayslip itself refuses lines that do not add up.
    const env = seal({ chainId, purpose: PAYSLIP_PURPOSE, recipients: [recipientOf(fresh)], plaintext: enc.encode(JSON.stringify(off)), aad: sealedLaneAad(rollupId), anonymous: true });
    const key = payslipDataKey({ chainId, rollupId, envelope: env, keys: fresh });
    expect(openPayslipWithDataKey({ rollupId, envelope: env, dataKey: key })).toEqual(off);
    expect(() => openPayslip({ chainId, rollupId, envelope: env, keys: fresh })).toThrow(/add up/);
  });

  it("refuses a payload that is not a payslip, or a payslip for another rollup", () => {
    const fresh = generateSealKeys();
    const notPayslip = seal({ chainId, purpose: PAYSLIP_PURPOSE, recipients: [recipientOf(fresh)], plaintext: enc.encode('{"hello":1}'), aad: sealedLaneAad(rollupId) });
    expect(() => openPayslipWithDataKey({ rollupId, envelope: notPayslip, dataKey: payslipDataKey({ chainId, rollupId, envelope: notPayslip, keys: fresh }) })).toThrow(/not a vigil\/payslip/);
    const elsewhere = seal({ chainId, purpose: PAYSLIP_PURPOSE, recipients: [recipientOf(fresh)], plaintext: enc.encode(JSON.stringify({ ...payslip, rollupId: "vigil-1" })), aad: sealedLaneAad(rollupId) });
    expect(() => openPayslipWithDataKey({ rollupId, envelope: elsewhere, dataKey: payslipDataKey({ chainId, rollupId, envelope: elsewhere, keys: fresh }) })).toThrow(/names rollup vigil-1/);
  });
});

describe("data keys as link text", () => {
  it("is 43 characters of base64url and round-trips", () => {
    const key = payslipDataKey({ chainId, rollupId, envelope, keys: auditor });
    const text = dataKeyToText(key);
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(text).toBe(toBase64Url(key));
    expect(dataKeyFromText(text)).toEqual(key);
  });

  it("refuses anything else", () => {
    const good = dataKeyToText(new Uint8Array(32).fill(7));
    for (const bad of ["", good.slice(1), `${good}A`, `${good}=`, `${good.slice(1)}+`, `${good.slice(1)}/`, `${good.slice(1)} `]) {
      expect(() => dataKeyFromText(bad)).toThrow(/43 characters/);
    }
    expect(() => dataKeyToText(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("the payslips on chain, tried with a key made now", () => {
  // Entries 6, 24 and 27 of vigil-pay-1 (EVIDENCE 37, 115, 122), from the public inbox archive.
  const archive = readFileSync(resolve(import.meta.dirname, "../../../data/inbox/vigil-pay-1.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { sequence: number; payloadHex: string });
  const onChain = archive.filter((e) => e.sequence <= 27 && isSealedEnvelope(hexToBytes(e.payloadHex)));

  it("finds the three sealed payslips, and a random key opens 0 of them", () => {
    expect(onChain.map((e) => e.sequence)).toEqual([6, 24, 27]);
    const random = generateSealKeys();
    for (const e of onChain) {
      const env = hexToBytes(e.payloadHex);
      expect(() => openPayslip({ chainId, rollupId, envelope: env, keys: random })).toThrow();
      expect(() => payslipDataKey({ chainId, rollupId, envelope: env, keys: random })).toThrow(/no entry/);
    }
  });
});
