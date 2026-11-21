/** Differential-fuzzing shim: runs qledger-v1 cases through the TypeScript RDK (published 0.9.0). */
import { createInterface } from "node:readline";
import { QledgerLedger, bytesToHex, executeQledger, hexToBytes } from "@qorechain/rdk";

type Case = { id: string; chainId: string; rollupId: string; batches: { entries: { height: number; poster: string; payload: string }[] }[] };

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const c = JSON.parse(line) as Case;
  const out: Record<string, unknown> = { id: c.id, batches: [] as unknown[] };
  try {
    const ledger = new QledgerLedger();
    for (const b of c.batches) {
      const entries = b.entries.map((e) => ({ height: BigInt(e.height), poster: e.poster, payload: hexToBytes(e.payload) }));
      try {
        const r = executeQledger({ chainId: c.chainId, rollupId: c.rollupId }, ledger, entries);
        (out.batches as unknown[]).push({
          stateRoot: bytesToHex(r.stateRoot),
          withdrawalsRoot: bytesToHex(r.withdrawalsRoot),
          withdrawals: r.withdrawals.map((w) => ({ index: String(w.index), recipient: w.recipient, amount: String(w.amount) })),
        });
      } catch (err) {
        (out.batches as unknown[]).push({ withdrawalsRoot: "", withdrawals: [], error: String((err as Error).message) });
      }
    }
  } catch (err) {
    out.error = String((err as Error).message);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}
