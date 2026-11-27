/**
 * A payslip shared by link, and the checks a reader with no key or wallet can run on it.
 *
 * The link is #/payslip?entry=<n>&dk=<data key>. Browsers never send the part after "#" to the server,
 * so the key reaches only the page. The page reads entry n from the transaction that posted it, opens it
 * with the data key (@vigil/sealed/disclose) and checks it against the chain:
 * 1. a data receipt puts the envelope in a final batch;
 * 2. the account that posted it is the employer the payslip names;
 * 3. the public ML-DSA-44 transfer it names has its accounts and amount;
 * 4. its lines add up to the amount paid.
 * The functions here are pure, so test/disclosure.test.ts runs them offline.
 */
import { dataKeyFromText } from "@vigil/sealed/disclose";
import type { Payslip } from "@vigil/sealed/payslip";

/** The link's fragment for entry `entry` and its data key (the CLI prints the same, `inbox --share`). */
export { shareFragment } from "@vigil/sealed/disclose";

/**
 * The entry and data key in a #/payslip link; undefined when the link carries neither, and an error
 * when it carries a broken one (a link cut short in a message, say).
 */
export function parseShareFragment(hash: string): { entry: number; dataKey: Uint8Array } | { error: string } | undefined {
  if (!hash.startsWith("#/payslip")) return undefined;
  const q = hash.indexOf("?");
  const params = new URLSearchParams(q < 0 ? "" : hash.slice(q + 1));
  const entryText = params.get("entry");
  const dk = params.get("dk");
  if (entryText === null && dk === null) return undefined;
  const entry = Number(entryText);
  if (entryText === null || !/^\d+$/.test(entryText) || !Number.isSafeInteger(entry) || entry < 1) return { error: "This link names no inbox entry. Ask for the link again." };
  if (dk === null) return { error: `This link names entry ${entry} but carries no key. Ask for the link again.` };
  try {
    return { entry, dataKey: dataKeyFromText(dk) };
  } catch {
    return { error: `This link's key is not a whole key (it should be 43 characters after "dk="). The link may have been cut short. Ask for it again.` };
  }
}

export type CheckTone = "ok" | "bad" | "wait" | "skip";

export interface DisclosureCheck {
  key: "settled" | "poster" | "transfer" | "lines";
  tone: CheckTone;
  what: string;
  why: string;
}

/** Where the envelope's data receipt stands (Payslip.tsx works this out for every envelope in the inbox). */
export type ReceiptState =
  | { kind: "receipt"; batchIndex: number; status: string; valid: boolean; onChain: boolean; finalized: boolean; detail: string }
  | { kind: "record pruned"; consumed: number }
  | { kind: "not batched" }
  | { kind: "checking" };

/** The public transfer the payslip names: not in the inbox, not a validly signed transfer, or what it says. */
export type NamedTransfer =
  | { kind: "missing" }
  | { kind: "not a signed transfer"; sequence: number }
  | { kind: "transfer"; sequence: number; fromAccount: string; toAccount: string; amountUqor: string };

const UQOR = 1_000_000n;
/** uqor as QOR, every digit kept: "0.1 QOR", "-0.014 QOR". */
export function qorOf(uqor: bigint): string {
  const neg = uqor < 0n;
  const n = neg ? -uqor : uqor;
  const frac = (n % UQOR).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${(n / UQOR).toLocaleString("en-US")}${frac ? `.${frac}` : ""} QOR`;
}

const shortHex = (h: string): string => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);

/** The four checks of a disclosed payslip, in order. Exactly one fails when only a line is changed. */
export function disclosureChecks(input: { entry: number; payslip: Payslip; poster: string; receipt: ReceiptState; transfer: NamedTransfer }): DisclosureCheck[] {
  const { entry, payslip: p, poster, receipt: r, transfer: t } = input;
  const out: DisclosureCheck[] = [];

  // 1. The envelope is in a final batch.
  const receiptWhy =
    "A data receipt, rebuilt here from every inbox entry in the batch's range, folds this exact envelope into the batch's data commitment; the batch record, as the node reports it, must carry the same commitment.";
  if (r.kind === "checking") out.push({ key: "settled", tone: "wait", what: `Checking which batch holds entry ${entry}…`, why: receiptWhy });
  else if (r.kind === "not batched") out.push({ key: "settled", tone: "wait", what: `Entry ${entry} is not in a batch yet`, why: "The sequencer has not batched it. Look again in a few minutes." });
  else if (r.kind === "record pruned")
    out.push({
      key: "settled",
      tone: "skip",
      what: `Entry ${entry} was batched, but the batch record is gone`,
      why: `The inbox shows entries up to ${r.consumed} consumed by batches, so this one was batched. The chain no longer keeps that batch's record, so its data receipt cannot be checked here.`,
    });
  else if (r.valid && r.onChain && r.finalized) out.push({ key: "settled", tone: "ok", what: `Entry ${entry} is in batch ${r.batchIndex}, which is final`, why: receiptWhy });
  else if (r.valid && r.onChain) out.push({ key: "settled", tone: "wait", what: `Entry ${entry} is in batch ${r.batchIndex}, not final yet (${r.status})`, why: receiptWhy });
  else out.push({ key: "settled", tone: "bad", what: `The data receipt for entry ${entry} fails against batch ${r.batchIndex}`, why: r.detail || receiptWhy });

  // 2. The poster is the employer the payslip names.
  out.push(
    p.employer === poster
      ? { key: "poster", tone: "ok", what: "Posted by the employer it names", why: `The chain says ${poster} posted the envelope (a hybrid-signed transaction), and the payslip's employer field names the same account.` }
      : {
          key: "poster",
          tone: "bad",
          what: "Not posted by the employer it names",
          why: `The payslip says it is from ${p.employer}, but ${poster} posted it. The employer field is written inside the payslip; only the poster is vouched for by the chain.`,
        },
  );

  // 3. The public transfer has the payslip's accounts and amount.
  if (t.kind === "missing")
    out.push({ key: "transfer", tone: "bad", what: "The transfer it names is not in the inbox", why: `No inbox entry has the hash ${shortHex(p.payment.postDataHash)} that the payslip gives for its payment.` });
  else if (t.kind === "not a signed transfer")
    out.push({ key: "transfer", tone: "bad", what: `Entry ${t.sequence} is not a validly signed transfer`, why: "The payslip names it as its payment, but it is not a qledger transfer whose ML-DSA-44 signature verifies." });
  else {
    const diffs = [
      t.fromAccount !== p.payment.fromAccount && "the paying account",
      t.toAccount !== p.payment.toAccount && "the paid account",
      t.amountUqor !== p.payment.amountUqor && `the amount (${qorOf(BigInt(t.amountUqor))} on chain)`,
    ].filter((d): d is string => !!d);
    out.push(
      diffs.length === 0
        ? {
            key: "transfer",
            tone: "ok",
            what: `Matches public transfer #${t.sequence}: ${qorOf(BigInt(t.amountUqor))}`,
            why: "Same paying account, same paid account, same amount, and the transfer's ML-DSA-44 signature verifies in this browser. The amount paid is public; the payslip explains it.",
          }
        : { key: "transfer", tone: "bad", what: `Does not match public transfer #${t.sequence}`, why: `It differs in ${diffs.join(", ")}.` },
    );
  }

  // 4. The lines add up to the amount paid.
  const total = p.lines.reduce((s, l) => s + BigInt(l.amountUqor), 0n);
  const paid = BigInt(p.payment.amountUqor);
  out.push(
    total === paid
      ? { key: "lines", tone: "ok", what: `The lines add up to the ${qorOf(paid)} paid`, why: `${p.lines.length} lines, deductions included. The lines are what the employer wrote: encrypted, not signed.` }
      : { key: "lines", tone: "bad", what: `The lines add up to ${qorOf(total)}, not the ${qorOf(paid)} paid`, why: "A payslip's lines must add up to the amount of its public transfer. Someone changed a line." },
  );
  return out;
}

/** The payslip with its first line raised by 1 QOR, as "Forge it" shows: only the lines check should fail. */
export function forgeFirstLine(p: Payslip): Payslip {
  const [first, ...rest] = p.lines;
  if (!first) return p;
  return { ...p, lines: [{ ...first, amountUqor: (BigInt(first.amountUqor) + UQOR).toString() }, ...rest] };
}
