/**
 * The attack catalogue (lib/redteam.ts), offline: the inputs are the real attestations and anchors, every
 * attack really changes what was signed, every expected answer is an error the contract declares, and
 * answers are decoded and counted the way docs/REDTEAM.md reports them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { anchorSignBytesV2, hexToBytes } from "@qorechain/rdk";
import { generatePqcKeypair, pqcSign, pqcVerify } from "@qorechain/sdk";
import { exitMessage, verifyClaim, type ExitClaim, type ExitTarget } from "@vigil/qledger-watchtower";
import { decodeFunctionData, encodeErrorResult, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ABIS,
  NOT_RUN,
  buildCases,
  decodeRevert,
  exitStruct,
  flipBit,
  judge,
  realExits,
  renderMarkdown,
  summarize,
  type AnchorIn,
  type ContractName,
  type Inputs,
  type Report,
} from "../lib/redteam.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const dep = JSON.parse(read("deployments/diana.json")) as {
  InstantExitVault: { address: Hex; quorum: Hex[] };
  SettlementReceiptVerifier: { address: Hex };
  PQGuardVault: { address: Hex };
};
const fx = JSON.parse(read("apps/web/test/fixtures/attestations.json")) as { members: { address: string; publicKey: string }[] };
const vectors = JSON.parse(read("test/vectors/anchors-vigil-pay-1.json")) as { chainId: string; layerId: string; creatorPublicKey: Hex; anchors: (AnchorIn & { signBytes: Hex })[] };

const VAULT = dep.InstantExitVault.address;
const target: ExitTarget = { evmChainId: 9800, vault: VAULT, chainId: "qorechain-diana", rollupId: "vigil-pay-1" };
const memberKey = (i: number) => fx.members[i]!.publicKey.replace(/^0x/, "");
const exits = realExits(read("data/inbox/vigil-pay-1.jsonl"), VAULT, dep.InstantExitVault.quorum);
const PAYOUT = "0x7BaAa4638c10dFB64D6ae593C2f019782E7773E3" as Hex;
const ATTACKER = getAddress("0x00000000000000000000000000000000000a77ac");

function inputs(withOtherVault = true): Inputs {
  const [a, b] = exits as [(typeof exits)[number], (typeof exits)[number]];
  const junk = (n: number) => new Uint8Array(n).fill(7);
  return {
    vault: VAULT,
    verifier: dep.SettlementReceiptVerifier.address,
    guard: dep.PQGuardVault.address,
    payout: PAYOUT,
    attacker: ATTACKER,
    head: 10_900_000n,
    exits: [
      { ...a, frontBlock: 10_629_908n, tx: "0x9705", evidence: "EVIDENCE 91" },
      { ...b, frontBlock: 10_686_385n, tx: "0x6542", evidence: "EVIDENCE 104" },
    ],
    anchors: vectors.anchors,
    fresh: { exitSig: junk(4627), anchorSig: junk(4627), withdrawSig: junk(4627), releaseSig: junk(4627), ecdsaSig: junk(65) },
    lpWithdraw: { amount: 10n ** 18n, nonce: 0n, deadline: 2_000_000_000n },
    release: { amount: 25n * 10n ** 18n, nonce: 0n, deadline: 2_000_000_000n },
    otherVault: withOtherVault ? { code: "0x6080", rollupId: "another-rollup" } : undefined,
  };
}

describe("the inputs are the real attestations and anchors", () => {
  it("finds batch 15's and batch 18's exits, each signed by both members, in quorum order", () => {
    expect(exits.map((e) => [e.batchIndex, e.withdrawalIndex, e.entries])).toEqual([
      [15, 3, [19, 18]],
      [18, 4, [22, 21]],
    ]);
    for (const e of exits) {
      for (const m of [0, 1]) expect(verifyClaim(target, memberKey(m), { claim: e, signature: e.sigs[m as 0 | 1] })).toBe(true);
      // And not the other member's key: the order matters to the vault.
      expect(verifyClaim(target, memberKey(1), { claim: e, signature: e.sigs[0] })).toBe(false);
    }
  });

  it("rebuilds the anchor message the creator signed, so a fresh key signs the same bytes", () => {
    const a0 = vectors.anchors[0]!;
    const msg = anchorSignBytesV2({
      chainId: vectors.chainId,
      layerId: vectors.layerId,
      layerHeight: a0.layerHeight,
      stateRoot: a0.stateRoot.slice(2),
      validatorSetHash: a0.validatorSetHash.slice(2),
      transactionCount: a0.transactionCount,
      compressedStateProof: a0.compressedStateProof.slice(2),
    });
    expect(`0x${Buffer.from(msg).toString("hex")}`).toBe(a0.signBytes);
    expect(pqcVerify(hexToBytes(vectors.creatorPublicKey.slice(2)), msg, hexToBytes(a0.signature.slice(2)))).toBe(true);
    const fresh = generatePqcKeypair();
    expect(pqcVerify(hexToBytes(vectors.creatorPublicKey.slice(2)), msg, pqcSign(fresh.secretKey, msg))).toBe(false);
  });
});

describe("the cases", () => {
  const cases = buildCases(inputs());

  it("has 3 honest controls first, then the attacks, with unique ids", () => {
    expect(cases.slice(0, 3).map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    expect(cases.slice(0, 3).every((c) => c.kind === "control" && c.expect === "ok")).toBe(true);
    expect(cases.slice(3).every((c) => c.kind === "attack" && c.expect !== "ok")).toBe(true);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.kind === "attack")).toHaveLength(23);
    expect(buildCases(inputs(false)).filter((c) => c.kind === "attack")).toHaveLength(22);
  });

  it("calls the function it names on the contract it names, with calldata that decodes", () => {
    for (const c of cases) {
      const d = decodeFunctionData({ abi: ABIS[c.contract], data: c.data });
      expect(d.functionName).toBe(c.fn);
      expect(c.to ?? c.code).toBeTruthy();
    }
  });

  it("expects only errors the contract declares, with the right arguments", () => {
    for (const c of cases.filter((x) => x.kind === "attack")) {
      const name = c.expect.replace(/\(.*$/, "");
      expect(ABIS[c.contract].some((x) => x.type === "error" && x.name === name), `${c.id} ${c.expect}`).toBe(true);
    }
  });

  it("runs the exit replays at the right blocks: before each payment, after it, and at the head", () => {
    const at = (title: string) => cases.filter((c) => c.title === title).map((c) => c.block);
    expect(cases.find((c) => c.id === "C1")!.block).toBe(10_629_907n);
    expect(cases.find((c) => c.id === "C2")!.block).toBe(10_686_384n);
    expect(at("The same exit fronted again")).toEqual([10_629_909n, 10_686_386n]);
    expect(at("Fronted after its deadline")).toEqual([10_900_000n]);
  });

  it("changes what the watchtowers signed in every field attack, so their real signatures no longer match", () => {
    const fronts = cases.filter((c) => c.fn === "front" && c.kind === "attack" && c.code === undefined);
    let fieldAttacks = 0;
    for (const c of fronts) {
      const { args } = decodeFunctionData({ abi: ABIS.InstantExitVault, data: c.data });
      const [e, signers, sigs] = args as unknown as [ReturnType<typeof exitStruct>, bigint[], Hex[]];
      const real = exits.find((x) => BigInt(x.batchIndex) === e.batchIndex || exitStruct(x, PAYOUT).stateRoot === e.stateRoot)!;
      const honest = exitStruct(real, PAYOUT);
      const changed = (Object.keys(honest) as (keyof typeof honest)[]).filter((k) => String(honest[k]).toLowerCase() !== String(e[k]).toLowerCase());
      if (changed.length === 0) continue; // signature, signer or timing attacks: the exit itself is honest
      fieldAttacks += 1;
      expect(changed, c.title).toHaveLength(1);
      expect(signers).toEqual([0n, 1n]);
      // Only the payout's exit address is signed, so a changed payout changes the signed recipient.
      const claim: ExitClaim =
        changed[0] === "payout"
          ? { ...real, recipient: "00".repeat(20) }
          : { ...real, batchIndex: Number(e.batchIndex), withdrawalIndex: Number(e.withdrawalIndex), amountUqor: e.amountUqor, deadline: Number(e.deadline) };
      expect(Buffer.from(exitMessage(target, claim)).equals(Buffer.from(exitMessage(target, real)))).toBe(false);
      for (const m of [0, 1]) expect(verifyClaim(target, memberKey(m), { claim, signature: hexToBytes(sigs[m]!.slice(2)) })).toBe(false);
    }
    expect(fieldAttacks).toBe(5);
  });

  it("forges one bit of a real signature, which then fails", () => {
    const e = exits[0]!;
    const forged = flipBit(e.sigs[0], 100);
    expect(forged.filter((b, i) => b !== e.sigs[0][i])).toHaveLength(1);
    expect(verifyClaim(target, memberKey(0), { claim: e, signature: forged })).toBe(false);
  });
});

describe("answers", () => {
  const err = (contract: ContractName, errorName: string, args: unknown[] = []) =>
    encodeErrorResult({ abi: ABIS[contract], errorName, args } as Parameters<typeof encodeErrorResult>[0]);

  it("decodes reverts to the contract's named custom errors", () => {
    expect(decodeRevert("InstantExitVault", err("InstantExitVault", "BadSignature", [0n]))).toBe("BadSignature(0)");
    expect(decodeRevert("InstantExitVault", err("InstantExitVault", "BadSignature", [2n ** 256n - 1n]))).toBe("BadSignature(max)");
    expect(decodeRevert("InstantExitVault", err("InstantExitVault", "AlreadyFronted"))).toBe("AlreadyFronted()");
    expect(decodeRevert("InstantExitVault", err("InstantExitVault", "KeyNotUsable", [getAddress(ATTACKER)]))).toBe(`KeyNotUsable(${getAddress(ATTACKER)})`);
    expect(decodeRevert("SettlementReceiptVerifier", err("SettlementReceiptVerifier", "InvalidAnchor", [3]))).toBe("InvalidAnchor(BadSignature)");
    expect(decodeRevert("SettlementReceiptVerifier", err("SettlementReceiptVerifier", "InvalidAnchor", [1]))).toBe("InvalidAnchor(BadSignatureLength)");
    expect(decodeRevert("PQGuardVault", err("PQGuardVault", "BadSignature"))).toBe("BadSignature()");
    // The two BadSignature errors have different selectors; each contract decodes only its own.
    expect(decodeRevert("PQGuardVault", err("InstantExitVault", "BadSignature", [0n]))).toMatch(/^unknown revert 0x/);
    expect(decodeRevert("InstantExitVault", "0x")).toBe("reverted without data");
  });

  it("counts an attack as refused on any revert, as expected only on the expected error, and keeps 'not run' apart", () => {
    const cases = buildCases(inputs());
    const results = cases.map((c) => judge(c, c.expect));
    results[3] = judge(cases[3]!, "BadSignature(1)");
    results[4] = judge(cases[4]!, `${NOT_RUN}missing trie node`);
    results[5] = judge(cases[5]!, "ok");
    const s = summarize(results);
    expect(s).toEqual({ attacks: 23, refused: 21, asExpected: 20, controls: 3, controlsPassed: 3, notRun: 1 });
    expect(results[4]!.ok).toBeNull();
  });
});

describe("the error list matches the contracts", () => {
  const files: Record<ContractName, string> = {
    InstantExitVault: "contracts/src/InstantExitVault.sol",
    SettlementReceiptVerifier: "contracts/src/SettlementReceiptVerifier.sol",
    PQGuardVault: "contracts/src/PQGuardVault.sol",
  };
  for (const [contract, file] of Object.entries(files) as [ContractName, string][]) {
    it(`${contract}: every error the contract declares, with the same parameter types`, () => {
      // InstantExitVault.sol also holds ExitAddress, which declares no errors, so every error in each file is its contract's.
      const src = read(file);
      const declared = [...src.matchAll(/^\s*error (\w+)\(([^)]*)\);/gm)].map(([, name, params]) => {
        const types = (params ?? "")
          .split(",")
          .map((p) => p.trim().split(/\s+/)[0] ?? "")
          .filter(Boolean)
          .map((t) => (t === "Result" ? "uint8" : t));
        return `${name}(${types.join(",")})`;
      });
      const ours = ABIS[contract].flatMap((x) => (x.type === "error" ? [`${x.name}(${x.inputs.map((i) => i.type).join(",")})`] : []));
      expect(new Set(ours)).toEqual(new Set(declared));
      for (const f of ABIS[contract].filter((x) => x.type === "function")) {
        const name = (f as { name: string }).name;
        expect(new RegExp(`function ${name}\\(|public ${name};`).test(src), name).toBe(true);
      }
    });
  }
});

describe("docs/REDTEAM.md", () => {
  const cases = buildCases(inputs());
  const results = cases.map((c) => judge(c, c.expect));
  results[4] = judge(cases[4]!, `${NOT_RUN}the node no longer serves state at this block`);
  const report: Report = {
    run: { at: "2026-11-27T12:00:00.000Z", endpoint: "https://evm-testnet.qore.host", evmChainId: 9800, head: "10900000", requests: 31, minGapMs: 1100, attacker: ATTACKER },
    contracts: { InstantExitVault: VAULT, SettlementReceiptVerifier: dep.SettlementReceiptVerifier.address, PQGuardVault: dep.PQGuardVault.address },
    summary: summarize(results),
    results,
  };
  const md = renderMarkdown(report);

  it("states the run's date, block and counts, and has one table row per case", () => {
    expect(md).toContain("**Run of 27 Nov 2026, 12:00 UTC, at EVM block 10,900,000: 22 of 23 attacks refused, 22 of them with the custom error we expected; 3 of 3 honest controls passed.** 1 could not run");
    for (const r of results) expect(md).toContain(`| ${r.id} |`);
    expect(md).toContain("not run: the node no longer serves state at this block");
  });

  it("makes none of the claims the repo rules out", () => {
    expect(md).not.toMatch(/quantum-(proof|safe)|unbreakable|\bfirst\b|\bonly\b.*\bproject\b|\bunique\b/i);
  });
});
