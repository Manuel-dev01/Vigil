/**
 * The attack catalogue behind `pnpm redteam` (scripts/redteam.ts): what each attack sends to which
 * deployed contract, at which block, and which custom error the contract must answer with.
 *
 * Pure: no network and no keys. The runner gathers the inputs (the real exit attestations from the
 * public inbox archive, the creator's real anchors, a few values read from the contracts, and
 * signatures from throwaway keys it makes in memory), builds the cases here, sends each one as a
 * free eth_call and judges the answers here.
 */
import { bytesToHex, hexToBytes } from "@qorechain/rdk";
import { decodeAttestation } from "@vigil/qledger-watchtower";
import {
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiParameters,
  type Abi,
  type Hex,
} from "viem";

export type ContractName = "InstantExitVault" | "SettlementReceiptVerifier" | "PQGuardVault";

/** The parts of each contract's interface the catalogue calls, and every custom error it declares. */
export const ABIS: Record<ContractName, Abi> = {
  InstantExitVault: parseAbi([
    "struct Exit { uint64 batchIndex; bytes32 stateRoot; uint64 withdrawalIndex; uint64 amountUqor; address payout; uint64 deadline; }",
    "function front(Exit e, uint256[] signers, bytes[] sigs)",
    "function withdrawNonce() view returns (uint256)",
    "function withdrawMessage(address to, uint256 amount, uint256 nonce, uint64 deadline) view returns (bytes)",
    "function withdrawLiquidity(address to, uint256 amount, uint256 nonce, uint64 deadline, bytes sig)",
    "function settle(address payout) payable",
    "error BadConfig()",
    "error UnknownChain()",
    "error Expired()",
    "error AlreadyFronted()",
    "error NotEnoughSigners()",
    "error SignersNotAscending()",
    "error BadSignature(uint256 member)",
    "error KeyNotUsable(address member)",
    "error NotEnoughLiquidity(uint256 available, uint256 needed)",
    "error NotExitAddress()",
    "error BadNonce()",
    "error PrecompileUnavailable()",
    "error TransferFailed()",
  ]),
  SettlementReceiptVerifier: parseAbi([
    "struct Anchor { uint64 layerHeight; bytes32 stateRoot; bytes validatorSetHash; uint64 transactionCount; bytes compressedStateProof; bytes signature; }",
    "function attest(Anchor a) returns (bool recorded)",
    "error UnknownChain()",
    "error ZeroCreator()",
    "error PrecompileUnavailable()",
    "error InvalidAnchor(uint8 result)",
  ]),
  PQGuardVault: parseAbi([
    "function nonce() view returns (uint256)",
    "function releaseMessage(address token, address recipient, uint256 amount, uint256 deadline, uint256 nonce_) view returns (bytes)",
    "function release(address token, address recipient, uint256 amount, uint256 deadline, bytes signature)",
    "error ZeroGuardian()",
    "error Expired()",
    "error KeyNotUsable()",
    "error BadSignature()",
    "error PrecompileUnavailable()",
    "error TransferFailed()",
  ]),
};

/** InstantExitVault's constructor arguments, to split its creation code from them. */
export const VAULT_CTOR = parseAbiParameters("string chainId, string rollupId, address[] members, uint256 threshold, address lp, uint16 feeBps");

/** SettlementReceiptVerifier.Result, in declaration order. */
export const ANCHOR_RESULTS = ["Valid", "BadSignatureLength", "KeyNotUsable", "BadSignature"] as const;

const MAX_UINT256 = 2n ** 256n - 1n;

// ---------------------------------------------------------------- inputs

/** One exit the vault really paid, with both quorum members' real signatures from the inbox. */
export interface RealExit {
  batchIndex: number;
  /** 64 hex, no 0x. */
  stateRoot: string;
  withdrawalIndex: number;
  amountUqor: bigint;
  /** The withdrawal's recipient (the payout's exit address), 40 hex, no 0x. */
  recipient: string;
  deadline: number;
  /** ML-DSA-87 signatures in quorum order (index 0 is watchtower-2, index 1 watchtower-3). */
  sigs: [Uint8Array, Uint8Array];
  /** The inbox sequences of the two attestations, in quorum order. */
  entries: [number, number];
}

/** Where and when the vault paid a real exit (EVIDENCE rows). */
export interface Fronted {
  frontBlock: bigint;
  tx: string;
  evidence: string;
}

/**
 * The exits both quorum members attested for `vault`, read from the public inbox archive
 * (data/inbox/<rollup>.jsonl, one JSON object per line with `sequence` and `payloadHex`).
 * `members` are the quorum's 20-byte addresses in the vault's order.
 */
export function realExits(archive: string, vault: string, members: readonly string[]): RealExit[] {
  const norm = (h: string) => h.toLowerCase().replace(/^0x/, "");
  const want = members.map(norm);
  const byExit = new Map<string, { claim: RealExit; sigs: (Uint8Array | undefined)[]; entries: (number | undefined)[] }>();
  for (const line of archive.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { sequence: number; payloadHex: string };
    const a = decodeAttestation(hexToBytes(e.payloadHex));
    if (!a || norm(a.vault) !== norm(vault)) continue;
    const m = want.indexOf(norm(a.member));
    if (m < 0) continue;
    for (const s of a.claims) {
      const c = s.claim;
      const key = `${c.batchIndex}:${c.stateRoot}:${c.withdrawalIndex}:${c.amountUqor}:${c.recipient}:${c.deadline}`;
      const cur = byExit.get(key) ?? {
        claim: { ...c, sigs: [new Uint8Array(), new Uint8Array()], entries: [0, 0] },
        sigs: members.map(() => undefined),
        entries: members.map(() => undefined),
      };
      cur.sigs[m] = s.signature;
      cur.entries[m] = e.sequence;
      byExit.set(key, cur);
    }
  }
  const out: RealExit[] = [];
  for (const { claim, sigs, entries } of byExit.values()) {
    const [s0, s1] = sigs;
    const [e0, e1] = entries;
    if (!s0 || !s1 || e0 === undefined || e1 === undefined) continue;
    out.push({ ...claim, sigs: [s0, s1], entries: [e0, e1] });
  }
  return out.sort((x, y) => x.batchIndex - y.batchIndex);
}

/** An anchor as test/vectors/anchors-<layer>.json records it (all hex 0x-prefixed). */
export interface AnchorIn {
  layerHeight: number;
  stateRoot: Hex;
  validatorSetHash: Hex;
  transactionCount: number;
  compressedStateProof: Hex;
  signature: Hex;
}

export interface Inputs {
  vault: Hex;
  verifier: Hex;
  guard: Hex;
  /** The real exits' payout address. */
  payout: Hex;
  /** The attacker: the address of a throwaway secp256k1 key made for the run. */
  attacker: Hex;
  head: bigint;
  /** The two real exits, oldest first, each with where it was fronted. */
  exits: [RealExit & Fronted, RealExit & Fronted];
  anchors: AnchorIn[];
  /** Signatures from the throwaway keys, each over the exact message the contract checks. */
  fresh: {
    /** ML-DSA-87, over the first exit's real exit message. */
    exitSig: Uint8Array;
    /** ML-DSA-87, over anchor `anchors[0]`'s v2 anchor message. */
    anchorSig: Uint8Array;
    /** ML-DSA-87, over the vault's withdrawMessage for `lpWithdraw`. */
    withdrawSig: Uint8Array;
    /** ML-DSA-87, over PQGuardVault's releaseMessage for `release`. */
    releaseSig: Uint8Array;
    /** secp256k1 ECDSA (65 bytes), over the keccak-256 of the first exit's exit message. */
    ecdsaSig: Uint8Array;
  };
  lpWithdraw: { amount: bigint; nonce: bigint; deadline: bigint };
  release: { amount: bigint; nonce: bigint; deadline: bigint };
  /** The vault's own creation code with another rollup id, to run in place; undefined if it could not be built. */
  otherVault: { code: Hex; rollupId: string } | undefined;
}

// ---------------------------------------------------------------- cases

export interface Case {
  id: string;
  kind: "attack" | "control";
  contract: ContractName;
  fn: string;
  title: string;
  /** What was sent, in words. */
  how: string;
  block: bigint;
  /** A deployed contract, or undefined when `code` (creation code run in place) is given. */
  to: Hex | undefined;
  code: Hex | undefined;
  from: Hex;
  data: Hex;
  /** "ok", or the custom error the contract must revert with, e.g. "BadSignature(0)". */
  expect: string;
  evidence: string;
}

export interface ExitStruct {
  batchIndex: bigint;
  stateRoot: Hex;
  withdrawalIndex: bigint;
  amountUqor: bigint;
  payout: Hex;
  deadline: bigint;
}

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;

/** A copy of `b` with the lowest bit of byte `at` flipped. */
export function flipBit(b: Uint8Array, at: number): Uint8Array {
  const c = b.slice();
  c[at] = (c[at] ?? 0) ^ 0x01;
  return c;
}

/** A 32-byte hex value with its top bit flipped. */
export function flipRoot(root: Hex): Hex {
  return `0x${(BigInt(root) ^ (1n << 255n)).toString(16).padStart(64, "0")}`;
}

export const exitStruct = (e: RealExit, payout: Hex): ExitStruct => ({
  batchIndex: BigInt(e.batchIndex),
  stateRoot: `0x${e.stateRoot}`,
  withdrawalIndex: BigInt(e.withdrawalIndex),
  amountUqor: e.amountUqor,
  payout,
  deadline: BigInt(e.deadline),
});

const frontData = (ex: ExitStruct, signers: bigint[], sigs: Hex[]): Hex =>
  encodeFunctionData({ abi: ABIS.InstantExitVault, functionName: "front", args: [ex, signers, sigs] });

const attestData = (a: AnchorIn): Hex =>
  encodeFunctionData({
    abi: ABIS.SettlementReceiptVerifier,
    functionName: "attest",
    args: [{ ...a, layerHeight: BigInt(a.layerHeight), transactionCount: BigInt(a.transactionCount) }],
  });

/** Every case, controls first. Ids are stable: C1 to C3, A01 onwards. */
export function buildCases(inp: Inputs): Case[] {
  const [e15, e18] = inp.exits;
  const before15 = e15.frontBlock - 1n;
  const before18 = e18.frontBlock - 1n;
  const x15 = exitStruct(e15, inp.payout);
  const x18 = exitStruct(e18, inp.payout);
  const s15 = e15.sigs.map(hex) as [Hex, Hex];
  const s18 = e18.sigs.map(hex) as [Hex, Hex];
  const both = [0n, 1n];
  const ev15 = `EVIDENCE 88, 89, 91; inbox entries ${e15.entries[1]} and ${e15.entries[0]}`;
  const ev18 = `EVIDENCE 101, 102, 104; inbox entries ${e18.entries[1]} and ${e18.entries[0]}`;
  const vault = { contract: "InstantExitVault" as const, to: inp.vault, code: undefined, from: inp.attacker };
  const verifier = { contract: "SettlementReceiptVerifier" as const, fn: "attest", to: inp.verifier, code: undefined, from: inp.attacker, block: inp.head };
  const guard = { contract: "PQGuardVault" as const, fn: "release", to: inp.guard, code: undefined, from: inp.attacker, block: inp.head };
  const a0 = inp.anchors.find((a) => a.layerHeight === 0);
  if (!a0) throw new Error("the anchors must include layer height 0");
  // Two neighbouring heights with the same state root: one's signature must not pass for the other.
  const pairAt = inp.anchors.findIndex((a, i) => i > 0 && a.stateRoot === inp.anchors[i - 1]!.stateRoot);
  if (pairAt < 1) throw new Error("the anchors must include two neighbouring heights with the same state root");
  const pa = inp.anchors[pairAt - 1]!;
  const pb = inp.anchors[pairAt]!;
  const ecdsa = hex(inp.fresh.ecdsaSig);

  const cases: Omit<Case, "id">[] = [
    // ------------------------------------------------------------ honest controls
    {
      ...vault,
      kind: "control",
      fn: "front",
      title: `Front batch ${e15.batchIndex}'s exit with both real signatures`,
      how: `The exit exactly as both watchtowers signed it, one block before it was really paid (tx ${e15.tx}).`,
      block: before15,
      data: frontData(x15, both, s15),
      expect: "ok",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "control",
      fn: "front",
      title: `Front batch ${e18.batchIndex}'s exit with both real signatures`,
      how: `The exit exactly as both watchtowers signed it, one block before the relayer paid it (tx ${e18.tx}).`,
      block: before18,
      data: frontData(x18, both, s18),
      expect: "ok",
      evidence: ev18,
    },
    {
      ...verifier,
      kind: "control",
      title: "Attest the creator's real anchor at layer height 0",
      how: "The anchor as the chain stores it. It is already on the contract's record, so the call succeeds and records nothing new.",
      data: attestData(a0),
      expect: "ok",
      evidence: "EVIDENCE 16, 62",
    },

    // ------------------------------------------------------------ InstantExitVault: signatures
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "One bit of a quorum signature changed",
      how: "watchtower-2's real ML-DSA-87 signature with one bit of byte 100 flipped.",
      block: before15,
      data: frontData(x15, both, [hex(flipBit(e15.sigs[0], 100)), s15[1]]),
      expect: "BadSignature(0)",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Signed by a key that is not a quorum member",
      how: "A fresh ML-DSA-87 key, made for this run, signs the exact exit message in watchtower-2's place.",
      block: before15,
      data: frontData(x15, both, [hex(inp.fresh.exitSig), s15[1]]),
      expect: "BadSignature(0)",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "A classical signature instead of ML-DSA-87",
      how: "A fresh secp256k1 key signs the exit message with ECDSA (65 bytes) in watchtower-2's place.",
      block: before15,
      data: frontData(x15, both, [ecdsa, s15[1]]),
      expect: "BadSignature(0)",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Only one member signs",
      how: "watchtower-2's real signature alone; the vault needs both.",
      block: before15,
      data: frontData(x15, [0n], [s15[0]]),
      expect: "NotEnoughSigners()",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "One member counted twice",
      how: "watchtower-2's real signature given twice, as signers 0 and 0.",
      block: before15,
      data: frontData(x15, [0n, 0n], [s15[0], s15[0]]),
      expect: "SignersNotAscending()",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Signatures swapped between members",
      how: "watchtower-3's real signature in watchtower-2's slot, and the other way round.",
      block: before18,
      data: frontData(x18, both, [s18[1], s18[0]]),
      expect: "BadSignature(0)",
      evidence: ev18,
    },

    // ------------------------------------------------------------ InstantExitVault: the signed fields
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Amount raised",
      how: `Both real signatures, with the amount raised from ${Number(e15.amountUqor) / 1e6} QOR to 100 QOR.`,
      block: before15,
      data: frontData({ ...x15, amountUqor: 100_000_000n }, both, s15),
      expect: "BadSignature(0)",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Payout changed to the attacker",
      how: "Both real signatures, with the attacker's address as the payout.",
      block: before15,
      data: frontData({ ...x15, payout: inp.attacker }, both, s15),
      expect: "BadSignature(0)",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Another withdrawal",
      how: `Both real signatures, claimed for withdrawal ${e18.withdrawalIndex + 1} instead of ${e18.withdrawalIndex}.`,
      block: before18,
      data: frontData({ ...x18, withdrawalIndex: x18.withdrawalIndex + 1n }, both, s18),
      expect: "BadSignature(0)",
      evidence: ev18,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Another batch",
      how: `Both real signatures, claimed for batch ${e18.batchIndex + 1} instead of ${e18.batchIndex}.`,
      block: before18,
      data: frontData({ ...x18, batchIndex: x18.batchIndex + 1n }, both, s18),
      expect: "BadSignature(0)",
      evidence: ev18,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Deadline pushed back",
      how: "Both real signatures, with the deadline a day later, past the time the batch could be final.",
      block: before18,
      data: frontData({ ...x18, deadline: x18.deadline + 86_400n }, both, s18),
      expect: "BadSignature(0)",
      evidence: ev18,
    },

    // ------------------------------------------------------------ InstantExitVault: replay and timing
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "The same exit fronted again",
      how: `Both real signatures, one block after batch ${e15.batchIndex}'s exit was paid.`,
      block: e15.frontBlock + 1n,
      data: frontData(x15, both, s15),
      expect: "AlreadyFronted()",
      evidence: ev15,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "The same exit fronted again",
      how: `Both real signatures, one block after batch ${e18.batchIndex}'s exit was paid.`,
      block: e18.frontBlock + 1n,
      data: frontData(x18, both, s18),
      expect: "AlreadyFronted()",
      evidence: ev18,
    },
    {
      ...vault,
      kind: "attack",
      fn: "front",
      title: "Fronted after its deadline",
      how: `Both real signatures for batch ${e18.batchIndex}'s exit, at the run's head block.`,
      block: inp.head,
      data: frontData(x18, both, s18),
      expect: "Expired()",
      evidence: ev18,
    },
    ...(inp.otherVault
      ? [
          {
            ...vault,
            kind: "attack" as const,
            fn: "front",
            title: "Replayed at a vault for another rollup",
            how: `Both real signatures, sent to a copy of the vault built for rollup "${inp.otherVault.rollupId}" (the deployed vault's own creation code, run in place; nothing is deployed).`,
            block: before15,
            to: undefined,
            code: inp.otherVault.code,
            data: frontData(x15, both, s15),
            expect: "BadSignature(0)",
            evidence: `${ev15}; creation code from the vault's deploy tx (EVIDENCE 83)`,
          },
        ]
      : []),

    // ------------------------------------------------------------ InstantExitVault: liquidity and debts
    {
      ...vault,
      kind: "attack",
      fn: "withdrawLiquidity",
      title: "Take the LP's liquidity without the LP's key",
      how: `A fresh ML-DSA-87 key signs the vault's exact withdrawal message for ${Number(inp.lpWithdraw.amount) / 1e18} QOR to the attacker, at the vault's current nonce.`,
      block: inp.head,
      data: encodeFunctionData({
        abi: ABIS.InstantExitVault,
        functionName: "withdrawLiquidity",
        args: [inp.attacker, inp.lpWithdraw.amount, inp.lpWithdraw.nonce, inp.lpWithdraw.deadline, hex(inp.fresh.withdrawSig)],
      }),
      expect: "BadSignature(max)",
      evidence: "EVIDENCE 83, 85",
    },
    {
      ...vault,
      kind: "attack",
      fn: "settle",
      title: "Clear a payout's debt from another account",
      how: "The attacker calls settle for the real payout, as if it were that payout's exit address.",
      block: inp.head,
      data: encodeFunctionData({ abi: ABIS.InstantExitVault, functionName: "settle", args: [inp.payout] }),
      expect: "NotExitAddress()",
      evidence: "EVIDENCE 95, 108",
    },

    // ------------------------------------------------------------ SettlementReceiptVerifier
    {
      ...verifier,
      kind: "attack",
      title: "A state root the creator never signed",
      how: "The real anchor at layer height 0 with the top bit of its state root flipped.",
      data: attestData({ ...a0, stateRoot: flipRoot(a0.stateRoot) }),
      expect: "InvalidAnchor(BadSignature)",
      evidence: "EVIDENCE 16, 62",
    },
    {
      ...verifier,
      kind: "attack",
      title: "A signature moved to another layer height",
      how: `Heights ${pa.layerHeight} and ${pb.layerHeight} carry the same state root; height ${pa.layerHeight}'s real signature is presented for height ${pb.layerHeight}.`,
      data: attestData({ ...pb, signature: pa.signature }),
      expect: "InvalidAnchor(BadSignature)",
      evidence: "EVIDENCE 36, 38, 63",
    },
    {
      ...verifier,
      kind: "attack",
      title: "Signed by a key that is not the creator's",
      how: "A fresh ML-DSA-87 key signs the exact v2 anchor message for layer height 0.",
      data: attestData({ ...a0, signature: hex(inp.fresh.anchorSig) }),
      expect: "InvalidAnchor(BadSignature)",
      evidence: "EVIDENCE 16, 62",
    },
    {
      ...verifier,
      kind: "attack",
      title: "A classical signature instead of ML-DSA-87",
      how: "The ECDSA signature from the fresh secp256k1 key (65 bytes) in place of the anchor's signature.",
      data: attestData({ ...a0, signature: ecdsa }),
      expect: "InvalidAnchor(BadSignatureLength)",
      evidence: "EVIDENCE 16, 62",
    },

    // ------------------------------------------------------------ PQGuardVault
    {
      ...guard,
      kind: "attack",
      title: "Release the vault's QOR without the guardian's key",
      how: `A fresh ML-DSA-87 key signs the vault's exact release message for ${Number(inp.release.amount) / 1e18} QOR to the attacker, at the vault's current nonce.`,
      data: encodeFunctionData({
        abi: ABIS.PQGuardVault,
        functionName: "release",
        args: ["0x0000000000000000000000000000000000000000", inp.attacker, inp.release.amount, inp.release.deadline, hex(inp.fresh.releaseSig)],
      }),
      expect: "BadSignature()",
      evidence: "EVIDENCE 6, 8",
    },
    {
      ...guard,
      kind: "attack",
      title: "A classical signature instead of ML-DSA-87",
      how: "The same release with the fresh secp256k1 key's ECDSA signature (65 bytes).",
      data: encodeFunctionData({
        abi: ABIS.PQGuardVault,
        functionName: "release",
        args: ["0x0000000000000000000000000000000000000000", inp.attacker, inp.release.amount, inp.release.deadline, ecdsa],
      }),
      expect: "BadSignature()",
      evidence: "EVIDENCE 6, 8",
    },
  ];

  let a = 0;
  let c = 0;
  return cases.map((x) => ({ ...x, id: x.kind === "control" ? `C${++c}` : `A${String(++a).padStart(2, "0")}` }));
}

// ---------------------------------------------------------------- answers

const fmtArg = (v: unknown): string => {
  if (typeof v === "bigint") return v === MAX_UINT256 ? "max" : v.toString();
  if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) return getAddress(v);
  return String(v);
};

/** A revert's data as `Name(args)`, decoded with the contract's own errors. */
export function decodeRevert(contract: ContractName, data: Hex): string {
  try {
    const d = decodeErrorResult({ abi: ABIS[contract], data });
    const args = (d.args ?? []) as readonly unknown[];
    if (d.errorName === "InvalidAnchor") return `InvalidAnchor(${ANCHOR_RESULTS[Number(args[0])] ?? String(args[0])})`;
    return `${d.errorName}(${args.map(fmtArg).join(", ")})`;
  } catch {
    return data === "0x" ? "reverted without data" : `unknown revert ${data.slice(0, 10)}`;
  }
}

export interface Result {
  id: string;
  kind: "attack" | "control";
  contract: ContractName;
  fn: string;
  title: string;
  how: string;
  block: string;
  expect: string;
  /** The answer: "ok", a decoded custom error, or "not run: …" when the node could not answer. */
  got: string;
  /** Whether the answer is the expected one; null when the case could not run. */
  ok: boolean | null;
  evidence: string;
}

export const NOT_RUN = "not run: ";

export function judge(c: Case, got: string): Result {
  return {
    id: c.id,
    kind: c.kind,
    contract: c.contract,
    fn: c.fn,
    title: c.title,
    how: c.how,
    block: c.block.toString(),
    expect: c.expect,
    got,
    ok: got.startsWith(NOT_RUN) ? null : got === c.expect,
    evidence: c.evidence,
  };
}

export interface Summary {
  attacks: number;
  /** Attacks the contract refused (any revert). */
  refused: number;
  /** Attacks refused with exactly the expected custom error. */
  asExpected: number;
  controls: number;
  controlsPassed: number;
  notRun: number;
}

export function summarize(results: readonly Result[]): Summary {
  const attacks = results.filter((r) => r.kind === "attack");
  const controls = results.filter((r) => r.kind === "control");
  const ran = (r: Result) => r.ok !== null;
  return {
    attacks: attacks.length,
    refused: attacks.filter((r) => ran(r) && r.got !== "ok").length,
    asExpected: attacks.filter((r) => r.ok === true).length,
    controls: controls.length,
    controlsPassed: controls.filter((r) => r.ok === true).length,
    notRun: results.filter((r) => !ran(r)).length,
  };
}

/** Everything one run produced, as written to docs/redteam.json. */
export interface Report {
  run: {
    /** ISO 8601, UTC. */
    at: string;
    endpoint: string;
    evmChainId: number;
    head: string;
    requests: number;
    minGapMs: number;
    attacker: string;
  };
  contracts: Record<ContractName, string>;
  summary: Summary;
  results: Result[];
}

const CONTRACT_NOTES: Record<ContractName, string> = {
  InstantExitVault: "Pays a withdrawal before its batch is final, once both watchtowers have signed it with ML-DSA-87 (THREAT_MODEL §14).",
  SettlementReceiptVerifier: "Records a rollup anchor once the creator's ML-DSA-87 signature verifies through `pqcVerify` (THREAT_MODEL §5).",
  PQGuardVault: "The Q-Day Drill vault, funded with 25 QOR (EVIDENCE 8): funds move only with the guardian's ML-DSA-87 signature (THREAT_MODEL §6).",
};

const utcDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const utcClock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const block = (b: string) => Number(b).toLocaleString("en-GB");
const answer = (r: Result) => (r.ok === null ? r.got : r.ok ? `\`${r.got}\` ✓` : `\`${r.got}\` ✕ (expected \`${r.expect}\`)`);

/** docs/REDTEAM.md, from one run. */
export function renderMarkdown(rep: Report): string {
  const s = rep.summary;
  const day = utcDay(rep.run.at);
  const lines: string[] = [];
  lines.push("# Attack catalogue");
  lines.push("");
  lines.push(
    "`pnpm redteam` tries to break Vigil's three deployed contracts the way an attacker would, and records what each one answered. " +
      "Every call is a free `eth_call` to the public EVM endpoint: no real key signs anything, no transaction is sent and nothing changes on chain.",
  );
  lines.push("");
  lines.push(
    `**Run of ${day}, ${utcClock(rep.run.at)} UTC, at EVM block ${block(rep.run.head)}: ${s.refused} of ${s.attacks} attacks refused, ` +
      `${s.asExpected} of them with the custom error we expected; ${s.controlsPassed} of ${s.controls} honest controls passed.**` +
      (s.notRun ? ` ${s.notRun} could not run (see the table).` : "") +
      ` The answers are the contracts' own, from chain state as ${rep.run.endpoint.replace(/^https:\/\//, "")} reports it (${rep.run.requests} requests, at least ${(rep.run.minGapMs / 1000).toFixed(1)} s apart). The raw results are in [redteam.json](redteam.json).`,
  );
  lines.push("");
  lines.push("## Re-run it");
  lines.push("");
  lines.push("```bash");
  lines.push("pnpm install");
  lines.push("pnpm redteam           # prints every answer; exits non-zero if one differs from the expected one");
  lines.push("pnpm redteam --write   # also rewrites this file and docs/redteam.json");
  lines.push("```");
  lines.push("");
  lines.push(
    "The attacks that replay the two real exits run at the blocks just before and just after each was paid, when the signatures were still in date. " +
      "They need an endpoint that still serves state at those blocks. When it no longer does, those rows say \"not run\" instead of an answer; the rows at the head block still run.",
  );
  lines.push("");
  lines.push("## What it uses");
  lines.push("");
  lines.push(
    "- **The watchtowers' real exit attestations**, read from the rollup's public inbox archive (`data/inbox/vigil-pay-1.jsonl`): entries 18 and 19 for batch 15's exit, 21 and 22 for batch 18's (EVIDENCE 88, 89, 101, 102). Controls C1 and C2 show that these signatures pass.",
  );
  lines.push("- **The creator's real anchors** for layer heights 0 to 10, as recorded from the chain in `test/vectors/anchors-vigil-pay-1.json` (EVIDENCE 16, 36, 38, 62 and 63 for the ones used here).");
  lines.push(
    "- **Two throwaway keys**, an ML-DSA-87 key and a secp256k1 key, made in memory for the run and never saved. They play an attacker who has keys of their own but not ours. " +
      `The attacker's address is the secp256k1 key's (this run: \`${rep.run.attacker}\`).`,
  );
  lines.push("- **The deployed addresses** in `deployments/diana.json`.");
  lines.push("");
  lines.push("## Results");
  for (const contract of Object.keys(rep.contracts) as ContractName[]) {
    const rows = rep.results.filter((r) => r.contract === contract);
    if (!rows.length) continue;
    lines.push("");
    lines.push(`### ${contract} \`${rep.contracts[contract]}\``);
    lines.push("");
    lines.push(CONTRACT_NOTES[contract]);
    lines.push("");
    lines.push("| # | Attempt | What was sent | Call, block | Answer |");
    lines.push("|---|---|---|---|---|");
    for (const r of rows) {
      const title = r.kind === "control" ? `**Control:** ${r.title}` : r.title;
      lines.push(`| ${r.id} | ${cell(title)} | ${cell(r.how)}<br>${cell(r.evidence)} | \`${r.fn}\`, ${block(r.block)} | ${cell(answer(r))} |`);
    }
  }
  lines.push("");
  lines.push("## What this shows, and what it does not");
  lines.push("");
  lines.push(
    "- **Each answer is the deployed contract's own revert, decoded to its named custom error.** `eth_call` runs the same code a transaction would. " +
      "For the honest inputs the answers match what was mined: C1 passes one block before the same exit was paid by a mined `front` (EVIDENCE 91), C2 likewise (EVIDENCE 104), and `attest` was mined for the anchor in C3 (EVIDENCE 62).",
  );
  lines.push("- **The endpoint is trusted, as everywhere else in Vigil.** A dishonest node could answer falsely; the answers are not proven (README, Limitations).");
  lines.push(
    `- **It is a small catalogue: the ${s.attacks} attacks we thought of.** Refusing them is not a proof that no attack works. ` +
      "The Foundry suites in `contracts/test/` check the same properties against mocked precompiles, with fuzzing and invariants (THREAT_MODEL §11), and THREAT_MODEL §12 lists what our reviewers found.",
  );
  lines.push(
    "- **Not exercised here:** a PQGuardVault release with a real guardian signature and a changed amount, which needs the guardian's key (`test_RedirectedRecipientOrAmountFails` covers it in Foundry, and THREAT_MODEL §6 records the live check of 17 Nov); " +
      "a vault for another chain, which cannot run here because the constructor accepts only `qorechain-diana` on EVM chain 9800 (both chain ids are in every exit message, pinned byte for byte by `test_exitMessageLayout`); " +
      "and a quorum or LP key that is stolen or colludes, which is a design risk rather than a bug (THREAT_MODEL §13 and §14).",
  );
  lines.push("");
  lines.push("*Generated by `scripts/redteam.ts`; the cases are in `scripts/lib/redteam.ts`.*");
  lines.push("");
  return lines.join("\n");
}
