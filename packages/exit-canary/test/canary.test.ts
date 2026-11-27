/**
 * The exit canary's decisions, offline: the keys it refuses, its amount and daily budget, and the two
 * posts of a run, executed on a ledger with the RDK's own qledger-v1. The L2 key is a throwaway one made
 * here; nothing is sent.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { QLEDGER_DEPOSIT_POSTER_PREFIX, QledgerLedger, bytesToHex, decodeQledgerTx, encodeQledgerDeposit, executeQledger, hexToBech32, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { decodePayoutNotice } from "@vigil/qledger-watchtower";
import { DEFAULT_UQOR, MAX_PER_DAY, REFUSED, parseAmount, planCanary, refusal, tooSoon } from "../src/canary.ts";

const env = { chainId: "qorechain-diana", rollupId: "vigil-pay-1" };
const VAULT = "0x3a897802b62b052a102f55e021bc4668539c29b5";
const chain = {
  creator: "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s",
  quorum: ["0x2684Af6bd37F2fd9cEA02B58D1725d69f3C928CA", "0x13f665a393a96c972606ACfAE757754443DCBa8f"],
  lp: "0x16B7aB42fD64282931B1589f3e15720B7340f9c7",
};
const fresh = () => {
  const evm = `0x${randomBytes(20).toString("hex")}`;
  return { evm, cosmos: hexToBech32(evm, "qor") };
};

describe("exit canary: whose key", () => {
  it("refuses every team key in the README by address, including the keep-alive, the creator and employer-1", () => {
    expect(Object.keys(REFUSED)).toEqual(
      expect.arrayContaining([
        "qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l", // keep-alive
        "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", // creator
        "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws", // employer-1
        "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd", // watchtower-2
        "qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33", // watchtower-3
        "qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn", // exit relayer
      ]),
    );
    for (const cosmos of Object.keys(REFUSED)) expect(refusal({ cosmos, evm: "0x" + "00".repeat(20) }, chain)).toMatch(/needs a key of its own/);
  });

  it("refuses the creator, a quorum member and the LP as the chain reports them, and accepts a key of its own", () => {
    const creator = fresh();
    expect(refusal(creator, { ...chain, creator: creator.cosmos })).toMatch(/rollup's creator/);
    expect(refusal({ ...fresh(), evm: chain.quorum[1]!.toLowerCase() }, chain)).toMatch(/quorum/);
    expect(refusal({ ...fresh(), evm: chain.lp }, chain)).toMatch(/LP/);
    expect(refusal(fresh(), chain)).toBeUndefined();
  });
});

describe("exit canary: how much and how often", () => {
  it("takes 0.01 to 0.05 QOR, 0.02 by default", () => {
    expect(parseAmount("0.01")).toBe(10_000n);
    expect(parseAmount("0.05")).toBe(50_000n);
    expect(parseAmount("0.025")).toBe(25_000n);
    expect(DEFAULT_UQOR).toBe(20_000n);
    for (const bad of ["0.009", "0.051", "1", "0.5", "-0.02", "0.0200001", "abc"]) expect(() => parseAmount(bad)).toThrow(/--amount/);
  });

  it("runs at most twice in any 24 hours", () => {
    const now = 1_800_000_000;
    expect(MAX_PER_DAY).toBe(2);
    expect(tooSoon([], now)).toBeUndefined();
    expect(tooSoon([now - 3600], now)).toBeUndefined();
    expect(tooSoon([now - 3600, now - 7200], now)).toMatch(/2 canary exits in the last 24 hours/);
    expect(tooSoon([now - 86_401, now - 3600], now)).toBeUndefined();
  });
});

describe("exit canary: one run's posts", () => {
  const l2 = qledgerKeypairFromSeed(randomBytes(32));
  const payout = "0x" + "7b".repeat(20);
  const exitAddress = hexToBech32("0x" + "b5".repeat(20), "qor");
  const funded = (uqor: bigint) => {
    const ledger = new QledgerLedger();
    executeQledger(env, ledger, [{ height: 1n, poster: QLEDGER_DEPOSIT_POSTER_PREFIX + "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", payload: encodeQledgerDeposit(l2.accountId, uqor) }]);
    return ledger;
  };

  it("posts a payout notice for its own payout and an ML-DSA-44 withdrawal to that payout's exit address", () => {
    const ledger = funded(100_000n);
    const p = planCanary({ env, ledger, l2, vault: VAULT, payout, exitAddress, amount: 20_000n });
    expect(decodePayoutNotice(p.notice)).toEqual({ vault: VAULT, payout });
    const w = decodeQledgerTx(p.withdrawal)!;
    expect([w.recipient, w.amount, w.nonce]).toEqual([exitAddress, 20_000n, 0n]);
    expect(bytesToHex(w.publicKey)).toBe(bytesToHex(l2.publicKey));
    expect(p.withdrawalIndex).toBe(0n);
    // planning executes on a copy: the ledger it was given is unchanged
    expect(ledger.get(l2.accountId)).toMatchObject({ balance: 100_000n, nonce: 0n });
  });

  it("leaves the ledger as it was for the notice: it is a no-op entry for qledger-v1", () => {
    const ledger = funded(100_000n);
    const before = bytesToHex(ledger.root());
    const p = planCanary({ env, ledger, l2, vault: VAULT, payout, exitAddress, amount: 20_000n });
    const r = executeQledger(env, ledger, [{ height: 2n, poster: "", payload: p.notice }]);
    expect(r.withdrawals).toEqual([]);
    expect(bytesToHex(ledger.root())).toBe(before);
  });

  it("refuses a withdrawal the rollup would skip, and an amount outside its bounds", () => {
    expect(() => planCanary({ env, ledger: funded(5_000n), l2, vault: VAULT, payout, exitAddress, amount: 20_000n })).toThrow(/would skip/);
    expect(() => planCanary({ env, ledger: funded(1_000_000n), l2, vault: VAULT, payout, exitAddress, amount: 60_000n })).toThrow(/outside/);
  });
});
