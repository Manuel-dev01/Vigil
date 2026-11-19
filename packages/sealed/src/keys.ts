/**
 * Seal keys and the accounts they belong to.
 *
 * A seal key is a QoreSeal hybrid key pair (ML-KEM-1024 + X25519) grown from a
 * 32-byte seed. It lives in a 0600 file next to the L1 account it is published
 * for. The seed opens every envelope sealed to it: never commit or print it.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fromHex, generateSealKeys, sealKeysFromSeed, toHex, type SealKeyPair } from "@qorechain/qoreseal";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import { loadOperatorFrom, readEnvFile } from "@vigil/keel/account";

export interface SealKeyFile {
  /** The L1 account (qor1…) whose KEM key and card this seal key is. */
  address: string;
  keys: SealKeyPair;
}

const ADDRESS = /^qor1[02-9ac-hj-np-z]{38,58}$/;

export function newSealKeyFile(path: string, address: string): SealKeyFile {
  if (!ADDRESS.test(address)) throw new Error(`${address} is not a qor1 address`);
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a seal key`);
  const keys = generateSealKeys();
  writeFileSync(
    path,
    [
      `# QoreSeal key (ML-KEM-1024 + X25519) for ${address}, testnet. SECRET: the seed opens every envelope sealed to it.`,
      `QSEAL_ADDRESS=${address}`,
      `QSEAL_SEED_HEX=${toHex(keys.seed)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return { address, keys };
}

export function loadSealKeyFile(path: string): SealKeyFile {
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must be readable by its owner only (chmod 600)`);
  const text = readFileSync(path, "utf8");
  const address = /^QSEAL_ADDRESS=(\S+)$/m.exec(text)?.[1];
  const seed = /^QSEAL_SEED_HEX=([0-9a-f]{64})$/m.exec(text)?.[1];
  if (!address || !ADDRESS.test(address) || !seed) throw new Error(`${path} is not a seal key file`);
  return { address, keys: sealKeysFromSeed(fromHex(seed)) };
}

/**
 * The L1 account in an .env file: Keel's operator form (`QORE_MNEMONIC`, or
 * `PRIVATE_KEY` + `QORE_PQC_RECOVERY_CODE`), or a role file from
 * `scripts/drill/new-account.ts` with exactly one `<ROLE>_MNEMONIC`.
 */
export async function loadAccount(envPath: string): Promise<UnifiedAccount> {
  const env = readEnvFile(envPath);
  if (env["QORE_MNEMONIC"] || env["PRIVATE_KEY"]) return loadOperatorFrom(env);
  const roles = Object.keys(env).filter((k) => /^[A-Z0-9_]+_MNEMONIC$/.test(k));
  if (roles.length !== 1) throw new Error(`${envPath} must hold one account: QORE_MNEMONIC, PRIVATE_KEY + QORE_PQC_RECOVERY_CODE, or a single <ROLE>_MNEMONIC`);
  return deriveUnifiedAccount(env[roles[0]!]!.trim(), 0);
}
