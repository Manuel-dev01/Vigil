/**
 * Spike C: can an EVM contract check vigil-1's anchors and read chain state
 * without a committee? Read-only: eth_call and REST/RPC queries, no key, no
 * transaction.
 *
 *  S1  pqcVerify (0x…0a01) accepts each vigil-1 batch anchor, rebuilt as the
 *      140-byte AnchorSignBytesV2 message, under the creator's registered key
 *      read through pqcKeyStatus (0x…0a02). A one-bit flip must fail.
 *  S2  The sha256 precompile (0x…02) answers when called from contract code.
 *  S3  BLOCKHASH(n) inside the EVM equals CometBFT's block_id.hash for height
 *      n, over the last 256 blocks; plus whether the EIP-2935 history contract
 *      serves older hashes. This decides "Mode N": VigilVerifier can then
 *      authenticate an app_hash from a header the contract re-hashes itself.
 *
 *   pnpm --filter @vigil/scripts spike:c [--record]
 */
import "./lib/net.ts";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
// lib/net.ts installs an undici 8 Agent as the global dispatcher. Under Node 26,
// Node's built-in fetch then hands back gzip-compressed bodies undecoded for
// large replies (pqcKeyStatus, account records), so use undici's own fetch,
// which pairs with that dispatcher and decompresses correctly.
import { fetch as undiciFetch } from "undici";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { anchorSignBytesV2, bech32ToHex } from "@qorechain/rdk";
import {
  bytesToHex,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem";

const EVM_RPC = "https://evm-testnet.qore.host";
const COMET_RPC = "https://rpc-testnet.qore.host";
const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as const;
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as const;
/** EIP-2935 block-hash history contract (same address on every chain that ships it). */
const HISTORY_2935 = "0x0000F90827F1C53a10cb7A02335B175320002935" as const;
const CALLER = "0x000000000000000000000000000000000000dEaD" as const;

const here = dirname(fileURLToPath(import.meta.url));
const receiptsDir = resolve(here, "../receipts/vigil-1");

const abi = parseAbi([
  "function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)",
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);
const fetchFn = undiciFetch as unknown as typeof fetch;
const client = createPublicClient({ transport: http(EVM_RPC, { timeout: 90_000, retryCount: 3, fetchFn }) });

interface Receipt {
  chainId: string;
  layerId: string;
  batchIndex: number;
  creator: string;
  layerHeight: number;
  stateRoot: string;
  validatorSetHash: string;
  transactionCount: number;
  compressedStateProof: string;
  pqcSignature: string;
}

function flipBit(b: Uint8Array, i: number): Uint8Array {
  const c = b.slice();
  c[i] = (c[i] ?? 0) ^ 1;
  return c;
}

async function pqcVerifyCall(pk: Hex, sig: Uint8Array, msg: Uint8Array): Promise<boolean | "empty"> {
  const data = encodeFunctionData({ abi, functionName: "pqcVerify", args: [pk, toHex(sig), toHex(msg)] });
  const { data: ret } = await client.call({ to: PQC_VERIFY, data });
  if (!ret || ret === "0x") return "empty";
  return decodeFunctionResult({ abi, functionName: "pqcVerify", data: ret }) as boolean;
}

/** Run init code with eth_call (no `to`): the code executes in a contract context and its RETURN data comes back. */
async function runInitCode(code: Hex, blockNumber?: bigint): Promise<Hex> {
  const { data } = await client.call({ data: code, account: CALLER, ...(blockNumber !== undefined ? { blockNumber } : {}) });
  return data ?? "0x";
}

function push8(n: bigint): string {
  return "67" + n.toString(16).padStart(16, "0");
}

/** PUSH8 n, BLOCKHASH, MSTORE at 0, RETURN 32 bytes. */
function blockhashCode(n: bigint): Hex {
  return `0x${push8(n)}40` + "600052" + "60206000f3" as Hex;
}

/**
 * STATICCALL the sha256 precompile (0x02) on "abc" from contract code and
 * return [success flag, digest] as 64 bytes.
 */
const SHA256_FROM_CODE: Hex = (
  "0x" +
  "62616263" + "600052" + // mem[29..32] = "abc"
  "6020" + "6040" + "6003" + "601d" + "6002" + "5a" + "fa" + // STATICCALL(gas, 0x02, 29, 3, 64, 32)
  "602052" + // mem[32] = success
  "6040" + "6020" + "f3" // RETURN mem[32..96]
) as Hex;

async function cometBlockHash(height: bigint): Promise<string> {
  const r = await fetchFn(`${COMET_RPC}/block?height=${height}`);
  if (!r.ok) throw new Error(`comet /block ${height}: HTTP ${r.status}`);
  const j = (await r.json()) as { result: { block_id: { hash: string } } };
  return `0x${j.result.block_id.hash.toLowerCase()}`;
}

// ---------------------------------------------------------------- S1
console.log("S1: pqcVerify over vigil-1 anchors");
const receipts: Receipt[] = readdirSync(receiptsDir)
  .filter((f) => /^batch-\d+\.json$/.test(f))
  .map((f) => {
    const j = JSON.parse(readFileSync(resolve(receiptsDir, f), "utf8")) as { receipt?: Receipt } & Receipt;
    return j.receipt ?? j;
  })
  .sort((a, b) => a.batchIndex - b.batchIndex);
const creator = receipts[0]?.creator;
if (!creator || receipts.some((r) => r.creator !== creator)) throw new Error("receipts disagree on the creator");
const creatorEvm = getAddress(`0x${bech32ToHex(creator).replace(/^0x/, "")}`);

const statusData = encodeFunctionData({ abi, functionName: "pqcKeyStatus", args: [creatorEvm] });
const { data: statusRet } = await client.call({ to: PQC_KEY_STATUS, data: statusData });
if (!statusRet || statusRet === "0x") throw new Error("pqcKeyStatus returned nothing");
const [registered, algorithmId, evmPubkey, possessionProven] = decodeFunctionResult({
  abi,
  functionName: "pqcKeyStatus",
  data: statusRet,
}) as readonly [boolean, number, Hex, boolean];
const restAccount = (await (
  await fetchFn(`https://api-testnet.qore.host/qorechain/pqc/v1/account/${creator}`)
).json()) as { account?: { public_key: string } };
const restPubkey = toHex(Buffer.from(restAccount.account?.public_key ?? "", "base64"));
const keyStatus = {
  creator,
  creatorEvm,
  registered,
  algorithmId,
  pubkeyBytes: (evmPubkey.length - 2) / 2,
  possessionProven,
  matchesRestKey: evmPubkey.toLowerCase() === restPubkey.toLowerCase(),
};
console.log(`  pqcKeyStatus(${creatorEvm}) -> registered=${registered} alg=${algorithmId} pubkey=${keyStatus.pubkeyBytes} B possessionProven=${possessionProven} matchesRest=${keyStatus.matchesRestKey}`);

const pk = hexToBytes(evmPubkey);
const anchors: Array<Record<string, unknown>> = [];
let s1Gas: string | undefined;
for (const r of receipts) {
  const msg = anchorSignBytesV2({
    chainId: r.chainId,
    layerId: r.layerId,
    layerHeight: r.layerHeight,
    stateRoot: r.stateRoot,
    validatorSetHash: r.validatorSetHash,
    transactionCount: r.transactionCount,
    compressedStateProof: r.compressedStateProof,
  });
  const sig = hexToBytes(`0x${r.pqcSignature.replace(/^0x/, "")}`);
  const offline = ml_dsa87.verify(sig, msg, pk);
  const onChain = await pqcVerifyCall(evmPubkey, sig, msg);
  const flippedMsg = await pqcVerifyCall(evmPubkey, sig, flipBit(msg, msg.length - 9));
  if (s1Gas === undefined) {
    const data = encodeFunctionData({ abi, functionName: "pqcVerify", args: [evmPubkey, toHex(sig), toHex(msg)] });
    s1Gas = (await client.estimateGas({ to: PQC_VERIFY, data, account: CALLER })).toString();
  }
  anchors.push({ batch: r.batchIndex, signBytes: msg.length, msgSha256: bytesToHex(sha256(msg)), offline, onChain, flippedMsg });
  console.log(`  batch ${String(r.batchIndex).padStart(2)}: ${msg.length} B, offline=${offline} pqcVerify=${onChain} flipped=${flippedMsg}`);
}
const s1Pass =
  registered && algorithmId === 1 && possessionProven && keyStatus.matchesRestKey &&
  anchors.every((a) => a.offline === true && a.onChain === true && a.flippedMsg === false);
console.log(`  S1 ${s1Pass ? "PASS" : "FAIL"} (${anchors.length} anchors; eth_estimateGas for one call ${s1Gas})`);

// ---------------------------------------------------------------- S2
console.log("S2: sha256 precompile from contract code");
const s2Ret = await runInitCode(SHA256_FROM_CODE);
const s2Success = s2Ret.length >= 66 ? BigInt(s2Ret.slice(0, 66)) === 1n : false;
const s2Digest = s2Ret.length >= 130 ? `0x${s2Ret.slice(66, 130)}` : "0x";
const s2Expected = bytesToHex(sha256(new TextEncoder().encode("abc")));
const s2Pass = s2Success && s2Digest === s2Expected;
console.log(`  STATICCALL ok=${s2Success} digest=${s2Digest}`);
console.log(`  S2 ${s2Pass ? "PASS" : "FAIL"} (expected ${s2Expected})`);

// ---------------------------------------------------------------- S3
console.log("S3: BLOCKHASH vs CometBFT block_id.hash");
const head = await client.getBlockNumber();
const at = head - 2n; // pin the call to a block every node already has
const offsets = [1n, 2n, 16n, 64n, 128n, 255n, 256n, 257n];
const s3Rows: Array<Record<string, unknown>> = [];
for (const off of offsets) {
  const n = at - off;
  const evm = (await runInitCode(blockhashCode(n), at)).toLowerCase();
  const comet = await cometBlockHash(n);
  const zero = /^0x0{64}$/.test(evm);
  s3Rows.push({ height: n.toString(), offset: Number(off), blockhash: evm, cometHash: comet, equal: evm === comet, zero });
  console.log(`  BLOCKHASH(at-${off}) ${zero ? "zero" : evm === comet ? "== comet" : `!= comet (${evm} vs ${comet})`}`);
}
const inWindow = s3Rows.filter((r) => Number(r.offset) <= 256);
const s3Pass = inWindow.every((r) => r.equal === true);

// Control: let the EVM pick the heights itself, at "latest", so a mismatch
// between our block numbering and the EVM's cannot explain a zero.
// NUMBER -> mem[0]; BLOCKHASH(NUMBER-1) -> mem[32]; BLOCKHASH(NUMBER-2) -> mem[64]; RETURN 96 bytes.
const RELATIVE_CODE: Hex = "0x4360005243600190034060205243600290034060405260606000f3";
const rel = await runInitCode(RELATIVE_CODE);
const relative = {
  evmNumber: rel.length >= 66 ? BigInt(rel.slice(0, 66)).toString() : null,
  blockhashNumberMinus1: rel.length >= 130 ? `0x${rel.slice(66, 130)}` : null,
  blockhashNumberMinus2: rel.length >= 194 ? `0x${rel.slice(130, 194)}` : null,
};
console.log(`  control at latest: NUMBER=${relative.evmNumber} BLOCKHASH(NUMBER-1)=${relative.blockhashNumberMinus1}`);
const vmParams = (await (await fetchFn("https://api-testnet.qore.host/cosmos/evm/vm/v1/params")).json()) as { params?: { history_serve_window?: string } };
const historyServeWindow = vmParams.params?.history_serve_window ?? null;
console.log(`  x/vm params history_serve_window=${historyServeWindow}`);

// EIP-2935: get(blockNumber) is a raw 32-byte calldata call.
const history: Array<Record<string, unknown>> = [];
const historyCode = await client.getCode({ address: HISTORY_2935 });
for (const off of [300n, 1000n, 4000n, 8000n, 8191n, 9000n]) {
  const n = at - off;
  let ret: Hex | "revert" = "revert";
  try {
    ret = ((await client.call({ to: HISTORY_2935, data: toHex(n, { size: 32 }), account: CALLER, blockNumber: at })).data ?? "0x") as Hex;
  } catch {
    ret = "revert";
  }
  const comet = await cometBlockHash(n);
  const equal = typeof ret === "string" && ret.toLowerCase() === comet;
  history.push({ height: n.toString(), offset: Number(off), result: ret, cometHash: comet, equal });
  console.log(`  EIP-2935 get(at-${off}) ${ret === "revert" ? "reverted" : equal ? "== comet" : `-> ${ret}`}`);
}
console.log(`  history contract code: ${historyCode && historyCode !== "0x" ? `${(historyCode.length - 2) / 2} B` : "none"}`);
console.log(
  `  S3 ${s3Pass ? "PASS: Mode N is viable within 256 blocks" : "FAIL under eth_call: BLOCKHASH is zero and no EIP-2935 history is served. Still to test inside a mined transaction (S3b) before ruling Mode N out."}`,
);

if (process.argv.includes("--record")) {
  const out = resolve(here, "../test/vectors/spike-c-evm-reads.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        evmChainId: await client.getChainId(),
        evmBlock: at.toString(),
        s1: { pass: s1Pass, keyStatus, estimateGasOneCall: s1Gas, anchors },
        s2: { pass: s2Pass, success: s2Success, digest: s2Digest, expected: s2Expected },
        s3: {
          pass: s3Pass,
          context: "eth_call only; a mined transaction may differ (S3b)",
          pinnedBlock: at.toString(),
          blockhash: s3Rows,
          relativeControl: relative,
          vmHistoryServeWindow: historyServeWindow,
          eip2935: { address: HISTORY_2935, codeBytes: historyCode ? (historyCode.length - 2) / 2 : 0, reads: history },
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`recorded ${out}`);
}
