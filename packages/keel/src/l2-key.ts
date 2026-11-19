/**
 * qledger-v1 account keys (ML-DSA-44), kept in a local file outside git.
 *
 *   tsx src/l2-key.ts new --out <file>    create a key (refuses to overwrite); prints the account id
 *   tsx src/l2-key.ts show --key <file>   print the account id of a saved key
 *
 * The file holds QLEDGER_SEED_HEX (32 bytes) and is written with mode 0600.
 * The seed is never printed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { argValue, readEnvFile } from "./account.ts";

export function loadL2Key(path: string): ReturnType<typeof qledgerKeypairFromSeed> {
  const seed = readEnvFile(path)["QLEDGER_SEED_HEX"];
  if (!seed || !/^[0-9a-f]{64}$/i.test(seed)) throw new Error(`${path} needs QLEDGER_SEED_HEX (64 hex characters)`);
  return qledgerKeypairFromSeed(seed);
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith("l2-key.ts");
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd === "new") {
    const out = argValue(process.argv, "--out");
    if (!out) throw new Error("pass --out <file>");
    if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a key`);
    const seed = randomBytes(32);
    const kp = qledgerKeypairFromSeed(seed);
    writeFileSync(out, `# qledger-v1 (ML-DSA-44) account key. Secret: never commit or share.\nQLEDGER_SEED_HEX=${seed.toString("hex")}\n`, {
      mode: 0o600,
    });
    console.log(`account id ${bytesToHex(kp.accountId).toLowerCase()}`);
  } else if (cmd === "show") {
    const key = argValue(process.argv, "--key");
    if (!key) throw new Error("pass --key <file>");
    console.log(`account id ${bytesToHex(loadL2Key(key).accountId).toLowerCase()}`);
  } else {
    console.error("usage: l2-key.ts new --out <file> | show --key <file>");
    process.exit(1);
  }
}
