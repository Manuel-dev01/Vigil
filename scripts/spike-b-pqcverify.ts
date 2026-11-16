/**
 * Spike B: probe the EVM post-quantum precompiles on the testnet with eth_call
 * only (no transaction, no key that ever holds funds).
 *
 *  1. Which message convention `pqcVerify` (0x…0a01) expects: FIPS 204 pure
 *     ML-DSA-87 with an empty context (the standard `sign`), with a non-empty
 *     context, or the "internal" form with no context prefix.
 *  2. What a call costs (eth_estimateGas) at several message sizes.
 *  3. What `pqcKeyStatus` (0x…0a02) returns for an account with a registered key.
 *
 *   pnpm --filter @vigil/scripts spike:b [--record]
 */
import "./lib/net.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { bech32ToHex } from "@qorechain/rdk";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem";

const EVM_RPC = "https://evm-testnet.qore.host";
const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as const;
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as const;
/** Creator of the RDK team's rollup rdk-v328-e2e-mwd5v89d (has a registered ML-DSA-87 key). */
const RDK_CREATOR = "qor1ekyftdz36tndvnmttjexmzpgj48j0mfwk007rp";
/** An address that has never registered a key: all-zero but for the last byte. */
const NO_KEY = "0x000000000000000000000000000000000000dEaD" as const;

const abi = parseAbi([
  "function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)",
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);

const client = createPublicClient({ transport: http(EVM_RPC, { timeout: 90_000, retryCount: 3 }) });
const chainId = await client.getChainId();

/** eth_call the precompile; returns the raw result so empty data (inactive precompile) is visible. */
async function verifyCall(pk: Uint8Array, sig: Uint8Array, msg: Uint8Array) {
  const data = encodeFunctionData({ abi, functionName: "pqcVerify", args: [toHex(pk), toHex(sig), toHex(msg)] });
  const { data: ret } = await client.call({ to: PQC_VERIFY, data });
  if (!ret || ret === "0x") return { ok: undefined as boolean | undefined, raw: ret ?? "0x", data };
  return { ok: decodeFunctionResult({ abi, functionName: "pqcVerify", data: ret }) as boolean, raw: ret, data };
}

async function gasFor(data: Hex, to: Hex) {
  return client.estimateGas({ to, data, account: NO_KEY });
}

const seed = randomBytes(32); // ephemeral; never stored
const { publicKey, secretKey } = ml_dsa87.keygen(seed);
const msg = new Uint8Array(randomBytes(256));
const ctx = new TextEncoder().encode("vigil/spike-b/v1");

const variants: Record<string, Uint8Array> = {
  "pure, empty context (FIPS 204 default)": ml_dsa87.sign(msg, secretKey, { extraEntropy: false }),
  "pure, context 'vigil/spike-b/v1'": ml_dsa87.sign(msg, secretKey, { context: ctx, extraEntropy: false }),
  "internal (raw message, no context prefix)": ml_dsa87.internal.sign(msg, secretKey, { extraEntropy: false }),
};

console.log(`EVM chain id ${chainId}; ML-DSA-87 pk ${publicKey.length} B, sig ${variants["pure, empty context (FIPS 204 default)"]?.length} B`);
const results: Record<string, unknown> = {};
for (const [name, sig] of Object.entries(variants)) {
  const r = await verifyCall(publicKey, sig, msg);
  results[name] = r.ok ?? `empty return (${r.raw})`;
  console.log(`pqcVerify[${name}] -> ${r.ok ?? `EMPTY RETURN ${r.raw}`}`);
}

// Negative controls with the convention that verifies.
const accepted = Object.entries(variants).find(([name]) => results[name] === true);
const controls: Record<string, unknown> = {};
const gas: Record<string, string> = {};
if (accepted) {
  const [name, sig] = accepted;
  const flippedMsg = msg.slice();
  flippedMsg[0] = (flippedMsg[0] ?? 0) ^ 1;
  const flippedSig = sig.slice();
  flippedSig[100] = (flippedSig[100] ?? 0) ^ 1;
  const other = ml_dsa87.keygen(randomBytes(32)).publicKey;
  controls["message with one bit flipped"] = (await verifyCall(publicKey, sig, flippedMsg)).ok;
  controls["signature with one bit flipped"] = (await verifyCall(publicKey, flippedSig, msg)).ok;
  controls["another public key"] = (await verifyCall(other, sig, msg)).ok;
  for (const [k, v] of Object.entries(controls)) console.log(`control ${k} -> ${v}`);

  for (const size of [32, 256, 1024, 4096]) {
    const m = new Uint8Array(randomBytes(size));
    const s = name.startsWith("internal")
      ? ml_dsa87.internal.sign(m, secretKey, { extraEntropy: false })
      : name.includes("context '")
        ? ml_dsa87.sign(m, secretKey, { context: ctx, extraEntropy: false })
        : ml_dsa87.sign(m, secretKey, { extraEntropy: false });
    const r = await verifyCall(publicKey, s, m);
    const g = await gasFor(r.data, PQC_VERIFY);
    gas[`msg ${size} B`] = g.toString();
    console.log(`eth_estimateGas pqcVerify msg=${size} B (calldata ${(r.data.length - 2) / 2} B, ok=${r.ok}) -> ${g}`);
  }
}

// pqcKeyStatus
const creatorEvm = getAddress(`0x${bech32ToHex(RDK_CREATOR).replace(/^0x/, "")}`);
const status: Record<string, unknown> = {};
for (const [label, addr] of [
  [`RDK creator ${RDK_CREATOR}`, creatorEvm],
  ["address with no key", NO_KEY],
] as const) {
  const data = encodeFunctionData({ abi, functionName: "pqcKeyStatus", args: [addr] });
  const { data: ret } = await client.call({ to: PQC_KEY_STATUS, data });
  if (!ret || ret === "0x") {
    status[label] = "EMPTY RETURN";
    console.log(`pqcKeyStatus(${addr}) -> EMPTY RETURN`);
    continue;
  }
  const [registered, algorithmId, pubkey, possessionProven] = decodeFunctionResult({
    abi,
    functionName: "pqcKeyStatus",
    data: ret,
  }) as readonly [boolean, number, Hex, boolean];
  const g = await gasFor(data, PQC_KEY_STATUS);
  status[label] = { address: addr, registered, algorithmId, pubkeyBytes: (pubkey.length - 2) / 2, possessionProven, estimateGas: g.toString() };
  console.log(`pqcKeyStatus(${addr}) -> registered=${registered} alg=${algorithmId} pubkey=${(pubkey.length - 2) / 2} B possessionProven=${possessionProven} gas=${g}`);
}

if (process.argv.includes("--record")) {
  const head = await client.getBlockNumber();
  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../test/vectors/spike-b-pqc-precompiles.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), evmChainId: chainId, evmBlock: head.toString(), conventions: results, controls, estimateGas: gas, pqcKeyStatus: status },
      null,
      2,
    ) + "\n",
  );
  console.log(`recorded ${out}`);
}
