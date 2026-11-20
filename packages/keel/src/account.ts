/**
 * Load an operator account from a .env file without printing anything secret.
 *
 * The file holds either QORE_MNEMONIC, or PRIVATE_KEY (0x + 64 hex) together
 * with QORE_PQC_RECOVERY_CODE (QRC1-…). Values stay in memory only.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveUnifiedAccount, isValidRecoveryCode, unifiedAccountFromSeed, type UnifiedAccount } from "@qorechain/sdk";

export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(resolve(path), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined && m[2] !== "") out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").trim();
  }
  return out;
}

export async function loadOperator(envPath: string): Promise<UnifiedAccount> {
  return loadOperatorFrom(readEnvFile(envPath));
}

/**
 * The same, from a map of variables: a hosted Keel reads them from its process
 * environment (secret service variables) instead of a file.
 */
export async function loadOperatorFrom(env: Record<string, string | undefined>): Promise<UnifiedAccount> {
  if (env["QORE_MNEMONIC"]) return deriveUnifiedAccount(env["QORE_MNEMONIC"], 0);
  // A role file written by scripts/drill/new-account.ts: <ROLE>_MNEMONIC with <ROLE>_QOR_ADDRESS beside it.
  const roles = Object.keys(env).filter((k) => /^[A-Z0-9_]+_MNEMONIC$/.test(k) && env[k]);
  if (roles.length > 1) throw new Error(`the .env holds several mnemonics (${roles.join(", ")}); keep one per file`);
  if (roles.length === 1 && !env["PRIVATE_KEY"]) {
    const name = roles[0]!;
    const acct = await deriveUnifiedAccount(env[name]!, 0);
    const want = env[name.replace(/_MNEMONIC$/, "_QOR_ADDRESS")];
    if (want && want !== acct.cosmos) throw new Error(`${name} does not derive the address saved beside it`);
    return acct;
  }
  const key = env["PRIVATE_KEY"];
  const code = env["QORE_PQC_RECOVERY_CODE"];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the .env needs QORE_MNEMONIC, or PRIVATE_KEY as 0x + 64 hex");
  if (!code || !isValidRecoveryCode(code)) throw new Error("the .env needs a valid QORE_PQC_RECOVERY_CODE (QRC1-…) with PRIVATE_KEY");
  return unifiedAccountFromSeed(Uint8Array.from(Buffer.from(key.slice(2), "hex")), { recoveryCode: code });
}

/** Read the value after `--name` from argv. */
export function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
