/**
 * The few live facts the landing page shows, read from the chain after first paint through the same
 * client the app's views use (the main bundle already prefetches it).
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import deployments from "../../../../deployments/diana.json";
import { ROLLUP } from "../config.ts";
import { ethCall } from "../evm.ts";

export interface Quorum {
  /** Watchtowers in the instant-exit vault's quorum. */
  members: number;
  /** How many of them must sign an exit. */
  threshold: number;
}

export interface Facts {
  /** The newest batch the chain keeps for the rollup. */
  latestIndex: number;
  latestStatus: string;
  /** Settlement anchors recorded for the rollup's layer. */
  anchors: number;
  /** The instant-exit vault's quorum, or undefined if the EVM endpoint did not answer. */
  quorum?: Quorum;
}

const VAULT = (deployments as { InstantExitVault?: { address: Hex } }).InstantExitVault;
const vaultAbi = parseAbi(["function quorum() view returns (address[])", "function threshold() view returns (uint256)"]);

/**
 * The vault's quorum, read as the Exits page reads it: free eth_calls to quorum() and threshold() on
 * the InstantExitVault (`call` is injectable for tests).
 */
export async function exitQuorum(call: (to: Hex, data: Hex) => Promise<Hex> = ethCall): Promise<Quorum> {
  if (!VAULT) throw new Error("deployments/diana.json has no InstantExitVault");
  const [members, threshold] = await Promise.all([
    call(VAULT.address, encodeFunctionData({ abi: vaultAbi, functionName: "quorum" })).then((data) => decodeFunctionResult({ abi: vaultAbi, functionName: "quorum", data })),
    call(VAULT.address, encodeFunctionData({ abi: vaultAbi, functionName: "threshold" })).then((data) => decodeFunctionResult({ abi: vaultAbi, functionName: "threshold", data })),
  ]);
  return { members: members.length, threshold: Number(threshold) };
}

export async function loadFacts(): Promise<Facts> {
  // The EVM read runs alongside the chain reads, and its failure only blanks its own line.
  const quorum = exitQuorum().catch(() => undefined);
  const { chain } = await import("../chain.ts");
  const { rdk } = await chain();
  const rollup = await rdk.rest.getRollup(ROLLUP);
  const [batches, anchors] = await Promise.all([rdk.rest.listBatches(ROLLUP), rdk.rest.getAnchors(rollup.layerId).catch(() => [])]);
  const latest = batches.reduce((a, b) => (Number(b.batchIndex) > Number(a.batchIndex) ? b : a), batches[0]!);
  return { latestIndex: Number(latest.batchIndex), latestStatus: String(latest.status), anchors: anchors.length, quorum: await quorum };
}
