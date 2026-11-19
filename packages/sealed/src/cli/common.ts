/** Shared bits of the sealed-lane commands. */
import "@vigil/core/net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRdkClient } from "@qorechain/rdk";
import { TESTNET } from "@vigil/core";

export { argValue } from "@vigil/keel/account";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const rest = createRdkClient({ network: "testnet" }).rest;
export const chainId = TESTNET.chainId;
export const restUrl = TESTNET.rest;

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export const fmtQor = (uqor: bigint | string | number) =>
  `${(Number(uqor) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} QOR`;
