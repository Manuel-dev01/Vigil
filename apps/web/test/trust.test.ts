/**
 * The trust page's logic, on what the node answered on 27 Nov 2026 (height ~10,859,790, read over the
 * websocket with abci_query; the vault by eth_call at EVM block 10,859,803), and on made-up values that
 * show each grade follows the chain rather than being written in.
 */
import { describe, expect, it } from "vitest";
import {
  FRAMEWORK,
  authority,
  exitCard,
  exitMargin,
  govModuleAddress,
  nameOf,
  parseAuthority,
  parseCircuit,
  parseGovVoting,
  parseRdkParams,
  parseRollup,
  rdkSwitches,
  rosette,
  seconds,
  stage0,
  stage1,
  stage2,
  wedgePath,
  type TrustFacts,
} from "../src/trust.ts";

// ---- the node's answers on 27 Nov 2026, trimmed to the fields the page reads
const GOV_VOTING = {
  voting_params: { voting_period: "14400s" },
  params: { voting_period: "14400s", expedited_voting_period: "3600s", max_deposit_period: "172800s", quorum: "0.334000000000000000", threshold: "0.500000000000000000" },
};
const DISABLE_LIST = { disabled_list: ["/cosmwasm.wasm.v1.MsgStoreCode"] };
const CIRCUIT_ACCOUNTS = {
  accounts: [{ address: "qor1hz907zyx2t9ax2fj0y8hhspc5rpnxuegrfzzr9", permissions: { level: "LEVEL_SOME_MSGS", limit_type_urls: ["/qorechain.crossvm.v1.MsgCrossVMCall"] } }],
  pagination: { next_key: null, total: "1" },
};
const AUTHORITY = { address: "qor10d07y265gmmuvt4z0w9aw880jnsr700jwfyxr3" };
const RDK_PARAMS = {
  params: { default_challenge_window: "3600", min_submitter_bond: "1000000000", posted_data_retention_blocks: "648000", finalized_batch_retention_blocks: "432000" },
};
const ROLLUP = {
  rollup: {
    rollup_id: "vigil-pay-1",
    creator: "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s",
    status: "active",
    escrow_balance: "9900000000",
    challenge_window_sec: "3600",
    proof_system: "fraud",
    sequencing: "based",
    execution_vm: "qledger-v1",
    deposit_pool: "2450000",
  },
};
const VAULT = {
  quorum: ["0x2684Af6bd37F2fd9cEA02B58D1725d69f3C928CA", "0x13f665a393a96c972606ACfAE757754443DCBa8f"],
  threshold: 2,
  lp: "0x16B7aB42fD64282931B1589f3e15720B7340f9c7",
  feeBps: 50,
  availableWei: 1_001_000_000_000_000_000n,
  totalOwedWei: 0n,
};

const today = (): TrustFacts => ({
  readAt: Date.UTC(2026, 10, 27, 16, 45),
  height: 10_859_790,
  rollup: parseRollup(ROLLUP),
  params: parseRdkParams(RDK_PARAMS),
  gov: parseGovVoting(GOV_VOTING),
  circuit: parseCircuit(DISABLE_LIST, CIRCUIT_ACCOUNTS),
  upgradeAuthority: { address: parseAuthority(AUTHORITY), isGov: true },
  vault: VAULT,
  errors: {},
});

const allText = (f: TrustFacts): string =>
  JSON.stringify([rosette(f), stage0(f), stage1(f), stage2(f), authority(f), exitCard(f)]);

describe("reading the node's answers", () => {
  it("parses durations as the gateway writes them", () => {
    expect(seconds("14400s")).toBe(14_400);
    expect(seconds("0.5s")).toBe(0.5);
    expect(seconds("3600")).toBe(3_600);
    expect(seconds("")).toBeUndefined();
    expect(seconds("4h")).toBeUndefined();
  });

  it("reads 27 Nov's governance, circuit breaker, rollup module and rollup", () => {
    const f = today();
    expect(f.gov).toEqual({ votingPeriodSec: 14_400, expeditedVotingPeriodSec: 3_600 });
    expect(f.rollup?.challengeWindowSec).toBe(3_600);
    expect(f.rollup?.depositPoolUqor).toBe("2450000");
    expect(f.rollup?.escrowUqor).toBe("9900000000");
    expect(f.params?.minSubmitterBondUqor).toBe("1000000000");
    expect(f.circuit?.disabled).toEqual(["/cosmwasm.wasm.v1.MsgStoreCode"]);
  });

  it("falls back to the older voting_params shape", () => {
    expect(parseGovVoting({ voting_params: { voting_period: "172800s" } })).toEqual({ votingPeriodSec: 172_800, expeditedVotingPeriodSec: undefined });
  });

  it("refuses answers with nothing in them", () => {
    expect(() => parseRollup({})).toThrow();
    expect(() => parseRdkParams({ params: {} })).toThrow();
    expect(() => parseGovVoting({})).toThrow();
    expect(() => parseCircuit({}, {})).toThrow();
    expect(() => parseAuthority({})).toThrow();
  });

  it("finds no circuit-breaker power over the rollup module on 27 Nov", () => {
    expect(rdkSwitches(today().circuit!)).toEqual({ disabled: [], holders: [] });
  });

  it("would name any account that can switch off rollup messages, and any switched off", () => {
    const c = parseCircuit(
      { disabled_list: ["/qorechain.rdk.v1.MsgExecuteWithdrawal", "/cosmwasm.wasm.v1.MsgStoreCode"] },
      {
        accounts: [
          { address: "qor1a", permissions: { level: "LEVEL_SOME_MSGS", limit_type_urls: ["/qorechain.rdk.v1.MsgChallengeBatch"] } },
          { address: "qor1b", permissions: { level: "LEVEL_SOME_MSGS", limit_type_urls: ["/qorechain.crossvm.v1.MsgCrossVMCall"] } },
          { address: "qor1c", permissions: { level: "LEVEL_ALL_MSGS" } },
          { address: "qor1d", permissions: { level: 3 } },
        ],
      },
    );
    const s = rdkSwitches(c);
    expect(s.disabled).toEqual(["/qorechain.rdk.v1.MsgExecuteWithdrawal"]);
    expect(s.holders.map((h) => h.address)).toEqual(["qor1a", "qor1c", "qor1d"]);
  });

  it("recognises the governance module's account as the upgrade authority", async () => {
    expect(await govModuleAddress()).toBe(AUTHORITY.address);
  });

  it("names the vault's quorum and LP from their EVM addresses", () => {
    expect(VAULT.quorum.map(nameOf)).toEqual(["Vigil watchtower-2 (US West)", "Vigil watchtower-3 (EU West)"]);
    expect(nameOf(VAULT.lp)).toBe("Vigil creator and sequencer (Keel)");
  });
});

describe("grading", () => {
  it("grades 27 Nov's rosette: two cautions, two greens, one red", () => {
    const r = rosette(today());
    expect(r.map((s) => [s.key, s.level])).toEqual([
      ["state", "caution"],
      ["da", "caution"],
      ["sequencer", "good"],
      ["proposer", "good"],
      ["exit", "risk"],
    ]);
    expect(r.find((s) => s.key === "exit")?.value).toBe("About 3 h, set by L1 governance");
    expect(r.find((s) => s.key === "exit")?.text).toContain("or none if the vote is expedited");
    expect(r.find((s) => s.key === "state")?.text).toContain("1 h as the node reports");
    expect(r.find((s) => s.key === "proposer")?.value).toBe("Self propose, with a 1,000 QOR bond");
  });

  it("measures the exit margin as the vote less the time an exit takes", () => {
    expect(exitMargin(today())).toEqual({ windowSec: 3_600, normal: 10_800, expedited: 0 });
    expect(exitMargin({ ...today(), gov: undefined })).toBeUndefined();
  });

  it("answers every Stage 0 question yes, one with a caveat", () => {
    const s = stage0(today());
    expect(s).toHaveLength(6);
    expect(s.filter((i) => i.status === "caveat")).toHaveLength(1);
    expect(s.every((i) => i.status === "met" || i.status === "caveat")).toBe(true);
  });

  it("finds three Stage 1 requirements not met on 27 Nov, and the open proposer set met", () => {
    const s = stage1(today());
    expect(s.map((i) => i.status)).toEqual(["not met", "not met", "not met", "met"]);
    expect(s[1]?.text).toContain("that leaves about 3 h");
  });

  it("follows the chain: a 5-day window and a 14-day vote would meet the two live Stage 1 items", () => {
    const f = today();
    f.rollup = { ...f.rollup!, challengeWindowSec: FRAMEWORK.stage1MinChallengeSec };
    f.gov = { votingPeriodSec: 14 * 86_400, expeditedVotingPeriodSec: undefined };
    const s = stage1(f);
    expect(s[0]?.status).toBe("met");
    expect(s[1]?.status).toBe("met");
    expect(rosette(f).find((x) => x.key === "state")?.level).toBe("good");
    expect(rosette(f).find((x) => x.key === "exit")?.level).toBe("caution");
  });

  it("counts the exit time against the vote: a 7-day vote over a 5-day window leaves 2 days, not enough", () => {
    const f = today();
    f.rollup = { ...f.rollup!, challengeWindowSec: FRAMEWORK.stage1MinChallengeSec };
    f.gov = { votingPeriodSec: 7 * 86_400, expeditedVotingPeriodSec: undefined };
    expect(stage1(f)[1]?.status).toBe("not met");
    expect(stage2(f)[1]?.status).toBe("not met");
  });

  it("says what it could not read instead of grading it", () => {
    const f: TrustFacts = { readAt: 0, errors: { gov: "timeout", rollup: "timeout", vault: "HTTP 503" } };
    const r = rosette(f);
    expect(r.find((s) => s.key === "exit")?.level).toBe("unknown");
    expect(r.find((s) => s.key === "state")?.text).toContain("timeout");
    expect(stage1(f)[0]?.status).toBe("unknown");
    expect(stage1(f)[1]?.status).toBe("unknown");
    expect(authority(f).find((p) => p.action === "Pay an exit early")?.who).toContain("not read: HTTP 503");
  });
});

describe("who can do what, and the exit card", () => {
  it("reads the 2-of-2 quorum, the LP and the governance vote into the map", () => {
    const a = authority(today());
    const who = (action: string) => a.find((p) => p.action === action)?.who ?? "";
    expect(who("Pay an exit early")).toBe("Both quorum keys, each by an ML-DSA-87 signature: Vigil watchtower-2 (US West) and Vigil watchtower-3 (EU West). Anyone may then submit the payment.");
    expect(who("Take liquidity out of the vault")).toContain("Vigil creator and sequencer (Keel)");
    expect(who("Reject a batch")).toContain("within 1 h of the batch");
    expect(who("Change the rollup's rules, or pause it")).toContain("4 h vote (1 h if expedited); the chain's upgrade authority is the governance module's account");
    expect(who("Switch off the rollup's messages without a vote")).toBe("No account holds that power, as the node reports. None of the rollup module's messages is switched off.");
  });

  it("puts the vault's free liquidity as the cap, and its fee", () => {
    const c = exitCard(today());
    expect(c.fields.find((x) => x.k === "Limits")?.v).toContain("1.001 QOR, as the EVM endpoint reports");
    expect(c.fields.find((x) => x.k === "Fee")?.v).toMatch(/^0\.5% /);
    expect(c.fields.find((x) => x.k === "Validated by")?.v).toMatch(/^A 2-of-2 committee of ML-DSA-87 keys/);
    expect(c.stolen[0]).toContain("(1.001 QOR now)");
  });

  it("makes no claim the repo's rules forbid", () => {
    expect(allText(today())).not.toMatch(/quantum-proof|quantum-safe|unbreakable|Stage [012] rollup|is Stage [012]/i);
  });
});

describe("the rosette's drawing", () => {
  it("draws closed ring segments, the first starting just right of the top", () => {
    const d = wedgePath(0, 5, 100, 22, 94);
    expect(d.startsWith("M 103.28 6.06 A 94 94 0 0 1")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(new Set([0, 1, 2, 3, 4].map((i) => wedgePath(i, 5, 100, 22, 94))).size).toBe(5);
  });
});
