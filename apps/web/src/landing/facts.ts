/**
 * The few live facts the landing page shows, read from the chain after first paint through the same
 * client the app's views use (the main bundle already prefetches it). The exit quorum comes from
 * QoreChain's EVM endpoint instead, and is read on its own.
 */
import type { RdkClient } from "@qorechain/rdk";
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
}

/** How long the landing page waits for the EVM endpoint before it shows a dash for the quorum. */
export const QUORUM_WAIT_MS = 5_000;

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

/**
 * The quorum for the landing page, or undefined if the EVM endpoint fails or has not answered within
 * `ms`. It is read apart from the node's facts, so a slow or failing EVM endpoint costs only its own line.
 */
export function loadQuorum(call: (to: Hex, data: Hex) => Promise<Hex> = ethCall, ms = QUORUM_WAIT_MS): Promise<Quorum | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, ms, undefined)));
  return Promise.race([exitQuorum(call).catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

/** The three REST reads the landing page makes of the node. */
export type NodeRest = Pick<RdkClient["rest"], "getRollup" | "listBatches" | "getAnchors">;
const nodeRest = async (): Promise<NodeRest> => (await (await import("../chain.ts")).chain()).rdk.rest;

/** The node's facts, read through the chain client (`rest` is injectable for tests). They never wait on the EVM endpoint. */
export async function loadFacts(rest: () => Promise<NodeRest> = nodeRest): Promise<Facts> {
  const r = await rest();
  const rollup = await r.getRollup(ROLLUP);
  const [batches, anchors] = await Promise.all([r.listBatches(ROLLUP), r.getAnchors(rollup.layerId).catch(() => [])]);
  const latest = batches.reduce((a, b) => (Number(b.batchIndex) > Number(a.batchIndex) ? b : a), batches[0]!);
  return { latestIndex: Number(latest.batchIndex), latestStatus: String(latest.status), anchors: anchors.length };
}
