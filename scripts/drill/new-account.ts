/**
 * Create a fresh unified eth-native testnet account for one Vigil role and save
 * its secrets to `.env.<role>` at the repo root (gitignored). Prints only public
 * values. Refuses to overwrite an existing file.
 *
 *   pnpm --filter @vigil/scripts exec tsx drill/new-account.ts --role drill
 *   pnpm --filter @vigil/scripts exec tsx drill/new-account.ts --role deployer
 *
 * One eth_secp256k1 key (HD path m/44'/60'/0'/0/0) is the same 20-byte account
 * on the native and EVM lanes. Its ML-DSA-87 key is the SDK's canonical,
 * address-bound derivation: shake256("qorechain:pqc:v1|" + qor1 + "|" + mnemonic).
 * For the drill account this means the attacker's ECDSA key really is the
 * account on both lanes; what protects it is the ML-DSA-87 key and the closed
 * EVM window, not an unrelated address.
 */
import "../lib/net.ts";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveUnifiedAccount, derivePqcCanonical, generateMnemonic } from "@qorechain/sdk";

const REST = "https://api-testnet.qore.host";
const args = process.argv.slice(2);
const role = args[args.indexOf("--role") + 1];
if (!args.includes("--role") || !role || !/^[a-z0-9-]{2,32}$/.test(role)) {
  console.error("usage: new-account.ts --role <drill|deployer|creator|watchtower-1|...>");
  process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = resolve(repoRoot, `.env.${role}`);
if (existsSync(envFile)) {
  console.error(`${envFile} already exists; refusing to overwrite. Move it aside first if you really want a new ${role} account.`);
  process.exit(1);
}
// Belt and braces: the file must be ignored by git before any secret is written.
try {
  execFileSync("git", ["check-ignore", "-q", envFile], { cwd: repoRoot });
} catch {
  console.error(`${envFile} is NOT gitignored; refusing to write secrets there.`);
  process.exit(1);
}

const mnemonic = generateMnemonic(256);
const acct = await deriveUnifiedAccount(mnemonic, 0);
const canonical = derivePqcCanonical(acct.cosmos, mnemonic);
if (bytesToHex(canonical.publicKey) !== bytesToHex(acct.pqc.publicKey)) {
  throw new Error("unified PQC key differs from derivePqcCanonical; refusing to continue");
}

// Freshness: the address must be unknown to the chain (no account, no PQC key).
async function status(path: string): Promise<number> {
  return (await fetch(`${REST}${path}`)).status;
}
const authStatus = await status(`/cosmos/auth/v1beta1/accounts/${acct.cosmos}`);
// This route answers 200 with {"found": false} for an unknown address.
const pqcFound = ((await (await fetch(`${REST}/qorechain/pqc/v1/account/${acct.cosmos}`)).json()) as { found?: boolean }).found;
if (authStatus !== 404 || pqcFound !== false) {
  throw new Error(`address ${acct.cosmos} is not fresh (auth HTTP ${authStatus}, pqc found=${pqcFound}); refusing to save it`);
}

const created = new Date().toISOString();
const upper = role.toUpperCase().replace(/-/g, "_");
writeFileSync(
  envFile,
  [
    `# Vigil ${role} account (testnet only). Created ${created}. SECRET: never commit, never paste in chat.`,
    `# Unified eth-native: one eth_secp256k1 key, HD path m/44'/60'/0'/0/0, same 20 bytes on native and EVM lanes.`,
    `${upper}_MNEMONIC="${mnemonic}"`,
    `# The classical (ECDSA secp256k1) private key, hex. For the drill account this is what gets registered on the project page.`,
    `${upper}_ECDSA_PRIVATE_KEY_HEX=${acct.privateKey.replace(/^0x/, "")}`,
    `${upper}_QOR_ADDRESS=${acct.cosmos}`,
    `${upper}_EVM_ADDRESS=${acct.evm}`,
    `# ML-DSA-87 public key fingerprint (sha256 of the 2592-byte key). The secret key is re-derived from the mnemonic.`,
    `${upper}_PQC_PUBKEY_SHA256=${bytesToHex(sha256(acct.pqc.publicKey))}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

console.log(`role:               ${role}`);
console.log(`qor1 address:       ${acct.cosmos}`);
console.log(`0x address:         ${acct.evm}`);
console.log(`ML-DSA-87 pubkey:   ${acct.pqc.publicKey.length} bytes, sha256 ${bytesToHex(sha256(acct.pqc.publicKey))}`);
console.log(`chain freshness:    no auth account (HTTP ${authStatus}), no PQC key (found=${pqcFound})`);
console.log(`secrets written to: ${envFile} (gitignored; mnemonic and ECDSA key are NOT printed)`);
