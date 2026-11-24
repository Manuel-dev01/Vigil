/**
 * The inbox reader against recorded chain data (no network): vigil-pay-1 as
 * the chain served it on 24 Nov 2026 (every entry retained, two deposits), and
 * rdk-v328-e2e-mwd5v89d, whose entries 1 to 5 the chain had already pruned.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, decodeQledgerDeposit, fetchQledgerEntries, postedDataHash, type RestClient } from "@qorechain/rdk";
import {
  EMPTY_ACC,
  InboxArchive,
  InboxMismatchError,
  InboxReader,
  PrunedEntryError,
  accumulate,
  findPayload,
  openInboxReader,
  type ArchivedEntry,
} from "../src/inbox/index.ts";
import { anyOf, execMsg, fixtureSource, loadFixture, postMsg, rawTx, syntheticInbox } from "./fixture-source.ts";

const hex = (b: Uint8Array) => bytesToHex(b).toLowerCase();
const tmp = () => mkdtempSync(join(tmpdir(), "vigil-inbox-"));

interface ReplayVector {
  chainId: string;
  rollupId: string;
  inboxAcc: Record<string, string>;
  entries: { sequence: number; height: number; poster: string; payloadHex: string }[];
}
const replay = (id: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../test/vectors", `replay-${id}.json`), "utf8")) as ReplayVector;
/** Archive rows from an older replay vector (recorded before the chain pruned anything). */
const rowsOf = (v: ReplayVector): ArchivedEntry[] => v.entries.map((e) => ({ ...e, acc: v.inboxAcc[String(e.sequence)]! }));
const writeRows = (path: string, rows: ArchivedEntry[]) => writeFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""));

const pay = loadFixture("vigil-pay-1");
const payEnv = { chainId: pay.chainId, rollupId: pay.rollupId };
const v328 = loadFixture("rdk-v328-e2e-mwd5v89d");
const v328Env = { chainId: v328.chainId, rollupId: v328.rollupId };

describe("inbox reader: by sequence", () => {
  it("reads every vigil-pay-1 entry from recorded chain data, each checked against the chain's accumulator", async () => {
    const src = fixtureSource(pay);
    const reader = new InboxReader(payEnv, src);
    const head = pay.inbox.headSequence;
    const got = await reader.read(0, head);
    expect(got.map((e) => e.sequence)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
    for (const e of got) expect(e.acc).toBe(pay.postedData[String(e.sequence)]!.inboxAcc);
    expect(got.at(-1)!.acc).toBe(pay.inbox.headAcc);
    // The same bytes the RDK's reader returned when vigil-pay-1 had 7 entries.
    const old = replay("vigil-pay-1");
    for (const e of old.entries) expect(got[e.sequence - 1]).toMatchObject({ height: e.height, poster: e.poster, payloadHex: e.payloadHex });
    // One commitment per entry, one block per height (21 and 22 share one), one event read per deposit.
    expect(src.calls).toMatchObject({ postedData: head, block: Object.keys(pay.blocks).length, deposits: 2 });
    // Read again, in batch-sized pieces: nothing more is fetched, the accumulator is carried in memory.
    const before = { ...src.calls };
    for (const b of pay.batches) await reader.read(b.inboxStart, b.inboxEnd);
    expect(src.calls).toEqual(before);
  });

  it("rebuilds deposit entries from their rdk_rollup_deposit events", async () => {
    const reader = new InboxReader(payEnv, fixtureSource(pay));
    const got = await reader.read(0, 10);
    for (const s of [1, 10]) {
      const e = got[s - 1]!;
      expect(e.poster).toMatch(/^deposit:qor1/);
      const ev = Object.values(pay.deposits).flat().find((d) => d.sequence === s)!;
      const dep = decodeQledgerDeposit(Buffer.from(e.payloadHex, "hex"))!;
      expect(hex(dep.account)).toBe(ev.account);
      expect(dep.amount).toBe(BigInt(ev.amount));
    }
  });

  it("refuses a deposit whose event does not match the commitment", async () => {
    const forged = structuredClone(pay);
    for (const evs of Object.values(forged.deposits)) for (const d of evs) d.amount = "999999999";
    await expect(new InboxReader(payEnv, fixtureSource(forged)).read(0, 1)).rejects.toThrow(/no rdk_rollup_deposit event .* matches/);
  });

  it("finds a post sent inside another message, at any depth, among other transactions", async () => {
    const env = { chainId: "qorechain-diana", rollupId: "nested-1" };
    const post = (p: Uint8Array) => anyOf("/qorechain.rdk.v1.MsgPostRollupData", postMsg("qor1poster", env.rollupId, p));
    const wrapper = (inner: Uint8Array) => anyOf("/cosmos.authz.v1beta1.MsgExec", execMsg("qor1grantee", [inner]));
    const decoy = (p: Uint8Array) => rawTx([post(p.map((b) => b ^ 1))], "same size, different bytes");
    const src = syntheticInbox(env, 3, {
      wrap: (p, s) =>
        s === 1
          ? [decoy(p), rawTx([wrapper(post(p))])] // one wrapper
          : s === 2
            ? [rawTx([wrapper(wrapper(post(p)))]), decoy(p)] // a wrapper inside a wrapper
            : [rawTx([anyOf("/cosmos.bank.v1beta1.MsgSend", new Uint8Array([10, 3, 97, 98, 99])), post(p)])], // second message of a transaction
    });
    const got = await new InboxReader(env, src).read(0, 3);
    for (const e of got) expect(e.payloadHex).toBe(hex(src.payloads[e.sequence]!));
  });

  it("detects a commitment whose accumulator does not follow from the entries", async () => {
    const wrongAcc = fixtureSource(pay, { edit: (pd) => (pd.sequence === 5 ? { ...pd, inboxAcc: "00".repeat(32) } : pd) });
    await expect(new InboxReader(payEnv, wrongAcc).read(0, 6)).rejects.toThrow(InboxMismatchError);
    // A height that does not match the accumulator (the payload in that block still hashes right).
    const moved = structuredClone(pay);
    const h = moved.postedData["3"]!.height;
    moved.blocks[String(h + 1)] = moved.blocks[String(h)]!;
    const r = new InboxReader(payEnv, fixtureSource(moved, { edit: (pd) => (pd.sequence === 3 ? { ...pd, height: h + 1 } : pd) }));
    await expect(r.read(0, 2)).resolves.toHaveLength(2);
    await expect(r.read(2, 3)).rejects.toThrow(/does not match the chain's inbox accumulator/);
  });

  it("refuses a post whose block holds no payload with the committed hash", async () => {
    const src = fixtureSource(pay, { edit: (pd) => (pd.sequence === 2 ? { ...pd, dataHash: "ab".repeat(32) } : pd) });
    await expect(new InboxReader(payEnv, src).read(0, 2)).rejects.toThrow(/no transaction at height .* carries a payload/);
  });

  it("does not depend on how many posts the rollup has had (past 5,000)", async () => {
    const env = { chainId: "qorechain-diana", rollupId: "busy-1" };
    const n = 6_000;
    const src = syntheticInbox(env, n);
    const reader = new InboxReader(env, src);
    const got = await reader.read(5_990, n);
    expect(got.map((e) => e.sequence)).toEqual(Array.from({ length: 10 }, (_, i) => 5_991 + i));
    expect(got.at(-1)!.acc).toBe(src.accs[n]);
    // 1 commitment for the start accumulator, then 1 commitment and 1 block per entry.
    expect(src.calls).toMatchObject({ postedData: 11, block: 10 });

    // The RDK's reader searches every post of the rollup from the first, at most 50 pages of 100:
    // with 6,000 posts it never reaches the newest.
    const txs = Array.from({ length: n }, (_, i) => {
      const s = i + 1;
      return {
        height: String(1000 + s),
        txhash: `T${s}`,
        tx: { body: { messages: [{ "@type": "/qorechain.rdk.v1.MsgPostRollupData", poster: "qor1poster", rollup_id: env.rollupId, data: Buffer.from(src.payloads[s]!).toString("base64") }] } },
        events: [{ type: "rdk_data_posted", attributes: [{ key: "rollup_id", value: env.rollupId }, { key: "sequence", value: String(s) }, { key: "poster", value: "qor1poster" }, { key: "data_hash", value: hex(postedDataHash(src.payloads[s]!)) }] }],
      };
    });
    const rest = {
      searchTxs: async (q: string) => (q.startsWith("rdk_data_posted") ? txs.slice(0, 50 * 100) : []),
      getPostedData: async (_r: string, s: number) => ({ inboxAcc: src.accs[Number(s)]! }),
      getInbox: async () => ({ headSequence: n, headAcc: src.accs[n]! }),
    } as unknown as RestClient;
    await expect(fetchQledgerEntries(rest, { ...env, from: 5_990, to: n, accFrom: src.accs[5_990]! })).rejects.toThrow(/not found in the node's transaction index/);
  });
});

describe("inbox reader: pruned entries and the archive", () => {
  it("reads entries the chain has pruned from an archive, confirmed by the chain's commitments", async () => {
    // rdk-v328-e2e-mwd5v89d: the chain no longer holds entries 1-5. The archive is the replay recorded on 16 Nov (entries 1-9).
    const archive = new InboxArchive(v328Env);
    archive.extend(rowsOf(replay("rdk-v328-e2e-mwd5v89d")));
    expect(archive.head).toBe(9);
    const src = fixtureSource(v328);
    const reader = new InboxReader(v328Env, src, { archive });
    const got = await reader.read(0, v328.inbox.headSequence);
    expect(got).toHaveLength(18);
    expect(got.at(-1)!.acc).toBe(v328.inbox.headAcc);
    for (let s = 6; s <= 18; s++) expect(got[s - 1]!.acc).toBe(v328.postedData[String(s)]!.inboxAcc);
    // One commitment (entry 9's) confirmed all nine archived rows; entries 1-9 cost no block reads.
    expect(archive.confirmed).toBe(18);
    expect(src.calls.postedData).toBe(1 + 9);
    const later = Array.from({ length: 9 }, (_, i) => v328.postedData[String(10 + i)]!);
    expect(src.calls.block).toBe(new Set(later.filter((p) => !p.poster.startsWith("deposit:")).map((p) => p.height)).size);
    expect(src.calls.deposits).toBe(later.filter((p) => p.poster.startsWith("deposit:")).length);
  });

  it("fails clearly when a pruned entry is in no archive", async () => {
    await expect(new InboxReader(v328Env, fixtureSource(v328)).read(0, 4)).rejects.toThrow(PrunedEntryError);
    // Entries after a retained commitment read fine without an archive; entry 6 needs the accumulator after 5, which is gone.
    await expect(new InboxReader(v328Env, fixtureSource(v328)).read(6, 18)).resolves.toHaveLength(12);
    await expect(new InboxReader(v328Env, fixtureSource(v328)).read(5, 18)).rejects.toThrow(PrunedEntryError);
  });

  it("confirms archived rows by a batch's inbox range hash when nothing later is at hand", async () => {
    const archive = new InboxArchive(v328Env);
    archive.extend(rowsOf(replay("rdk-v328-e2e-mwd5v89d")).slice(0, 4));
    // Entry 4 is pruned and is the archive's last row: only batch 0's range hash (entries 1-4) can confirm it.
    const src = fixtureSource(v328);
    const reader = new InboxReader(v328Env, src, { archive });
    const b0 = v328.batches[0]!;
    expect([b0.inboxStart, b0.inboxEnd]).toEqual([0, 4]);
    await expect(reader.read(0, 4, { rangeHash: "11".repeat(32) })).rejects.toThrow(/inbox range commitment/);
    archive.extend(rowsOf(replay("rdk-v328-e2e-mwd5v89d")).slice(0, 4));
    const got = await reader.read(0, 4, { rangeHash: b0.dataHash });
    expect(got).toHaveLength(4);
    expect(archive.confirmed).toBe(4);
  });

  it("refuses an archive whose rows were edited and re-chained, and drops them", async () => {
    const rows = rowsOf(replay("rdk-v328-e2e-mwd5v89d"));
    // Change entry 3's payload and recompute every accumulator after it, so the file is self-consistent.
    const forged: ArchivedEntry[] = [];
    let acc = EMPTY_ACC;
    for (const r of rows) {
      const payloadHex = r.sequence === 3 ? r.payloadHex.replace(/..$/, "00") : r.payloadHex;
      acc = accumulate(v328Env, acc, { ...r, payloadHex });
      forged.push({ ...r, payloadHex, acc });
    }
    const dir = tmp();
    const path = join(dir, "inbox.jsonl");
    writeRows(path, forged);
    const events: string[] = [];
    const reader = openInboxReader(v328Env, { archivePath: path, seeds: [], source: fixtureSource(v328), log: (e) => events.push(e) });
    expect(reader.archive.head).toBe(9);
    await expect(reader.read(0, 18)).rejects.toThrow(PrunedEntryError);
    expect(events).toContain("inbox_archive_rejected");
    expect(reader.archive.head).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(existsSync(`${path}.rejected`)).toBe(true);
  });

  it("stops loading an archive at a row edited without re-chaining, and keeps the rows before it", async () => {
    const rows = rowsOf(replay("rdk-v328-e2e-mwd5v89d"));
    const dir = tmp();
    const path = join(dir, "inbox.jsonl");
    writeRows(path, rows.map((r) => (r.sequence === 3 ? { ...r, payloadHex: r.payloadHex.replace(/..$/, "00") } : r)));
    const archive = new InboxArchive(v328Env, path);
    expect(archive.head).toBe(2);
    expect(archive.loadProblem).toMatch(/row 3 does not chain/);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    await expect(new InboxReader(v328Env, fixtureSource(v328), { archive }).read(0, 9)).rejects.toThrow(PrunedEntryError);
  });

  it("replaces an edited row the chain still holds with the chain's own bytes", async () => {
    const good = await new InboxReader(payEnv, fixtureSource(pay)).read(0, pay.inbox.headSequence);
    const forged: ArchivedEntry[] = [];
    let acc = EMPTY_ACC;
    for (const r of good) {
      const payloadHex = r.sequence === 7 ? r.payloadHex.replace(/^../, "ff") : r.payloadHex;
      acc = accumulate(payEnv, acc, { ...r, payloadHex });
      forged.push({ ...r, payloadHex, acc });
    }
    const dir = tmp();
    const path = join(dir, "inbox.jsonl");
    writeRows(path, forged);
    const reader = openInboxReader(payEnv, { archivePath: path, seeds: [], source: fixtureSource(pay) });
    const got = await reader.read(0, pay.inbox.headSequence);
    expect(got).toEqual(good);
    expect(readFileSync(path, "utf8")).toBe(good.map((r) => JSON.stringify(r) + "\n").join(""));
  });

  it("tolerates a torn last line", async () => {
    const good = await new InboxReader(payEnv, fixtureSource(pay)).read(0, 5);
    const dir = tmp();
    const path = join(dir, "inbox.jsonl");
    writeFileSync(path, good.map((r) => JSON.stringify(r) + "\n").join("") + JSON.stringify(good[0]).slice(0, 40));
    const archive = new InboxArchive(payEnv, path);
    expect(archive.head).toBe(5);
    expect(archive.loadProblem).toMatch(/line 6 is not JSON/);
  });

  it("restarts from its own archive without the chain's pruned data or blocks", async () => {
    const dir = tmp();
    const path = join(dir, "inbox.jsonl");
    const head = pay.inbox.headSequence;
    const first = openInboxReader(payEnv, { archivePath: path, seeds: [], source: fixtureSource(pay) });
    await first.read(0, 5);
    await first.read(5, head);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(head);

    // Later: the chain has pruned everything but the newest entry, and serves no old blocks.
    const later = fixtureSource(pay, { prune: (s) => s < head, blocksGone: true });
    const restarted = openInboxReader(payEnv, { archivePath: path, seeds: [], source: later });
    const got = await restarted.read(0, head);
    expect(got.map((e) => e.acc)).toEqual(Array.from({ length: head }, (_, i) => pay.postedData[String(i + 1)]!.inboxAcc));
    expect(later.calls).toMatchObject({ postedData: 1, block: 0, deposits: 0 });
  });

  it("seeds a fresh service archive from the committed archive, writing rows only once confirmed", async () => {
    const dir = tmp();
    const seed = join(dir, "seed.jsonl");
    const own = join(dir, "own", "inbox.jsonl");
    writeRows(seed, await new InboxReader(payEnv, fixtureSource(pay)).read(0, 20));
    const reader = openInboxReader(payEnv, { archivePath: own, seeds: [seed], source: fixtureSource(pay) });
    expect(reader.archive.head).toBe(20);
    expect(existsSync(own)).toBe(false);
    await reader.read(20, pay.inbox.headSequence);
    expect(reader.archive.confirmed).toBe(pay.inbox.headSequence);
    expect(readFileSync(own, "utf8").trim().split("\n")).toHaveLength(pay.inbox.headSequence);
  });
});

describe("inbox reader: tolerant reads (exit relayer)", () => {
  it("skips what is gone without assuming retention is monotonic", async () => {
    const env = { chainId: "qorechain-diana", rollupId: "gappy-1" };
    // Entries 1-150 pruned except the checkpoints 64 and 128, which the chain keeps longer.
    const src = syntheticInbox(env, 200, { prune: (s) => s <= 150 && s % 64 !== 0 });
    const r = await new InboxReader(env, src).readAvailable(0, 200);
    expect(r.entries.map((e) => e.sequence)).toEqual([64, 128, ...Array.from({ length: 50 }, (_, i) => 151 + i)]);
    expect(r.missing).toHaveLength(148);
    for (const e of r.entries) expect(e.payloadHex).toBe(hex(src.payloads[e.sequence]!));
    for (const e of r.entries) expect(e.acc).toBe(src.accs[e.sequence]);

    // With an archive of entries 1-100, checkpoint 64 confirms rows 1-64. Rows 65-100 stay unused:
    // with 101-127 gone, no commitment the chain holds can confirm them.
    const archive = new InboxArchive(env);
    archive.extend(Array.from({ length: 100 }, (_, i) => ({ sequence: i + 1, height: 1001 + i, poster: "qor1poster", payloadHex: hex(src.payloads[i + 1]!), acc: src.accs[i + 1]! })));
    const withArchive = await new InboxReader(env, src, { archive }).readAvailable(0, 200);
    expect(withArchive.entries.map((e) => e.sequence)).toEqual([...Array.from({ length: 64 }, (_, i) => i + 1), 128, ...Array.from({ length: 50 }, (_, i) => 151 + i)]);
    expect(withArchive.missing).toEqual(Array.from({ length: 86 }, (_, i) => 65 + i).filter((s) => s !== 128));
    expect(archive.confirmed).toBe(64);
  });

  it("does not skip the newest entries when the node it asks has not caught up yet", async () => {
    const env = { chainId: "qorechain-diana", rollupId: "laggy-1" };
    let nodeHead = 8;
    const src = syntheticInbox(env, 10, { prune: (s) => s > nodeHead, reportedHead: () => nodeHead });
    const reader = new InboxReader(env, src);
    const first = await reader.readAvailable(0, 10);
    expect(first.entries.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(first.missing).toEqual([]);
    expect(first.through).toBe(8);
    nodeHead = 10;
    const next = await reader.readAvailable(first.through, 10);
    expect(next.entries.map((e) => e.sequence)).toEqual([9, 10]);
    expect(next.through).toBe(10);
    // Gone for good (the node's inbox is past them): reported missing, and the read is final.
    const gone = await new InboxReader(env, syntheticInbox(env, 10, { prune: (s) => s > 8 })).readAvailable(0, 10);
    expect(gone).toMatchObject({ missing: [9, 10], through: 10 });
  });
});

describe("findPayload", () => {
  it("ignores bytes that are not protobuf and fields of the right size with the wrong hash", () => {
    const p = new TextEncoder().encode("the payload");
    const want = hex(postedDataHash(p));
    expect(findPayload([new Uint8Array([0xff, 0xff, 0xff]), rawTx([anyOf("/x", postMsg("a", "b", p.map((b) => b ^ 2)))])], want, p.length)).toBeUndefined();
    expect(findPayload([rawTx([anyOf("/x", postMsg("a", "b", p))])], want, p.length)).toEqual(p);
  });
});
