/**
 * The sequencer's local copy of the rollup state: the qledger ledger after the
 * latest batch, saved after every batch so a restart does not need a full
 * replay (finalized batch records are pruned after 432,000 blocks).
 *
 * The snapshot is a cache, never an authority: on start it is checked against
 * the chain's latest batch root, and any batches it is missing are replayed
 * and checked root by root (see sync.ts).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { QledgerLedger, bytesToHex, hexToBytes } from "@qorechain/rdk";

export interface LedgerSnapshot {
  version: 1;
  chainId: string;
  rollupId: string;
  /** The batch this state follows; -1 before the first batch. */
  batchIndex: number;
  /** The last inbox sequence consumed by that batch; 0 before the first batch. */
  inboxEnd: number;
  /** Hex, no 0x. */
  stateRoot: string;
  /** Every non-zero account, sorted by id (hex ids, decimal amounts). */
  accounts: { id: string; balance: string; nonce: string }[];
  savedAt: string;
}

export interface LedgerState {
  ledger: QledgerLedger;
  batchIndex: number;
  inboxEnd: number;
}

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

export function emptyState(): LedgerState {
  return { ledger: new QledgerLedger(), batchIndex: -1, inboxEnd: 0 };
}

export function snapshotOf(env: { chainId: string; rollupId: string }, s: LedgerState, savedAt: string): LedgerSnapshot {
  return {
    version: 1,
    chainId: env.chainId,
    rollupId: env.rollupId,
    batchIndex: s.batchIndex,
    inboxEnd: s.inboxEnd,
    stateRoot: hex(s.ledger.root()),
    accounts: s.ledger.accounts().map((a) => ({ id: hex(a.id), balance: a.balance.toString(), nonce: a.nonce.toString() })),
    savedAt,
  };
}

/** Rebuild the ledger and refuse a snapshot whose accounts do not hash to its root. */
export function stateFrom(snap: LedgerSnapshot, env: { chainId: string; rollupId: string }): LedgerState {
  if (snap.version !== 1) throw new Error(`unsupported snapshot version ${String(snap.version)}`);
  if (snap.chainId !== env.chainId || snap.rollupId !== env.rollupId) {
    throw new Error(`snapshot is for ${snap.chainId}/${snap.rollupId}, not ${env.chainId}/${env.rollupId}`);
  }
  const ledger = new QledgerLedger();
  for (const a of snap.accounts) ledger.set(hexToBytes(a.id), BigInt(a.balance), BigInt(a.nonce));
  const root = hex(ledger.root());
  if (root !== snap.stateRoot.toLowerCase()) {
    throw new Error(`snapshot accounts hash to ${root}, not the saved root ${snap.stateRoot}`);
  }
  return { ledger, batchIndex: snap.batchIndex, inboxEnd: snap.inboxEnd };
}

export function loadSnapshot(path: string): LedgerSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LedgerSnapshot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write to a temporary file and rename it over the old one, so a crash never leaves half a snapshot. */
export function saveSnapshot(path: string, snap: LedgerSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + "\n");
  renameSync(tmp, path);
}
