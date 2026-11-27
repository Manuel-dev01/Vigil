/**
 * A salary leaving the rollup through an instant exit, matched on the L2 account and amount. The first
 * test reads the public inbox archive of vigil-pay-1 through entry 27: no payslip's salary has left
 * through an exit there, so the payslip page does not even load the exits.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@qorechain/rdk";
import { transferOf } from "@vigil/sealed/inbox";
import { couldHaveLeft, leavingWithdrawals, salaryExit, withdrawalsIn, type ExitSeen, type SalaryPayment, type TransferSeen } from "../src/salary-exit.ts";

const env = { chainId: "qorechain-diana", rollupId: "vigil-pay-1" };
const posts = readFileSync(resolve(import.meta.dirname, "../../../data/inbox/vigil-pay-1.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { sequence: number; payloadHex: string })
  .filter((e) => e.sequence <= 27)
  .map((e) => ({ sequence: e.sequence, payload: hexToBytes(e.payloadHex) }));

describe("the payslips on chain (archive through entry 27)", () => {
  it("have no withdrawal that could be their salary leaving", () => {
    const withdrawals = withdrawalsIn(posts);
    // Entries 3, 12, 13, 17 and 20 are withdrawals; 17 and 20 are the two instant exits (EVIDENCE 86, 99).
    expect(withdrawals.map((w) => w.sequence)).toEqual([3, 12, 13, 17, 20]);
    // The payments of the November, December and January payslips (EVIDENCE 35, 114, 121).
    for (const seq of [5, 23, 26]) {
      const t = transferOf(posts.find((p) => p.sequence === seq)!.payload, env)!;
      expect(couldHaveLeft({ sequence: seq, toAccount: t.toAccount, amountUqor: t.amountUqor }, withdrawals)).toBe(false);
    }
  });
});

describe("salaryExit", () => {
  const account = "6b6c0bea".padEnd(64, "0");
  const salary: SalaryPayment = { sequence: 26, toAccount: account, amountUqor: "100000" };
  const transfers: TransferSeen[] = [
    { sequence: 23, toAccount: account, amountUqor: "200000" },
    { sequence: 26, toAccount: account, amountUqor: "100000" },
  ];
  const exit = (seq: number, over: Partial<NonNullable<ExitSeen["withdrawal"]>> = {}, fronted: ExitSeen["fronted"] | null = { time: 1_000_016 }): ExitSeen => ({
    id: `0x${seq}`,
    batchIndex: seq + 100,
    withdrawal: { entry: { sequence: seq, time: 1_000_000 }, amount: 100_000n, account, signatureValid: true, ...over },
    ...(fronted ? { fronted } : {}),
  });

  it("matches a later, fronted withdrawal of the same amount from the account paid, with the seconds it took", () => {
    expect(salaryExit(salary, transfers, [exit(30)])).toEqual({ exitId: "0x30", batchIndex: 130, withdrawalSequence: 30, seconds: 16 });
  });

  it("does not match a withdrawal before the payment, of another amount, from another account, unsigned or not fronted", () => {
    expect(salaryExit(salary, transfers, [exit(20)])).toBeUndefined();
    expect(salaryExit(salary, transfers, [exit(30, { amount: 99_999n })])).toBeUndefined();
    expect(salaryExit(salary, transfers, [exit(30, { account: "21285312".padEnd(64, "0") })])).toBeUndefined();
    expect(salaryExit(salary, transfers, [exit(30, { signatureValid: false })])).toBeUndefined();
    expect(salaryExit(salary, transfers, [exit(30, {}, null)])).toBeUndefined();
    expect(salaryExit(salary, transfers, [{ id: "0x1", batchIndex: 1 }])).toBeUndefined();
  });

  it("gives a withdrawal to the latest salary of that amount before it, and a salary its first exit", () => {
    const later = [...transfers, { sequence: 28, toAccount: account, amountUqor: "100000" }];
    expect(salaryExit(salary, later, [exit(30)])).toBeUndefined();
    expect(salaryExit({ ...salary, sequence: 28 }, later, [exit(30)])?.withdrawalSequence).toBe(30);
    expect(salaryExit(salary, later, [exit(27), exit(30)])?.withdrawalSequence).toBe(27);
    expect(salaryExit(salary, transfers, [exit(35), exit(30)])?.withdrawalSequence).toBe(30);
  });

  it("needs the payment itself among the transfers seen", () => {
    expect(salaryExit(salary, transfers.slice(0, 1), [exit(30)])).toBeUndefined();
  });

  it("leaves the seconds out when a time is unknown", () => {
    expect(salaryExit(salary, transfers, [exit(30, {}, { time: 0 })])?.seconds).toBeUndefined();
    expect(salaryExit(salary, transfers, [exit(30, { entry: { sequence: 30, time: 0 } })])?.seconds).toBeUndefined();
  });

  it("lists the withdrawals worth loading the exits for: from the account paid, for the amount paid, after it", () => {
    const ws = [
      { sequence: 20, account, amount: 100_000n },
      { sequence: 30, account, amount: 100_000n },
      { sequence: 31, account, amount: 99_999n },
      { sequence: 32, account: "21285312".padEnd(64, "0"), amount: 100_000n },
      { sequence: 33, account, amount: 100_000n },
    ];
    expect(leavingWithdrawals(salary, ws).map((w) => w.sequence)).toEqual([30, 33]);
    expect(couldHaveLeft(salary, ws)).toBe(true);
    expect(couldHaveLeft(salary, ws.slice(0, 1))).toBe(false);
  });

  it("compares accounts in any hex case", () => {
    expect(salaryExit({ ...salary, toAccount: account.toUpperCase() }, transfers, [exit(30, { account: account.toUpperCase() })])?.withdrawalSequence).toBe(30);
  });
});
