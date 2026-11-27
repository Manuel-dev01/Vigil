/**
 * A payslip shared by link: the link's fragment, and the four checks a reader with no key runs. The
 * payslip is sealed in the test to throwaway keys; the transfer it names is the real ML-DSA-44-signed
 * transfer at inbox entry 26 of vigil-pay-1 (EVIDENCE 121), from the public inbox archive.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, postedDataHash } from "@qorechain/rdk";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";
import { openPayslipWithDataKey, payslipDataKey } from "@vigil/sealed/disclose";
import { transferOf } from "@vigil/sealed/inbox";
import { sealPayslip, type Payslip } from "@vigil/sealed/payslip";
import { disclosureChecks, disclosureVerdict, forgeFirstLine, parseShareFragment, qorOf, shareFragment, type NamedTransfer, type ReceiptState } from "../src/disclosure.ts";

const chainId = "qorechain-diana";
const rollupId = "vigil-pay-1";
const env = { chainId, rollupId };
const employer1 = "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws";

const archive = readFileSync(resolve(import.meta.dirname, "../../../data/inbox/vigil-pay-1.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { sequence: number; poster: string; payloadHex: string });
const entry26 = hexToBytes(archive.find((e) => e.sequence === 26)!.payloadHex);
const paid = transferOf(entry26, env)!;

const payslip: Payslip = {
  v: 1,
  kind: "vigil/payslip",
  rollupId,
  period: "2027-01 (test fixture)",
  employer: employer1,
  employee: "qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry",
  payment: { postDataHash: bytesToHex(postedDataHash(entry26)).toLowerCase(), fromAccount: paid.fromAccount, toAccount: paid.toAccount, amountUqor: paid.amountUqor },
  lines: [
    { label: "Gross pay", amountUqor: "120000" },
    { label: "Income tax", amountUqor: "-14000" },
    { label: "Pension", amountUqor: "-6000" },
  ],
  issuedAt: "2026-11-27T12:00:00Z",
};
const reader = generateSealKeys();
const envelope = sealPayslip({ chainId, payslip, recipients: [recipientOf(reader), recipientOf(generateSealKeys())] });
const dataKey = payslipDataKey({ chainId, rollupId, envelope, keys: reader });

const final: ReceiptState = { kind: "receipt", batchIndex: 24, status: "finalized", valid: true, onChain: true, finalized: true, detail: "" };
const transfer: NamedTransfer = { kind: "transfer", sequence: 26, ...paid };
const tones = (cs: { key: string; tone: string }[]) => Object.fromEntries(cs.map((c) => [c.key, c.tone]));

describe("share links", () => {
  it("carry the entry and the data key after the #, and read back", () => {
    const fragment = shareFragment(28, dataKey);
    expect(fragment).toMatch(/^#\/payslip\?entry=28&dk=[A-Za-z0-9_-]{43}$/);
    const back = parseShareFragment(fragment);
    expect(back).toEqual({ entry: 28, dataKey });
  });

  it("are ignored when absent, and explained when broken", () => {
    expect(parseShareFragment("#/payslip")).toBeUndefined();
    expect(parseShareFragment("")).toBeUndefined();
    expect(parseShareFragment("#/verify?batch=3&dk=abc")).toBeUndefined();
    const dk = shareFragment(28, dataKey).split("dk=")[1]!;
    expect(parseShareFragment(`#/payslip?entry=28`)).toEqual({ error: expect.stringMatching(/no key/) });
    expect(parseShareFragment(`#/payslip?dk=${dk}`)).toEqual({ error: expect.stringMatching(/no inbox entry/) });
    expect(parseShareFragment(`#/payslip?entry=0&dk=${dk}`)).toEqual({ error: expect.stringMatching(/no inbox entry/) });
    expect(parseShareFragment(`#/payslip?entry=2x&dk=${dk}`)).toEqual({ error: expect.stringMatching(/no inbox entry/) });
    expect(parseShareFragment(`#/payslip?entry=28&dk=${dk.slice(0, 30)}`)).toEqual({ error: expect.stringMatching(/cut short/) });
  });
});

describe("the four checks", () => {
  const opened = openPayslipWithDataKey({ rollupId, envelope, dataKey });

  it("all pass for a payslip opened from its link, against the real signed transfer it names", () => {
    expect(paid.amountUqor).toBe("100000");
    const cs = disclosureChecks({ entry: 28, payslip: opened, poster: employer1, receipt: final, transfer });
    expect(cs.map((c) => c.key)).toEqual(["settled", "poster", "transfer", "lines"]);
    expect(cs.every((c) => c.tone === "ok")).toBe(true);
    expect(cs[2]!.what).toBe("Matches public transfer #26: 0.1 QOR");
  });

  it("claim no more than the chain shows: who posted it, and not who owns the paying L2 account", () => {
    const cs = disclosureChecks({ entry: 28, payslip: opened, poster: employer1, receipt: final, transfer });
    expect(cs[1]!.why).toBe(`The chain says ${employer1} posted the envelope, and the payslip's employer field names the same account.`);
    expect(cs[2]!.why).toContain("The chain does not tie the paying L2 account to the employer");
    const v = disclosureVerdict(cs, false);
    expect(v.tone).toBe("ok");
    expect(v.text).toMatch(/^All four checks pass\. The amount paid is public and matches\./);
    expect(v.text).toContain("the chain does not tie that account to the employer");
  });

  it("'Forge it' changes one line, and exactly one check fails: the lines", () => {
    const forged = forgeFirstLine(opened);
    expect(forged.lines[0]!.amountUqor).toBe("1120000");
    expect(opened.lines[0]!.amountUqor).toBe("120000");
    const cs = disclosureChecks({ entry: 28, payslip: forged, poster: employer1, receipt: final, transfer });
    expect(tones(cs)).toEqual({ settled: "ok", poster: "ok", transfer: "ok", lines: "bad" });
    expect(cs[3]!.what).toBe("The lines add up to 1.1 QOR, not the 0.1 QOR paid");
    expect(disclosureVerdict(cs, true)).toEqual({ tone: "bad", text: "1 of 4 checks fails. The changed line no longer adds up to the public payment." });
  });

  it("never say all pass for a payslip changed in the page, even one whose lines a poster left 1 QOR short", () => {
    const short = { ...opened, lines: [{ label: "Advance repaid", amountUqor: "-880000" }, { label: "Fee", amountUqor: "-20000" }] };
    expect(tones(disclosureChecks({ entry: 28, payslip: short, poster: employer1, receipt: final, transfer })).lines).toBe("bad");
    const cs = disclosureChecks({ entry: 28, payslip: forgeFirstLine(short), poster: employer1, receipt: final, transfer });
    expect(cs.every((c) => c.tone === "ok")).toBe(true);
    expect(disclosureVerdict(cs, true)).toEqual({ tone: "warn", text: "Changed in this page, so this is not the payslip on chain, even though no check fails." });
  });

  it("fail the poster when someone else posted it", () => {
    expect(tones(disclosureChecks({ entry: 28, payslip: opened, poster: "qor1someoneelse", receipt: final, transfer })).poster).toBe("bad");
  });

  it("fail the transfer when it is missing, unsigned or different", () => {
    const t = (x: NamedTransfer) => tones(disclosureChecks({ entry: 28, payslip: opened, poster: employer1, receipt: final, transfer: x })).transfer;
    expect(t({ kind: "missing" })).toBe("bad");
    expect(t({ kind: "not a signed transfer", sequence: 26 })).toBe("bad");
    expect(t({ ...transfer, amountUqor: "200000" })).toBe("bad");
    expect(t({ ...transfer, toAccount: "cc".repeat(32) })).toBe("bad");
    // A real transfer that is not the one named: entry 23, 0.2 QOR (EVIDENCE 114).
    const entry23 = transferOf(hexToBytes(archive.find((e) => e.sequence === 23)!.payloadHex), env)!;
    expect(t({ kind: "transfer", sequence: 23, ...entry23 })).toBe("bad");
  });

  it("say where the receipt stands: final, not final, pruned, not batched, failing", () => {
    const r = (receipt: ReceiptState) => tones(disclosureChecks({ entry: 28, payslip: opened, poster: employer1, receipt, transfer })).settled;
    expect(r(final)).toBe("ok");
    expect(r({ ...final, finalized: false, status: "submitted" })).toBe("wait");
    expect(r({ ...final, valid: false })).toBe("bad");
    expect(r({ ...final, onChain: false })).toBe("bad");
    expect(r({ kind: "record pruned", consumed: 30 })).toBe("skip");
    expect(r({ kind: "not batched" })).toBe("wait");
    expect(r({ kind: "checking" })).toBe("wait");
  });

  it("tell 'could not check' apart from 'fails': a node that does not answer is not a failed payslip", () => {
    const receipt: ReceiptState = { kind: "unchecked", batchIndex: 24, detail: "Could not read batch 24 from the node: HTTP 429" };
    const cs = disclosureChecks({ entry: 28, payslip: opened, poster: employer1, receipt, transfer });
    expect(tones(cs)).toEqual({ settled: "skip", poster: "ok", transfer: "ok", lines: "ok" });
    expect(cs[0]!.what).toBe("Entry 28 is in batch 24, which could not be checked just now");
    expect(cs[0]!.why).toBe("Could not read batch 24 from the node: HTTP 429. That is not a failed check: reload the page to try again.");
    expect(disclosureVerdict(cs, false)).toEqual({ tone: "warn", text: "3 of 4 checks pass and none fails; 1 is still running or could not run." });
  });
});

describe("qorOf", () => {
  it("keeps every digit and the sign", () => {
    expect(qorOf(100_000n)).toBe("0.1 QOR");
    expect(qorOf(-14_000n)).toBe("-0.014 QOR");
    expect(qorOf(1_000_000n)).toBe("1 QOR");
    expect(qorOf(1_234_567_891n)).toBe("1,234.567891 QOR");
  });
});
