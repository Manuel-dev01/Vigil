/**
 * Sign the recipient card of an account's seal key and save it (public) to
 * cards/<qor1…>.json. Offline: nothing is sent.
 *
 *   tsx src/cli/card.ts --env <account .env> --key <seal key file> [--out <file>]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { verifyRecipientCard } from "@qorechain/qoreseal";
import { cardPath, signCard } from "../card.ts";
import { loadAccount, loadSealKeyFile } from "../keys.ts";
import { argValue, chainId, fail, repoRoot } from "./common.ts";

const argv = process.argv.slice(2);
const envPath = argValue(argv, "--env");
const keyPath = argValue(argv, "--key");
if (!envPath || !keyPath) fail("usage: card.ts --env <account .env> --key <seal key file> [--out <file>]");

const account = await loadAccount(envPath);
const sealKey = loadSealKeyFile(keyPath);
if (sealKey.address !== account.cosmos) fail(`the seal key is for ${sealKey.address}, but the .env holds ${account.cosmos}`);
const card = signCard(account, sealKey.keys, chainId);
// Self-check with the account's own keys before publishing.
verifyRecipientCard({ card, chainId, address: account.cosmos, pqPublicKey: account.pqc.publicKey, mlkemPublicKey: sealKey.keys.mlkemPublicKey });
const out = argValue(argv, "--out") ?? cardPath(repoRoot, account.cosmos);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(card, null, 2) + "\n");
console.log(`card for ${account.cosmos} written to ${out}`);
console.log("It verifies against this account's keys. Senders also check it against the chain, so register the ML-KEM key (kem.ts) before anyone seals to it.");
