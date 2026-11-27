/**
 * The payslip page's pieces, rendered to HTML: a payslip opened from a share link with its four checks,
 * the share box, and the line that says a salary left through an instant exit (or nothing at all).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InboxPost } from "@vigil/sealed/inbox";
import type { Payslip } from "@vigil/sealed/payslip";
import type { NamedTransfer, ReceiptState } from "../src/disclosure.ts";
import type { ExitSeen, SalaryPayment, TransferSeen } from "../src/salary-exit.ts";
import { DisclosedDoc, PayslipBody, SalaryExitLine, ShareBox } from "../src/views/PayslipParts.tsx";

const employer = "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws";
const to = "6b6c0bea".padEnd(64, "0");
const payslip: Payslip = {
  v: 1,
  kind: "vigil/payslip",
  rollupId: "vigil-pay-1",
  period: "2027-01",
  employer,
  employee: "qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry",
  payment: { postDataHash: "22".repeat(32), fromAccount: "aa".repeat(32), toAccount: to, amountUqor: "100000" },
  lines: [
    { label: "Gross pay", amountUqor: "120000" },
    { label: "Income tax", amountUqor: "-20000" },
  ],
  issuedAt: "2026-11-27T12:00:00Z",
};
const post: InboxPost = { sequence: 27, height: 1, poster: employer, payload: new Uint8Array(), dataHash: "33".repeat(32) };
const transfer: NamedTransfer = { kind: "transfer", sequence: 26, fromAccount: "aa".repeat(32), toAccount: to, amountUqor: "100000" };
const final: ReceiptState = { kind: "receipt", batchIndex: 24, status: "finalized", valid: true, onChain: true, finalized: true, detail: "" };
const href = `https://vigil.example/#/payslip?entry=27&dk=${"A".repeat(43)}`;
const noop = () => undefined;

const disclosed = (receipt: ReceiptState) =>
  renderToStaticMarkup(createElement(DisclosedDoc, { entry: 27, href, post, payslip, transfer, receipt, salaryLine: null, printing: false, onPrint: noop }));

describe("DisclosedDoc", () => {
  it("shows the payslip, its four checks and a verdict, with Forge it and the link for print", () => {
    const html = disclosed(final);
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html).toContain("All four checks pass.");
    expect(html).toContain("Matches public transfer #26: 0.1 QOR");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Forge it: add 1 QOR to the first line");
    expect(html).toContain(`<p class="note print-only share-print-link">${href.replace(/&/g, "&amp;")}</p>`);
  });

  it("says none fails while a check is still running, or when the node could not be asked", () => {
    expect(disclosed({ kind: "checking" })).toContain("3 of 4 checks pass and none fails; 1 is still running or could not run.");
    const html = disclosed({ kind: "unchecked", batchIndex: 24, detail: "Could not read batch 24 from the node: HTTP 429" });
    expect(html).toContain("3 of 4 checks pass and none fails");
    expect(html).toContain("which could not be checked just now");
    expect(html).not.toContain("fails against");
    expect(html).toContain('class="verdict warn"');
  });
});

describe("PayslipBody", () => {
  it("marks a line changed in the page, for sight and for screen readers", () => {
    const html = renderToStaticMarkup(createElement(PayslipBody, { payslip, poster: employer, changed: 0 }));
    expect(html).toContain('<tr class="pdoc-forged"><td>Gross pay<span class="sr-only"> (changed in this page)</span>');
    expect(html).toContain("is the poster");
  });

  it("shows the paying and paid L2 accounts, and that the chain does not tie the paying one to the employer", () => {
    const html = renderToStaticMarkup(createElement(PayslipBody, { payslip, poster: employer }));
    expect(html).toContain(`<dt>Paid from</dt><dd><code title="${"aa".repeat(32)}">aaaaaa…aaaaaa</code>`);
    expect(html).toContain("L2 account, as the payslip names it. The chain does not tie it to the employer.");
    expect(html).toContain(`<dt>Paid to</dt><dd><code title="${to}">6b6c0b…000000</code>`);
  });
});

describe("ShareBox", () => {
  it("shows the link with its warning, and draws the QR code only after it loads", () => {
    const html = renderToStaticMarkup(createElement(ShareBox, { id: "share-27", base: "https://vigil.example/", entry: 27, dataKey: new Uint8Array(32), onPrint: noop }));
    expect(html).toContain(`value="https://vigil.example/#/payslip?entry=27&amp;dk=${"A".repeat(43)}"`);
    expect(html).toContain("Anyone with this link can read this payslip, and it cannot be taken back.");
    expect(html).toContain('aria-label="Share link for this payslip"');
    expect(html).toContain("Drawing the QR code…");
  });
});

describe("SalaryExitLine", () => {
  const salary: SalaryPayment = { sequence: 26, toAccount: to, amountUqor: "100000" };
  const transfers: TransferSeen[] = [{ sequence: 26, toAccount: to, amountUqor: "100000" }];
  const exit: ExitSeen = { id: "0xab", batchIndex: 30, withdrawal: { entry: { sequence: 31, time: 1_000 }, amount: 100_000n, account: to, signatureValid: true }, fronted: { time: 1_016 } };
  const line = (exits: ExitSeen[] | undefined) => renderToStaticMarkup(createElement(SalaryExitLine, { salary, transfers, exits }));

  it("says when the salary left through an instant exit, and links to the exits", () => {
    const html = line([exit]);
    expect(html).toContain("This salary left the rollup through an instant exit, paid 16 s after the withdrawal.");
    expect(html).toContain('href="#/exits"');
  });

  it("shows nothing when no exit matches, or before the exits are read", () => {
    expect(line([])).toBe("");
    expect(line([{ ...exit, fronted: undefined }])).toBe("");
    expect(line(undefined)).toBe("");
  });

  it("says so when the exits could not be read, which is not 'no match'", () => {
    const html = renderToStaticMarkup(createElement(SalaryExitLine, { salary, transfers, exits: undefined, error: "HTTP 429" }));
    expect(html).toContain("the instant exits could not be read");
    expect(html).toContain('title="HTTP 429"');
    expect(renderToStaticMarkup(createElement(SalaryExitLine, { salary: undefined, transfers, exits: undefined, error: "HTTP 429" }))).toBe("");
  });
});
