/**
 * Seal keys (QoreSeal ML-KEM-1024 + X25519) for an L1 account.
 *
 *   tsx src/cli/seal-key.ts new --address <qor1…> --out <file>   # writes the seed, mode 0600; prints only public values
 *   tsx src/cli/seal-key.ts show --key <file>
 */
import { createHash } from "node:crypto";
import { toHex } from "@qorechain/qoreseal";
import { loadSealKeyFile, newSealKeyFile, type SealKeyFile } from "../keys.ts";
import { argValue, fail } from "./common.ts";

const argv = process.argv.slice(2);
const show = (f: SealKeyFile) => {
  console.log(`address        ${f.address}`);
  console.log(`ML-KEM-1024    ${f.keys.mlkemPublicKey.length} bytes, sha3-256 ${createHash("sha3-256").update(f.keys.mlkemPublicKey).digest("hex")}`);
  console.log(`X25519         ${toHex(f.keys.x25519PublicKey)}`);
};

if (argv[0] === "new") {
  const address = argValue(argv, "--address");
  const out = argValue(argv, "--out");
  if (!address || !out) fail("usage: seal-key.ts new --address <qor1…> --out <file>");
  show(newSealKeyFile(out, address));
  console.log(`seed written to ${out} (mode 0600; it is NOT printed)`);
} else if (argv[0] === "show") {
  const key = argValue(argv, "--key");
  if (!key) fail("usage: seal-key.ts show --key <file>");
  show(loadSealKeyFile(key));
} else {
  fail("usage: seal-key.ts new --address <qor1…> --out <file> | show --key <file>");
}
