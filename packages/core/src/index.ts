/**
 * Shared network configuration for Vigil. Testnet only.
 * Values were checked against the live chain on 2026-11-16.
 */
export const TESTNET = {
  chainId: "qorechain-diana",
  evmChainId: 9800,
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
} as const;

export type Network = typeof TESTNET;

/** EVM precompile addresses (active on testnet since v3.2.8). */
export const PRECOMPILES = {
  pqcVerify: "0x0000000000000000000000000000000000000a01",
  pqcKeyStatus: "0x0000000000000000000000000000000000000a02",
} as const;

/** Fetch JSON from the chain's REST API and fail loudly on non-2xx. */
export async function restGet<T>(path: string, base: string = TESTNET.rest): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
