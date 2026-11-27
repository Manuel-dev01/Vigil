/**
 * The footer's "What's inside" label: each primitive Vigil relies on, where it is used, and how it is classed.
 * Written by hand from the code and the QoreScan run in cbom/ (cbom/vigil.cdx.json, cbom/scan.json);
 * apps/web/test/inside.test.ts checks every scanned fact here against that CBOM, so the two cannot drift.
 * An inventory aid, not a certification.
 */

/** Our wording for a class. QoreScan's own term is kept in `qorescan` where the scan saw the primitive. */
export type InsideClass = "post-quantum" | "hybrid" | "classical" | "hash";

export interface InsidePrimitive {
  name: string;
  cls: InsideClass;
  /** What the class means here, in a few words. */
  clsNote: string;
  /** Where Vigil uses it. */
  where: string;
  /** What the scan saw, or why it could not see it, and the evidence. */
  seen: string;
  /** The algorithm's name in the CBOM and QoreScan's class for it, when the scan recorded it. */
  qorescan?: { name: string; cls: "post-quantum" | "hybrid" | "quantum-vulnerable" | "symmetric" };
}

export interface InsideTls {
  host: string;
  group: string;
  cls: InsideClass;
  /** What the page or our services use the host for. */
  role: string;
}

/** The scan the label quotes: cbom/scan.json. */
export const SCAN = {
  tool: "QoreScan 0.1.0",
  date: "2026-11-27",
  height: "~10,861,021",
  cbom: "cbom/vigil.cdx.json",
} as const;

export const INSIDE: readonly InsidePrimitive[] = [
  {
    name: "ML-DSA-87",
    cls: "post-quantum",
    clsNote: "FIPS 204, NIST category 5",
    where:
      "Signs every batch anchor (the settlement receipts), both watchtowers' exit signatures, and the post-quantum half of every operator transaction on L1. The contracts check it through the pqcVerify and pqcKeyStatus precompiles.",
    seen: "Scanned: in the three contracts, and as the registered key of each of our 10 L1 accounts, as the node reports. EVIDENCE 16, 104.",
    qorescan: { name: "ML-DSA-87", cls: "post-quantum" },
  },
  {
    name: "ML-DSA-44",
    cls: "post-quantum",
    clsNote: "FIPS 204, NIST category 2",
    where: "Signs every L2 transaction (qledger-v1 fixes it). This page checks those signatures in your browser.",
    seen: "Not scanned: QoreScan reads contracts, chain state and TLS, not L2 transactions. EVIDENCE 17.",
  },
  {
    name: "ML-KEM-1024 with X25519 (QoreSeal)",
    cls: "hybrid",
    clsNote: "ML-KEM-1024 is post-quantum (FIPS 203); X25519 is classical; AES-256-GCM encrypts the payslip",
    where: "Seals each payslip to its three recipients.",
    seen: "Scanned: employer-1's ML-KEM-1024 key in the chain's KEM registry, as the node reports. The sealing runs in TypeScript, which QoreScan does not read. EVIDENCE 37, 115, 122.",
    qorescan: { name: "ML-KEM-1024", cls: "post-quantum" },
  },
  {
    name: "SHA-256",
    cls: "hash",
    clsNote: "QoreScan classes hashes as symmetric",
    where: "qledger-v1 state roots, withdrawals roots and transaction hashes (in the RDK), the key pins in this page, and TLS.",
    seen: "Scanned in TLS. The rollup's use is TypeScript, not scanned.",
    qorescan: { name: "SHA-256", cls: "symmetric" },
  },
  {
    name: "Keccak-256",
    cls: "hash",
    clsNote: "QoreScan classes hashes as symmetric",
    where: "In the contracts: exit message and exit-address hashes, and the chain-id check. On the EVM: addresses and transactions.",
    seen: "Scanned: in the three contracts, and on the EVM lane as the node reports.",
    qorescan: { name: "Keccak-256", cls: "symmetric" },
  },
  {
    name: "ECDSA secp256k1",
    cls: "classical",
    clsNote: "quantum-vulnerable",
    where:
      "The classical half of each hybrid L1 transaction (the chain's hybrid mode is required, as the node reports); EVM transactions, which run inside windows that the ML-DSA-87 key opens; and the bootstrap transaction that registers each account's ML-DSA-87 key. No Vigil contract verifies it: CI fails if one does.",
    seen: "Scanned: the classical key of each of our 10 L1 accounts and the EVM lane, as the node reports. None in the contracts. EVIDENCE 98 (a classical-signed bootstrap).",
    qorescan: { name: "ECDSA secp256k1", cls: "quantum-vulnerable" },
  },
  {
    name: "Ed25519",
    cls: "classical",
    clsNote: "quantum-vulnerable",
    where: "QoreChain's validator consensus keys, below Vigil. Our claims hold given an honest L1.",
    seen: "Scanned: 4 active validators with Ed25519 keys, as the node reports.",
    qorescan: { name: "Ed25519", cls: "quantum-vulnerable" },
  },
];

/** TLS key exchange, one handshake per host. */
export const TLS: readonly InsideTls[] = [
  { host: "vigil-pq.up.railway.app", group: "X25519", cls: "classical", role: "serves this page" },
  { host: "rpc-testnet.qore.host", group: "X25519MLKEM768", cls: "hybrid", role: "the node this page reads" },
  { host: "evm-testnet.qore.host", group: "X25519MLKEM768", cls: "hybrid", role: "the EVM endpoint this page reads" },
  { host: "api-testnet.qore.host", group: "X25519MLKEM768", cls: "hybrid", role: "the REST endpoint our services read" },
];

/** What each group is made of. */
export const TLS_NOTE: Record<string, string> = {
  X25519MLKEM768: "ML-KEM-768 is post-quantum; X25519 is classical",
  X25519: "classical, quantum-vulnerable",
};
