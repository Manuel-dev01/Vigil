/** The landing page's live facts: the exit quorum read from the vault, and the node's facts never waiting on it. */
import { encodeFunctionResult, getAddress, parseAbi, toFunctionSelector, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import deployments from "../../../deployments/diana.json";
import { ethCall } from "../src/evm.ts";
import { QUORUM_WAIT_MS, exitQuorum, loadFacts, loadQuorum, type NodeRest } from "../src/landing/facts.ts";

// An EVM endpoint that never answers (stalled, or holding requests back).
vi.mock("../src/evm.ts", () => ({ ethCall: vi.fn(() => new Promise<never>(() => undefined)) }));

const abi = parseAbi(["function quorum() view returns (address[])", "function threshold() view returns (uint256)"]);
const VAULT = getAddress(deployments.InstantExitVault.address);
// watchtower-2 and watchtower-3, as the deployed vault returns them (cast call, 27 Nov 2026).
const MEMBERS: Hex[] = ["0x2684Af6bd37F2fd9cEA02B58D1725d69f3C928CA", "0x13f665a393a96c972606ACfAE757754443DCBa8f"];

/** A fake EVM endpoint holding one vault with the given quorum and threshold. */
function vault(members: Hex[], threshold: bigint) {
  const calls: { to: Hex; data: Hex }[] = [];
  const call = async (to: Hex, data: Hex): Promise<Hex> => {
    calls.push({ to, data });
    if (getAddress(to) !== VAULT) throw new Error(`no contract at ${to}`);
    if (data.startsWith(toFunctionSelector("quorum()"))) return encodeFunctionResult({ abi, functionName: "quorum", result: members });
    if (data.startsWith(toFunctionSelector("threshold()"))) return encodeFunctionResult({ abi, functionName: "threshold", result: threshold });
    throw new Error(`unknown call ${data}`);
  };
  return { call, calls };
}

describe("exitQuorum", () => {
  it("reads quorum() and threshold() from the deployed InstantExitVault", async () => {
    const v = vault(MEMBERS, 2n);
    expect(await exitQuorum(v.call)).toEqual({ members: 2, threshold: 2 });
    expect(v.calls).toHaveLength(2);
    expect(v.calls.every((c) => getAddress(c.to) === VAULT)).toBe(true);
  });

  it("reports what the vault says, not a number in the page", async () => {
    const three: Hex[] = [...MEMBERS, "0x0000000000000000000000000000000000000003"];
    expect(await exitQuorum(vault(three, 2n).call)).toEqual({ members: 3, threshold: 2 });
  });

  it("fails rather than guessing when the endpoint does not answer", async () => {
    await expect(exitQuorum(async () => Promise.reject(new Error("EVM RPC answered HTTP 429")))).rejects.toThrow(/429/);
  });
});

/** A node with batches 0 to 25 (all final) and 25 anchors, as the RDK's REST client returns them. */
const node = {
  getRollup: async () => ({ rollupId: "vigil-pay-1", layerId: "vigil-pay-1" }),
  listBatches: async () => Array.from({ length: 26 }, (_, i) => ({ batchIndex: i, status: "finalized" })),
  getAnchors: async () => Array.from({ length: 25 }, (_, i) => ({ layerHeight: i })),
} as unknown as NodeRest;

describe("loadQuorum", () => {
  afterEach(() => vi.useRealTimers());

  it("gives the vault's quorum when the endpoint answers", async () => {
    expect(await loadQuorum(vault(MEMBERS, 2n).call)).toEqual({ members: 2, threshold: 2 });
  });

  it("gives undefined, for a dash, when the endpoint fails", async () => {
    expect(await loadQuorum(async () => Promise.reject(new Error("EVM RPC answered HTTP 429")))).toBeUndefined();
  });

  it("gives undefined after the wait when the endpoint never answers", async () => {
    vi.useFakeTimers();
    let done = false;
    const q = loadQuorum().then((x) => ((done = true), x));
    await vi.advanceTimersByTimeAsync(QUORUM_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await q).toBeUndefined();
    expect(vi.mocked(ethCall)).toHaveBeenCalled();
  });
});

describe("loadFacts", () => {
  it("reads the node's facts without waiting on a stalled EVM endpoint", async () => {
    vi.useFakeTimers();
    try {
      const q = loadQuorum();
      // No timer is advanced: the facts must arrive while the quorum is still waiting.
      expect(await loadFacts(async () => node)).toEqual({ latestIndex: 25, latestStatus: "finalized", anchors: 25 });
      let done = false;
      void q.then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts no anchors when the node cannot list them", async () => {
    const r = await loadFacts(async () => ({ ...node, getAnchors: async () => Promise.reject(new Error("timeout")) }));
    expect(r).toEqual({ latestIndex: 25, latestStatus: "finalized", anchors: 0 });
  });
});
