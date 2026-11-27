/**
 * The browser watchtower on vigil-pay-1's real history, recorded on 27 Nov 2026: 26 kept batches, two
 * fraud-drill batches the chain rolled back (both at reused indices), 28 inbox entries, five paid
 * withdrawals. No network.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QLEDGER_WITHDRAWAL_COUNTER_ID, bytesToHex, createRdkClient, hexToBytes, qledgerAccumulate } from "@qorechain/rdk";
import { chainRegistry, restOverWs, type WsRpc } from "@vigil/chain-ws";
import { describe, expect, it } from "vitest";
import { executedFrom, fraudsFrom, entriesWithArchive, parseArchive, submissionsFrom, type TxResponse } from "../src/replay/chain-data.ts";
import { batchKey, challengeCommand, forge, lookup, replay, type AnchorLite, type BatchRecord, type Entry, type ReplayInput } from "../src/replay/core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fx = JSON.parse(readFileSync(join(here, "fixtures", "replay-vigil-pay-1.json"), "utf8")) as {
  chainId: string;
  rollupId: string;
  rollup: { depositPool: string };
  inbox: { headSequence: number; headAcc: string };
  entries: { sequence: number; height: number; poster: string; payloadHex: string }[];
  batches: BatchRecord[];
  anchors: AnchorLite[];
  submitTxs: TxResponse[];
  fraudTxs: TxResponse[];
  executedTxs: TxResponse[];
};
const env = { chainId: fx.chainId, rollupId: fx.rollupId };
const archiveText = readFileSync(join(root, "data", "inbox", "vigil-pay-1.jsonl"), "utf8");
const archive = parseArchive(archiveText, env);
const after = fx.entries.map((e) => ({ sequence: e.sequence, height: e.height, poster: e.poster, payload: hexToBytes(e.payloadHex) }));
const entries: Entry[] = [...archive.map((r) => ({ sequence: r.sequence, height: r.height, poster: r.poster, payload: hexToBytes(r.payloadHex) })), ...after];

const input = (over: Partial<ReplayInput> = {}): ReplayInput => ({
  env,
  entries,
  headAcc: fx.inbox.headAcc,
  records: fx.batches,
  submissions: submissionsFrom(fx.submitTxs, fx.rollupId),
  anchors: fx.anchors,
  frauds: fraudsFrom(fx.fraudTxs, fx.rollupId),
  executed: executedFrom(fx.executedTxs, fx.rollupId),
  depositPool: fx.rollup.depositPool,
  ...over,
});

describe("reading the node's answers", () => {
  it("parses every batch submission, including the two rolled-back drill batches at reused indices", () => {
    const subs = submissionsFrom(fx.submitTxs, fx.rollupId);
    expect(subs).toHaveLength(28);
    const six = subs.filter((s) => s.batchIndex === 6);
    expect(six.map((s) => s.height)).toEqual([10_370_239, 10_370_263]);
    expect(six[0]!.stateRoot).toBe("078c8a0fa6d0918655ec681fc59eedaa26a5fab16a889a1b0b2477fc58dbd561");
    expect(six[0]!.sequencer).toBe("qor1kgvdpmv87386eyp7k577r55ttx9tf5m77jwygk");
    // Empty bytes arrive as null; they are the empty withdrawals root.
    expect(subs[0]!.withdrawalsRoot).toBe("");
    expect(subs[2]!.withdrawalsRoot).toBe(fx.batches[2]!.withdrawalsRoot);
  });

  it("reads a submission's raw transaction the way the page does, over the websocket", async () => {
    // Fraud drill 1's two batch-6 transactions as CometBFT served them (test/vectors), decoded by restOverWs
    // with the chain's descriptor snapshot and read through the RDK's own client, as read.ts reads them.
    const drill = JSON.parse(readFileSync(join(root, "test", "vectors", "drill-1-batch-txs.json"), "utf8")) as {
      txs: Record<"bad" | "honest", { hash: string; height: number; code: number; txBase64: string; events: Record<string, string[]> }>;
    };
    const unflatten = (m: Record<string, string[]>) => {
      const byType = new Map<string, { key: string; values: string[] }[]>();
      for (const [k, values] of Object.entries(m)) {
        const [type, key] = [k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1)];
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type)!.push({ key, values });
      }
      return [...byType].flatMap(([type, keys]) =>
        Array.from({ length: Math.max(...keys.map((x) => x.values.length)) }, (_, i) => ({ type, attributes: keys.map((x) => ({ key: x.key, value: x.values[i] ?? "" })) })),
      );
    };
    const rpc = {
      call: async (method: string) => {
        if (method === "header") return { header: { time: "2026-11-19T11:03:36Z" } };
        if (method !== "tx_search") throw new Error(method);
        const txs = [drill.txs.bad, drill.txs.honest].map((t) => ({ hash: t.hash, height: String(t.height), index: 0, tx: t.txBase64, tx_result: { code: t.code, events: unflatten(t.events) } }));
        return { txs, total_count: String(txs.length) };
      },
    } as unknown as WsRpc;
    const registry = chainRegistry(readFileSync(join(root, "packages", "chain-ws", "descriptors", "qorechain-diana.binpb")));
    const rest = createRdkClient({ network: "testnet", fetch: restOverWs(rpc, registry) }).rest;
    const overWs = submissionsFrom((await rest.searchTxs("batch_submitted.rollup_id='vigil-pay-1'")) as TxResponse[], fx.rollupId);
    const recorded = submissionsFrom(fx.submitTxs, fx.rollupId).filter((x) => x.batchIndex === 6);
    expect(overWs).toEqual(recorded);
  });

  it("skips failed transactions and other rollups' batches", () => {
    const t = fx.submitTxs[0]!;
    expect(submissionsFrom([{ ...t, code: 5 }], fx.rollupId)).toEqual([]);
    expect(submissionsFrom([t], "another-rollup")).toEqual([]);
  });

  it("parses upheld fraud proofs and paid withdrawals", () => {
    expect(fraudsFrom(fx.fraudTxs, fx.rollupId).map((f) => [f.batchIndex, f.height])).toEqual([
      [6, 10_370_243],
      [8, 10_382_607],
    ]);
    const paid = executedFrom(fx.executedTxs, fx.rollupId);
    expect(paid.map((e) => e.withdrawalIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(paid.reduce((n, e) => n + e.amount, 0n)).toBe(2_550_000n);
  });
});

describe("replaying vigil-pay-1 in the page", () => {
  const s = replay(input());
  const r = s.result;

  it("reproduces every kept batch", () => {
    expect(r.counts.kept).toBe(26);
    expect(r.counts.keptReproduced).toBe(26);
    expect(r.rows.filter((x) => x.where === "kept").every((x) => x.verdict === "reproduced" && x.mismatches.length === 0)).toBe(true);
  });

  it("keys verdicts on fields, so each drill batch is judged apart from the honest batch that reused its index", () => {
    const six = r.rows.filter((x) => x.batchIndex === 6);
    expect(six.map((x) => [x.where, x.verdict])).toEqual([
      ["rolled back", "differs"],
      ["kept", "reproduced"],
    ]);
    expect(new Set(six.map((x) => x.key)).size).toBe(2);
    for (const i of [6, 8]) {
      const bad = r.rows.find((x) => x.batchIndex === i && x.where === "rolled back")!;
      // Only the state root was wrong: one flipped digit in each drill.
      expect(bad.mismatches).toEqual(["stateRoot"]);
      expect(bad.challenge).toMatchObject({ wins: true });
      expect(bad.fraud?.height).toBe(i === 6 ? 10_370_243 : 10_382_607);
      expect(bad.anchor).toBeUndefined();
    }
    expect(r.counts.rolledBack).toBe(2);
    expect(r.counts.rolledBackCaught).toBe(2);
  });

  it("checks each anchor against the replayed root (batch 11 came from the standby and has none)", () => {
    const kept = r.rows.filter((x) => x.where === "kept");
    expect(kept.filter((x) => x.anchor?.matches)).toHaveLength(25);
    expect(kept.find((x) => !x.anchor)?.batchIndex).toBe(11);
    expect(r.lookupRoot?.batchIndex).toBe(25);
  });

  it("finds the L2 owes exactly what the deposit pool holds", () => {
    expect(r.solvency).toMatchObject({ owed: "2450000", pool: "2450000", surplus: "0", unpaid: "0", paidWithdrawals: 5, pendingEntries: 0 });
    // The withdrawal counter lives in the state tree as a balance; it is not money.
    expect(r.accounts.some((a) => a.id === bytesToHex(QLEDGER_WITHDRAWAL_COUNTER_ID).toLowerCase())).toBe(false);
  });

  it("counts a withdrawal with no L1 payment as owed", () => {
    const t = replay(input({ executed: executedFrom(fx.executedTxs, fx.rollupId).filter((e) => e.withdrawalIndex !== 1) })).result.solvency!;
    expect(t.unpaid).toBe("2000000");
    expect(BigInt(t.surplus)).toBe(-2_000_000n);
    expect(t.unpaidList.map((w) => w.batchIndex)).toEqual([10]);
  });

  it("refuses entries that do not fold to the chain's inbox accumulator", () => {
    const changed = entries.map((e, i) => (i === 4 ? { ...e, payload: Uint8Array.from(e.payload, (b, j) => (j === 40 ? b ^ 1 : b)) } : e));
    expect(() => replay(input({ entries: changed }))).toThrow(/do not fold to the chain's inbox accumulator/);
  });

  it("judges a batch with a forged withdrawals root as wrong, even with an honest state root", () => {
    const rec = fx.batches[10]!;
    const forged = { ...rec, withdrawalsRoot: "00".repeat(32), status: "submitted" };
    const t = replay(input({ records: fx.batches.map((b) => (b.batchIndex === 10 ? forged : b)), submissions: [] })).result;
    const row = t.rows.find((x) => x.batchIndex === 10)!;
    expect(row.mismatches).toEqual(["withdrawalsRoot"]);
    expect(row.challenge?.wins).toBe(true);
  });
});

describe("a pruned batch record", () => {
  // The chain may delete finalized batch records; none is pruned yet (27 Nov), so prune 0 to 3 here.
  const s = replay(input({ records: fx.batches.filter((b) => b.batchIndex > 3) }));

  it("is judged from its own submission and checked against its surviving anchor", () => {
    const pruned = s.result.rows.filter((x) => x.where === "pruned");
    expect(pruned.map((x) => x.batchIndex)).toEqual([0, 1, 2, 3]);
    expect(pruned.every((x) => x.verdict === "reproduced" && x.anchor?.matches)).toBe(true);
    expect(s.result.counts).toMatchObject({ kept: 22, keptReproduced: 22, pruned: 4, prunedReproduced: 4 });
    // Batch 2's withdrawal is still matched to its L1 payment.
    expect(s.result.solvency).toMatchObject({ surplus: "0", paidWithdrawals: 5 });
  });

  it("is not reproduced when its anchor names another root", () => {
    const anchors = fx.anchors.map((a) => (a.layerHeight === 1 ? { ...a, stateRoot: "11".repeat(32) } : a));
    const t = replay(input({ records: fx.batches.filter((b) => b.batchIndex > 3), anchors })).result;
    expect(t.rows.find((x) => x.batchIndex === 1)?.anchor?.matches).toBe(false);
    expect(t.counts.prunedReproduced).toBe(3);
  });
});

describe("looking up an account", () => {
  const s = replay(input());
  const creatorL2 = "6b6c0bea5e3bfbf32e6312de5c4648dd853570ac134ece008bd6d919b88dc70e";

  it("opens a balance and nonce with a witness checked against the anchored root", () => {
    const l = lookup(s, creatorL2);
    const listed = s.result.accounts.find((a) => a.id === creatorL2)!;
    expect(l).toMatchObject({ balance: listed.balance, nonce: listed.nonce, batchIndex: 25, root: s.result.lookupRoot!.root });
  });

  it("opens an absent account as zero", () => {
    expect(lookup(s, "ab".repeat(32))).toMatchObject({ balance: "0", nonce: "0" });
  });

  it("throws when the ledger's witness does not hash to the root it is checked against", () => {
    const at = s.result.lookupRoot!;
    const honest = s.states.get(at.root)!;
    const bent = honest.clone();
    bent.set(hexToBytes(creatorL2), 1n, 0n);
    s.states.set(at.root, bent);
    try {
      expect(() => lookup(s, creatorL2)).toThrow(/witness does not match the state root/);
    } finally {
      s.states.set(at.root, honest);
    }
  });

  it("refuses something that is not an account id", () => {
    expect(() => lookup(s, "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s")).toThrow(/64 hex digits/);
  });
});

describe("the tamper demo", () => {
  const s = replay(input());
  const withTransfer = s.rows.find((x) => x.where === "kept" && x.transfers.length > 0)!;

  it("lists only transfers that moved money between two accounts", () => {
    // Entry 2 is the first L2 transfer (0.5 QOR, EVIDENCE 17); entry 4 is a self-transfer and changes no balance.
    expect(withTransfer.batchIndex).toBe(1);
    expect(withTransfer.transfers).toEqual([expect.objectContaining({ sequence: 2, amount: "500000" })]);
    expect(s.rows.find((x) => x.batchIndex === 3)?.transfers).toEqual([]);
  });

  it("diverges the root, and builds a proof the chain's rule upholds against the forgery but not against the real batch", () => {
    const f = forge(s, withTransfer.key, 2, 900_000n);
    expect(f.forgedRoot).not.toBe(f.honestRoot);
    expect(f.honestRoot).toBe(withTransfer.published.stateRoot);
    expect(f.wins).toBe(true);
    expect(f.winsAgainstReal).toBe(false);
    const cmd = challengeCommand(fx.rollupId, fx.chainId, f.batchIndex, f.proofHex);
    expect(cmd).toContain(`challenge-batch vigil-pay-1 1 `);
    expect(cmd).toContain("--generate-only");
    expect(cmd).not.toMatch(/broadcast/);
  });

  it("refuses the signed amount and amounts the sender never held", () => {
    expect(() => forge(s, withTransfer.key, 2, 500_000n)).toThrow(/signed amount/);
    expect(() => forge(s, withTransfer.key, 2, 10n ** 12n)).toThrow(/sender held/);
    expect(() => forge(s, withTransfer.key, 3, 1n)).toThrow(/not a transfer/);
  });

  it("does not change the session it forged from", () => {
    const before = JSON.stringify(s.result);
    forge(s, withTransfer.key, 2, 1n);
    expect(JSON.stringify(s.result)).toBe(before);
    expect(lookup(s, withTransfer.transfers[0]!.to).root).toBe(s.result.lookupRoot!.root);
  });
});

describe("the committed archive", () => {
  const fetchAfter = async (from: number, accFrom: string): Promise<Entry[]> => {
    expect(from).toBe(27);
    const acc = bytesToHex(qledgerAccumulate({ ...env, from: 26, accFrom: archive[25]!.acc, entries: [{ height: BigInt(archive[26]!.height), poster: archive[26]!.poster, payload: hexToBytes(archive[26]!.payloadHex) }] })).toLowerCase();
    expect(accFrom).toBe(acc);
    return after;
  };

  it("holds entries 1 to 27, each chaining to the next", () => {
    expect(archive).toHaveLength(27);
  });

  it("is used only when the chain's accumulator at the head vouches for it", async () => {
    const got = await entriesWithArchive(env, archive, fx.inbox.headSequence, fx.inbox.headAcc, fetchAfter);
    expect(got.archived).toBe(27);
    expect(got.entries).toHaveLength(28);
    expect(replay(input({ entries: got.entries })).result.counts.keptReproduced).toBe(26);
  });

  it("is refused when it disagrees with the chain", async () => {
    await expect(entriesWithArchive(env, archive, fx.inbox.headSequence, "00".repeat(32), fetchAfter)).rejects.toThrow(/do not match the chain's inbox accumulator/);
  });

  it("stops at a row edited without its accumulator", () => {
    const lines = archiveText.trim().split("\n");
    const row = JSON.parse(lines[9]!) as { payloadHex: string };
    row.payloadHex = row.payloadHex.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    lines[9] = JSON.stringify(row);
    expect(parseArchive(lines.join("\n"), env)).toHaveLength(9);
  });
});

describe("no way to send anything", () => {
  it("the replay modules and the worker never sign or broadcast", () => {
    const src = ["core.ts", "chain-data.ts", "worker.ts", "client.ts", "read.ts"].map((f) => readFileSync(join(here, "..", "src", "replay", f), "utf8")).join("\n");
    const view = readFileSync(join(here, "..", "src", "views", "Replay.tsx"), "utf8");
    for (const s of [src, view]) {
      expect(s).not.toMatch(/broadcast_tx|signAndBroadcast|RdkTxClient|SigningStargate|challengeBatchMsg|mnemonic|secretKey/);
    }
  });

  it("batch keys use every published field", () => {
    const b = fx.batches[6]!;
    expect(batchKey(b)).not.toBe(batchKey({ ...b, withdrawalsRoot: "ab".repeat(32) }));
  });
});
