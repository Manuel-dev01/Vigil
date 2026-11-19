/**
 * Record a rollup's anchors as test vectors for the Solidity receipt verifier.
 * Read-only; needs no key.
 *
 * For every anchor of the layer it saves the fields the signature covers, the
 * signature, and the exact message the RDK builds for it (anchorSignBytesV2),
 * after checking that the signature verifies under the creator's registered
 * ML-DSA-87 key (read from the chain, possession proven).
 * `forge test` then checks that SettlementReceiptVerifier.anchorMessage()
 * rebuilds each message byte for byte.
 *
 *   pnpm --filter @vigil/scripts exec tsx evm/anchor-vectors.ts [rollupId]
 *   -> test/vectors/anchors-<rollupId>.json
 */
import "../lib/net.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { anchorSignBytesV2, bech32ToHex, createRdkClient } from "@qorechain/rdk";
import { getAddress } from "viem";
import { REPO_ROOT } from "../lib/env.ts";
import { CHAIN_ID } from "../lib/native.ts";

const rollupId = process.argv[2] ?? "vigil-pay-1";
const rdk = createRdkClient({ network: "testnet" });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

const rollup = await rdk.rest.getRollup(rollupId);
const layerId = rollup.layerId || rollupId;
// The RDK's account view drops possession_proven, so read the route directly.
const key = (await (await fetch(`https://api-testnet.qore.host/qorechain/pqc/v1/account/${rollup.creator}`)).json()) as {
  account?: { public_key: string; algorithm_id: number; possession_proven: boolean };
};
if (!key.account?.possession_proven || key.account.algorithm_id !== 1) throw new Error(`creator key not usable: ${JSON.stringify(key)}`);
const publicKey = Uint8Array.from(Buffer.from(key.account.public_key, "base64"));
if (publicKey.length !== 2592) throw new Error(`creator key is ${publicKey.length} bytes, expected 2592`);
const status = (await (await fetch("https://rpc-testnet.qore.host/status")).json()) as { result: { sync_info: { latest_block_height: string } } };

const anchors = (await rdk.rest.getAnchors(layerId)).sort((a, b) => a.layerHeight - b.layerHeight);
const out = anchors.map((a) => {
  const signBytes = anchorSignBytesV2({
    chainId: CHAIN_ID,
    layerId,
    layerHeight: BigInt(a.layerHeight),
    stateRoot: a.stateRoot,
    validatorSetHash: a.validatorSetHash,
    transactionCount: BigInt(a.transactionCount),
    compressedStateProof: a.compressedStateProof,
  });
  const signature = bytes(a.pqcSignature);
  if (!ml_dsa87.verify(signature, signBytes, publicKey)) throw new Error(`anchor at layer height ${a.layerHeight} does not verify offline`);
  return {
    layerHeight: a.layerHeight,
    stateRoot: `0x${a.stateRoot}`,
    validatorSetHash: `0x${a.validatorSetHash}`,
    transactionCount: a.transactionCount,
    compressedStateProof: `0x${a.compressedStateProof}`,
    signature: `0x${hex(signature)}`,
    signBytes: `0x${hex(signBytes)}`,
    mainChainHeight: a.mainChainHeight,
    anchoredAt: a.anchoredAt,
  };
});

const file = resolve(REPO_ROOT, `test/vectors/anchors-${rollupId}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      source: `GET /qorechain/multilayer/v1/anchors/${layerId} and /qorechain/pqc/v1/account/${rollup.creator} on ${CHAIN_ID}`,
      recordedAtHeight: Number(status.result.sync_info.latest_block_height),
      chainId: CHAIN_ID,
      rollupId,
      layerId,
      creator: rollup.creator,
      creatorEvm: getAddress(`0x${bech32ToHex(rollup.creator).replace(/^0x/, "")}`),
      creatorPublicKey: `0x${hex(publicKey)}`,
      count: out.length,
      anchors: out,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${out.length} anchors of ${layerId}, all verified offline under ${rollup.creator}'s key -> ${file}`);
