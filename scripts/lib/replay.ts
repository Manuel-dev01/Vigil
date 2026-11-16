/**
 * Replay a qledger-v1 rollup from chain data and check each batch it published.
 * This is the seed of Vigil's qledger watchtower. Every hash and tree comes
 * from @qorechain/rdk; nothing is hand-rolled.
 */
import {
  EMPTY_INBOX_ACC,
  QledgerLedger,
  bytesToHex,
  executeQledger,
  hexToBytes,
  inboxRangeHash,
  qledgerAccumulate,
  type QledgerEntry,
} from "@qorechain/rdk";

/** What a batch published, as recorded from the chain (hex strings, no 0x). */
export interface BatchFacts {
  batchIndex: number;
  status: string;
  inboxStart: number;
  inboxEnd: number;
  prevStateRoot: string;
  stateRoot: string;
  withdrawalsRoot: string;
  dataHash: string;
  txCount: number;
}

/** One inbox entry in a portable form. */
export interface EntryVector {
  sequence: number;
  height: number;
  poster: string;
  payloadHex: string;
}

/** Everything needed to re-check a rollup offline. */
export interface ReplayVector {
  chainId: string;
  rollupId: string;
  recordedAt: string;
  recordedAtHeight: number;
  /** Inbox accumulator after each sequence; key "0" is the empty accumulator. */
  inboxAcc: Record<string, string>;
  entries: EntryVector[];
  batches: BatchFacts[];
}

export interface BatchCheck {
  batchIndex: number;
  prevStateRootOk: boolean;
  stateRootOk: boolean;
  withdrawalsRootOk: boolean;
  dataHashOk: boolean;
  /** The inbox accumulator recomputed from the entries matches the chain's. */
  accOk: boolean;
  computed: { stateRoot: string; withdrawalsRoot: string; dataHash: string; withdrawals: number };
}

export const toEntry = (e: EntryVector): QledgerEntry => ({
  height: BigInt(e.height),
  poster: e.poster,
  payload: hexToBytes(e.payloadHex),
});

const hex = (b: Uint8Array): string => bytesToHex(b).toLowerCase();

/**
 * Re-execute every batch in order from an empty ledger and compare each
 * published field with the recomputed one. Pure: no network.
 */
export function checkBatches(v: ReplayVector): { checks: BatchCheck[]; ledger: QledgerLedger } {
  const env = { chainId: v.chainId, rollupId: v.rollupId };
  const ledger = new QledgerLedger();
  const checks: BatchCheck[] = [];
  const bySeq = new Map(v.entries.map((e) => [e.sequence, e]));

  for (const b of [...v.batches].sort((x, y) => x.batchIndex - y.batchIndex)) {
    const range: EntryVector[] = [];
    for (let s = b.inboxStart + 1; s <= b.inboxEnd; s++) {
      const e = bySeq.get(s);
      if (!e) throw new Error(`missing inbox entry ${s} for batch ${b.batchIndex}`);
      range.push(e);
    }
    const entries = range.map(toEntry);
    const accFrom = v.inboxAcc[String(b.inboxStart)];
    const accTo = v.inboxAcc[String(b.inboxEnd)];
    if (accFrom === undefined || accTo === undefined) {
      throw new Error(`missing inbox accumulator for batch ${b.batchIndex}`);
    }

    const accRecomputed = qledgerAccumulate({ ...env, from: b.inboxStart, accFrom, entries });
    const dataHash = inboxRangeHash({ ...env, from: b.inboxStart, to: b.inboxEnd, accFrom, accTo });

    const prevRoot = hex(ledger.root());
    const result = executeQledger(env, ledger, entries);

    checks.push({
      batchIndex: b.batchIndex,
      prevStateRootOk: prevRoot === b.prevStateRoot.toLowerCase(),
      stateRootOk: hex(result.stateRoot) === b.stateRoot.toLowerCase(),
      withdrawalsRootOk: hex(result.withdrawalsRoot) === b.withdrawalsRoot.toLowerCase(),
      dataHashOk: hex(dataHash) === b.dataHash.toLowerCase(),
      accOk: hex(accRecomputed) === accTo.toLowerCase(),
      computed: {
        stateRoot: hex(result.stateRoot),
        withdrawalsRoot: hex(result.withdrawalsRoot),
        dataHash: hex(dataHash),
        withdrawals: result.withdrawals.length,
      },
    });
  }
  return { checks, ledger };
}

export const EMPTY_ACC_HEX = hex(EMPTY_INBOX_ACC);

export const allOk = (c: BatchCheck): boolean =>
  c.prevStateRootOk && c.stateRootOk && c.withdrawalsRootOk && c.dataHashOk && c.accOk;
