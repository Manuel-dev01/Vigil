/**
 * The same receipt, checked a third way: by SettlementReceiptVerifier, a contract on QoreChain's
 * EVM lane. It rebuilds the anchor message, reads the creator's ML-DSA-87 key with the
 * pqcKeyStatus precompile and verifies the signature with pqcVerify. The page asks it with a free
 * eth_call (the EVM JSON-RPC endpoint allows calls from any origin) and reads its public record of
 * attested anchors.
 */
import type { SettlementReceipt } from "@qorechain/rdk";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import deployments from "../../../deployments/diana.json";
import { CHAIN_ID, ROLLUP } from "./chain.ts";

export const EVM_RPC = "https://evm-testnet.qore.host";

interface VerifierDeployment {
  address: Hex;
  rollupId: string;
  chainId: string;
  deployTx: Hex;
  block: string;
}
export const RECEIPT_VERIFIER = (deployments as { SettlementReceiptVerifier?: VerifierDeployment }).SettlementReceiptVerifier;

const abi = parseAbi([
  "struct Anchor { uint64 layerHeight; bytes32 stateRoot; bytes validatorSetHash; uint64 transactionCount; bytes compressedStateProof; bytes signature; }",
  "function check(Anchor a) view returns (uint8)",
  "function records(uint64 layerHeight) view returns (bytes32 stateRoot, uint64 attestedAt, uint64 attestedBlock, bool conflicted)",
]);

export const EVM_RESULTS = ["Valid", "Bad signature length", "Creator key not usable", "Signature does not verify"] as const;

export interface EvmCheck {
  result: (typeof EVM_RESULTS)[number];
  valid: boolean;
  ms: number;
  record: { attested: boolean; sameRoot: boolean; block: number; at: number; conflicted: boolean };
}

let nextId = 0;
async function ethCall(to: Hex, data: Hex): Promise<Hex> {
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  if (!res.ok) throw new Error(`EVM RPC answered HTTP ${res.status}`);
  const j = (await res.json()) as { result?: Hex; error?: { message: string } };
  if (j.error || !j.result) throw new Error(`eth_call: ${j.error?.message ?? "no result"}`);
  return j.result;
}

const hex = (s: string | undefined): Hex => `0x${(s ?? "").replace(/^0x/, "")}`;

/** Whether the deployed contract covers this receipt's rollup and chain. */
export const evmCovers = (r: SettlementReceipt): boolean =>
  !!RECEIPT_VERIFIER && r.rollupId === ROLLUP && RECEIPT_VERIFIER.rollupId === ROLLUP && (r.chainId ?? CHAIN_ID) === RECEIPT_VERIFIER.chainId;

export async function checkInEvm(r: SettlementReceipt): Promise<EvmCheck> {
  if (!RECEIPT_VERIFIER) throw new Error("no SettlementReceiptVerifier deployment");
  const anchor = {
    layerHeight: BigInt(r.layerHeight),
    stateRoot: hex(r.stateRoot),
    validatorSetHash: hex(r.validatorSetHash),
    transactionCount: BigInt(r.transactionCount ?? 0),
    compressedStateProof: hex(r.compressedStateProof),
    signature: hex(r.pqcSignature),
  };
  if (anchor.stateRoot.length !== 66) throw new Error("the receipt's state root is not 32 bytes");
  const t0 = performance.now();
  const [checkRet, recordRet] = await Promise.all([
    ethCall(RECEIPT_VERIFIER.address, encodeFunctionData({ abi, functionName: "check", args: [anchor] })),
    ethCall(RECEIPT_VERIFIER.address, encodeFunctionData({ abi, functionName: "records", args: [anchor.layerHeight] })),
  ]);
  const ms = Math.round(performance.now() - t0);
  const code = decodeFunctionResult({ abi, functionName: "check", data: checkRet });
  const [root, at, block, conflicted] = decodeFunctionResult({ abi, functionName: "records", data: recordRet });
  const result = EVM_RESULTS[code] ?? EVM_RESULTS[3];
  return {
    result,
    valid: code === 0,
    ms,
    record: { attested: at !== 0n, sameRoot: root.toLowerCase() === anchor.stateRoot.toLowerCase(), block: Number(block), at: Number(at), conflicted },
  };
}
