/**
 * Sealed payslips: the confidential side of a public payment.
 *
 * A Vigil payroll payment is an ordinary qledger-v1 transfer, posted to the
 * inbox in the clear: its accounts and amount are public and the rollup
 * executes it. The payslip that explains it (the gross pay, deductions, the
 * period and a note) is sealed with QoreSeal in hybrid mode (ML-KEM-1024 +
 * X25519, AES-256-GCM) to the employee, the auditor and the employer, then
 * posted to the same inbox. The rollup treats it as a no-op: any payload that
 * is not a qledger transaction changes nothing, so the envelope rides inside
 * the batch, is committed by the batch's `data_hash`, and settles with it.
 *
 * Binding:
 * - QoreSeal's key derivation binds the chain id and the purpose
 *   (`vigil-payroll/v1`), which the envelope does not store.
 * - The additional data binds the rollup, so a payslip cannot be replayed into
 *   another rollup's inbox and still open.
 * - The payslip names its payment by the SHA-256 of the transfer's post
 *   (`postedDataHash`), which is the hash the chain keeps for that inbox entry.
 * - Envelopes are anonymous: recipient hints are left out, so the chain shows
 *   how many can read a payslip, but not who.
 */
import { QLEDGER_MAX_POST_BYTES } from "@qorechain/rdk";
import { open, parseEnvelope, seal, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";

export const PAYSLIP_PURPOSE = "vigil-payroll/v1";
const enc = new TextEncoder();
const dec = new TextDecoder();
export const sealedLaneAad = (rollupId: string): Uint8Array => enc.encode(`vigil/sealed-lane/v1|rollup:${rollupId}`);

export interface PayslipLine {
  label: string;
  /** Signed decimal uqor ("-25000000" for a deduction). */
  amountUqor: string;
}

export interface Payslip {
  v: 1;
  kind: "vigil/payslip";
  rollupId: string;
  /** Pay period, e.g. "2026-11". */
  period: string;
  /** L1 address of the employer, the account that posts the envelope. */
  employer: string;
  /** L1 address of the employee (whose card the payslip is sealed to). */
  employee: string;
  /** The public qledger transfer this payslip explains. */
  payment: {
    /** SHA-256 of the transfer's inbox post, hex: the entry's `data_hash` on chain. */
    postDataHash: string;
    fromAccount: string;
    toAccount: string;
    amountUqor: string;
  };
  lines: PayslipLine[];
  note?: string;
  issuedAt: string;
}

const UQOR = /^-?\d+$/;
const HEX32 = /^[0-9a-f]{64}$/;

/** Throws unless `p` is a well-formed payslip whose lines add up to the payment. */
export function checkPayslip(p: Payslip): Payslip {
  if (p.v !== 1 || p.kind !== "vigil/payslip") throw new Error("not a vigil/payslip v1");
  for (const f of ["rollupId", "period", "employer", "employee", "issuedAt"] as const) {
    if (typeof p[f] !== "string" || p[f] === "") throw new Error(`payslip.${f} is missing`);
  }
  const pay = p.payment;
  if (!pay || !HEX32.test(pay.postDataHash) || !HEX32.test(pay.fromAccount) || !HEX32.test(pay.toAccount) || !/^\d+$/.test(pay.amountUqor)) {
    throw new Error("payslip.payment needs postDataHash, fromAccount and toAccount (64 hex) and amountUqor");
  }
  if (!Array.isArray(p.lines) || p.lines.length === 0 || p.lines.some((l) => typeof l.label !== "string" || !UQOR.test(l.amountUqor))) {
    throw new Error("payslip.lines must be non-empty {label, amountUqor}");
  }
  const net = p.lines.reduce((s, l) => s + BigInt(l.amountUqor), 0n);
  if (net !== BigInt(pay.amountUqor)) throw new Error(`payslip lines add up to ${net} uqor, but the payment is ${pay.amountUqor}`);
  return p;
}

export function sealPayslip(input: { chainId: string; payslip: Payslip; recipients: SealRecipient[] }): Uint8Array {
  const payslip = checkPayslip(input.payslip);
  if (input.recipients.length === 0) throw new Error("a payslip needs at least one recipient");
  const envelope = seal({
    chainId: input.chainId,
    purpose: PAYSLIP_PURPOSE,
    recipients: input.recipients,
    plaintext: enc.encode(JSON.stringify(payslip)),
    aad: sealedLaneAad(payslip.rollupId),
    mode: "hybrid",
    anonymous: true,
  });
  if (envelope.length > QLEDGER_MAX_POST_BYTES) {
    throw new Error(`the envelope is ${envelope.length} bytes, over the ${QLEDGER_MAX_POST_BYTES}-byte post limit; use fewer recipients or a shorter note`);
  }
  return envelope;
}

/** Open a payslip sealed for `rollupId`. Throws if these keys cannot open it. */
export function openPayslip(input: { chainId: string; rollupId: string; envelope: Uint8Array; keys: SealKeyPair }): Payslip {
  const plaintext = open({
    chainId: input.chainId,
    purpose: PAYSLIP_PURPOSE,
    envelope: input.envelope,
    keys: input.keys,
    aad: sealedLaneAad(input.rollupId),
  });
  const p = checkPayslip(JSON.parse(dec.decode(plaintext)) as Payslip);
  if (p.rollupId !== input.rollupId) throw new Error(`the payslip names rollup ${p.rollupId}, not ${input.rollupId}`);
  return p;
}

/** Whether an inbox payload is a QoreSeal envelope (whoever it is for). */
export function isSealedEnvelope(payload: Uint8Array): boolean {
  try {
    parseEnvelope(payload);
    return true;
  } catch {
    return false;
  }
}
