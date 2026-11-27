/** The landing page's exit quorum, read from the vault rather than written into the page. */
import { encodeFunctionResult, getAddress, parseAbi, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import deployments from "../../../deployments/diana.json";
import { exitQuorum } from "../src/landing/facts.ts";

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
