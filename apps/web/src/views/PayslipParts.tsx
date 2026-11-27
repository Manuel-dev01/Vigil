/**
 * The pieces of the payslip page that show one payslip: its body, the share link with its QR code, the
 * line that says a salary left through an instant exit, and a payslip opened from a share link with its
 * four checks. Kept apart from Payslip.tsx (which reads the chain) so test/payslip-parts.test.ts can
 * render them.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { shareFragment } from "@vigil/sealed/disclose";
import type { InboxPost } from "@vigil/sealed/inbox";
import type { Payslip } from "@vigil/sealed/payslip";
import { KNOWN, qor, shortAddr, utcStamp } from "../config.ts";
import { disclosureChecks, forgeFirstLine, type NamedTransfer, type ReceiptState } from "../disclosure.ts";
import { salaryExit, type ExitSeen, type SalaryPayment, type TransferSeen } from "../salary-exit.ts";
import { Mark } from "../ui.tsx";

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

/** An account by its name in the page, or its address shortened. */
export const Name = ({ addr }: { addr: string }) => <span title={addr}>{KNOWN[addr] ? <strong>{KNOWN[addr]}</strong> : <code>{shortAddr(addr)}</code>}</span>;

/** A payslip's period, parties and lines, set like a printed one. `changed` marks a line forged in the page. */
export function PayslipBody({ payslip, poster, changed }: { payslip: Payslip; poster: string; changed?: number }) {
  const employerIsPoster = payslip.employer === poster;
  return (
    <>
      <h3 className="pdoc-t">{payslip.period}</h3>
      <dl className="kv">
        <dt>Employer</dt>
        <dd>
          {employerIsPoster ? (
            <>
              <Name addr={payslip.employer} />{" "}
              <span className="chip ok" title="The payslip's employer field names the account the chain says posted the envelope.">
                is the poster
              </span>
            </>
          ) : (
            <>
              <code title={payslip.employer}>{shortAddr(payslip.employer)}</code> <span className="chip bad">not the poster</span>
            </>
          )}
        </dd>
        <dt>Employee</dt>
        <dd>
          <Name addr={payslip.employee} />
        </dd>
        <dt>Issued</dt>
        <dd>{Number.isFinite(Date.parse(payslip.issuedAt)) ? utcStamp(Date.parse(payslip.issuedAt)) : payslip.issuedAt}</dd>
      </dl>
      {!employerIsPoster && (
        <p className="err" style={{ marginTop: 10 }}>
          This payslip says it is from <code>{payslip.employer}</code>, but the envelope was posted by <Name addr={poster} />. The employer field is written
          inside the sealed payslip and is not signed; only the poster is vouched for by the chain. Do not trust who it claims to be from.
        </p>
      )}
      <table className="pdoc-lines">
        <tbody>
          {payslip.lines.map((l, i) => (
            <tr key={i} className={i === changed ? "pdoc-forged" : undefined}>
              <td>
                {l.label}
                {i === changed && <span className="sr-only"> (changed in this page)</span>}
              </td>
              <td className="num">
                {qor(l.amountUqor.replace(/^-/, ""))}
                {l.amountUqor.startsWith("-") ? " (deducted)" : ""}
              </td>
            </tr>
          ))}
          <tr className="pdoc-paid">
            <td>Paid</td>
            <td className="num">{qor(payslip.payment.amountUqor)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

/** The QR code of a link, drawn as SVG. The encoder loads only now, in its own chunk. */
export function QrCode({ text }: { text: string }) {
  const [qr, setQr] = useState<{ size: number; d: string } | { error: string }>();
  useEffect(() => {
    let alive = true;
    setQr(undefined);
    import("../qr.ts").then(
      (m) => {
        if (alive) setQr(m.qrPath(text));
      },
      (e: unknown) => {
        if (alive) setQr({ error: errText(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [text]);
  if (!qr) return <span className="note">Drawing the QR code…</span>;
  if ("error" in qr) return <span className="note">The QR code could not be drawn: {qr.error}</span>;
  return (
    <svg className="qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="QR code of the share link" shapeRendering="crispEdges">
      {/* Dark on light whatever the theme, so any camera reads it. */}
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

/** The share link of one opened payslip (`base` is the page's address before the "#"): the link, a copy button, its QR code and a printable copy. */
export function ShareBox({ id, base, entry, dataKey, onPrint }: { id: string; base: string; entry: number; dataKey: Uint8Array; onPrint: () => void }) {
  const fragment = shareFragment(entry, dataKey);
  const link = `${base}${fragment}`;
  const [copied, setCopied] = useState<boolean>();
  const input = useRef<HTMLInputElement>(null);
  const copy = () => {
    const refused = () => {
      setCopied(false);
      input.current?.select();
    };
    if (!navigator.clipboard) refused();
    else void navigator.clipboard.writeText(link).then(() => setCopied(true), refused);
  };
  return (
    <div className="share-box" id={id}>
      <p className="share-warn">
        <strong>Anyone with this link can read this payslip, and it cannot be taken back.</strong> It opens this one payslip only: not your other payslips,
        and it cannot sign or spend. The key is after the "#", which browsers do not send to any server, but it stays in browser history and wherever the
        link is pasted.
      </p>
      <div className="row no-print">
        <input ref={input} type="text" readOnly value={link} aria-label="Share link for this payslip" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="note" role="status">
        {copied === false && "This browser did not allow copying: select the link and copy it."}
      </p>
      <div className="share-qr">
        <QrCode text={link} />
        <p className="note">
          Scan it, or open the link, to see this payslip and its four checks against the chain, with no key and no wallet.
          <span className="print-only share-print-link">{link}</span>
        </p>
      </div>
      <div className="row no-print">
        <a className="btn ghost" href={fragment}>
          See what they will see
        </a>
        <button type="button" className="btn ghost" onClick={onPrint}>
          Print with the QR code
        </button>
      </div>
    </div>
  );
}

/** "This salary left the rollup through an instant exit", when one matches (salary-exit.ts); otherwise nothing. */
export function SalaryExitLine({ salary, transfers, exits }: { salary: SalaryPayment | undefined; transfers: TransferSeen[] | undefined; exits: ExitSeen[] | undefined }) {
  if (!salary || !transfers || !exits) return null;
  const m = salaryExit(salary, transfers, exits);
  if (!m) return null;
  return (
    <p
      className="salary-exit"
      title={`Matched on the L2 account and amount: the ML-DSA-44-signed withdrawal at inbox entry ${m.withdrawalSequence} came from the account this payslip paid, for the same amount, after the payment, and the vault fronted it (batch ${m.batchIndex}), as the EVM endpoint reports. The chain itself does not link a withdrawal to a salary.`}
    >
      This salary left the rollup through an instant exit{m.seconds !== undefined ? `, paid ${m.seconds.toLocaleString("en-GB")} s after the withdrawal` : ""}.{" "}
      <a href="#/exits">See the exit →</a>
    </p>
  );
}

/** A payslip opened from a share link, with the four checks and a "Forge it" that makes one fail. */
export function DisclosedDoc({
  entry,
  href,
  post,
  payslip,
  transfer,
  receipt,
  salaryLine,
  printing,
  onPrint,
}: {
  entry: number;
  /** The page's address, printed with the payslip. */
  href: string;
  post: InboxPost;
  payslip: Payslip;
  transfer: NamedTransfer;
  receipt: ReceiptState;
  salaryLine: ReactNode;
  printing: boolean;
  onPrint: () => void;
}) {
  const [forged, setForged] = useState(false);
  useEffect(() => setForged(false), [entry, payslip]);
  const shown = forged ? forgeFirstLine(payslip) : payslip;
  const checks = disclosureChecks({ entry, payslip: shown, poster: post.poster, receipt, transfer });
  const failed = checks.filter((c) => c.tone === "bad").length;
  const passed = checks.filter((c) => c.tone === "ok").length;
  return (
    <article className={`pdoc${forged ? " forged" : ""}${printing ? " print-me" : ""}`} id="disclosed-payslip" aria-label={`Payslip in inbox entry ${entry}, shared with you`}>
      <header className="rdoc-top">
        <span>Payslip · shared with you</span>
        <span>entry {entry}</span>
      </header>
      <PayslipBody payslip={shown} poster={post.poster} {...(forged ? { changed: 0 } : {})} />
      <ul className="checks" aria-label="Checks against the chain">
        {checks.map((c) => (
          <li key={c.key}>
            <Mark tone={c.tone} />
            <span>
              <span className="what">{c.what}</span>
              <br />
              <span className="why">{c.why}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className={failed ? "verdict bad" : passed === checks.length ? "verdict ok" : "verdict warn"} role="status">
        {failed
          ? `${failed} of ${checks.length} checks fail.${forged ? " The forged line no longer adds up to the public payment." : ""}`
          : passed === checks.length
            ? "All four checks pass. The amount paid is public and matches; the lines are what the employer wrote."
            : `${passed} of ${checks.length} checks pass and none fails; the rest are still running or could not run.`}
      </p>
      {salaryLine}
      <div className="row forge-row no-print">
        <button className="forge" type="button" onClick={() => setForged((f) => !f)} aria-pressed={forged}>
          {forged ? "Undo the forgery" : "Forge it: add 1 QOR to the first line"}
        </button>
        <button type="button" className="btn ghost" onClick={onPrint}>
          Print
        </button>
      </div>
      {forged && (
        <p className="note">
          Changed in this page only; the envelope on chain is untouched. The chain anchors the total, not each line: a forger who changed two lines to
          keep the sum would pass this check, but could not change the amount paid, which must match the public transfer.
        </p>
      )}
      <p className="note print-only share-print-link">{href}</p>
      <p className={`rdoc-stamp pdoc-stamp ${forged ? "bad" : failed ? "bad" : "ok"}`}>{forged ? "Forged here" : "Opened · shared key"}</p>
    </article>
  );
}
