/**
 * Publish an account's ML-KEM-1024 key in the chain's KEM registry, or read it.
 * Simulates by default; only --broadcast sends (hybrid-signed).
 *
 *   tsx src/cli/kem.ts register --env <account .env> --key <seal key file> [--broadcast]
 *   tsx src/cli/kem.ts status --address <qor1…>
 */
import { createHash } from "node:crypto";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { registerKemKeyMsg, ML_KEM_1024_ALGORITHM_ID } from "@qorechain/rdk";
import { fetchPqcStatus, isRegisteredPqcKey } from "@qorechain/sdk";
import { HybridSender } from "@vigil/keel/chain";
import { loadAccount, loadSealKeyFile } from "../keys.ts";
import { argValue, fail, fmtQor, restUrl } from "./common.ts";

const argv = process.argv.slice(2);
const sha3 = (b: Uint8Array) => createHash("sha3-256").update(b).digest("hex");

async function status(address: string): Promise<Uint8Array | undefined> {
  const k = await fetchKemKey({ rest: restUrl, address });
  if (!k.registered || !k.publicKey) {
    console.log(`${address}: no KEM key registered`);
    return undefined;
  }
  console.log(`${address}: ${k.algorithmName ?? k.algorithmId} key, sha3-256 ${sha3(k.publicKey)}, registered at height ${k.registeredHeight}`);
  return k.publicKey;
}

if (argv[0] === "status") {
  const address = argValue(argv, "--address");
  if (!address) fail("usage: kem.ts status --address <qor1…>");
  await status(address);
} else if (argv[0] === "register") {
  const envPath = argValue(argv, "--env");
  const keyPath = argValue(argv, "--key");
  if (!envPath || !keyPath) fail("usage: kem.ts register --env <account .env> --key <seal key file> [--broadcast]");
  const account = await loadAccount(envPath);
  const { address, keys } = loadSealKeyFile(keyPath);
  if (address !== account.cosmos) fail(`the seal key is for ${address}, but the .env holds ${account.cosmos}`);
  const sender = new HybridSender(account);
  const [pqc, windowOpen, balance] = await Promise.all([
    fetchPqcStatus({ rest: restUrl, address: account.cosmos }),
    sender.evmWindowOpen(),
    sender.balanceUqor(),
  ]);
  // The KEM registry needs a registered ML-DSA-87 key first; this account must stay hybrid-only.
  if (!pqc.registered || isRegisteredPqcKey(pqc, account.pqc.publicKey) !== true) fail(`${account.cosmos} has no registered ML-DSA-87 key matching this .env; register it first`);
  if (windowOpen) fail(`${account.cosmos} has an open EVM window; this key must stay hybrid-only`);
  const current = await status(account.cosmos);
  if (current && sha3(current) === sha3(keys.mlkemPublicKey)) {
    console.log("this seal key is already registered; nothing to do");
    process.exit(0);
  }
  if (current) fail("a different KEM key is registered for this account; replacing it is not supported here");
  const msg = registerKemKeyMsg({ sender: account.cosmos, publicKey: keys.mlkemPublicKey, algorithmId: ML_KEM_1024_ALGORITHM_ID });
  const sim = await sender.simulate([msg]);
  console.log(`account        ${account.cosmos} (${fmtQor(balance)})`);
  console.log(`ML-KEM-1024    sha3-256 ${sha3(keys.mlkemPublicKey)}`);
  console.log(`simulate       ${sim.ok ? `ok, gas ${sim.gasUsed}` : `failed: ${sim.error}`}`);
  if (!sim.ok || sim.gasUsed === undefined || !argv.includes("--broadcast")) process.exit(sim.ok ? 0 : 1);
  const res = await sender.send([msg], sim.gasUsed);
  console.log(`registered     tx ${res.transactionHash} at height ${res.height} (fee ${res.feeUqor} uqor)`);
  await status(account.cosmos);
} else {
  fail("usage: kem.ts register --env <account .env> --key <seal key file> [--broadcast] | status --address <qor1…>");
}
