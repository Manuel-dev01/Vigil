/**
 * The fast path, offline:
 * - decoding a batch from the tx that submitted it, using the two real
 *   transactions of fraud drill 1 on vigil-pay-1 (19 Nov 2026);
 * - judging and challenging that batch against the recorded rollup;
 * - the challenger's signing, gas and sequence handling against a fake transport;
 * - the websocket follower against a fake socket.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { createRdkRegistry } from "@qorechain/rdk";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import {
  Challenger,
  InboxArchive,
  RollupTracker,
  TxFollower,
  batchesFromTx,
  postsFromEvents,
  websocketUrl,
  type ArchivedEntry,
  type ChallengeTransport,
  type LiveBatch,
  type TxEvent,
} from "../src/index.ts";

const VECTORS = resolve(import.meta.dirname, "../../../test/vectors");
const drill = JSON.parse(readFileSync(resolve(VECTORS, "drill-1-batch-txs.json"), "utf8")) as {
  rollupId: string;
  txs: Record<"bad" | "honest", { hash: string; height: number; txBase64: string; events: Record<string, string[]> }>;
  upheldChallenge: { hash: string; proofBase64: string };
};
const replay = JSON.parse(readFileSync(resolve(VECTORS, "replay-vigil-pay-1.json"), "utf8")) as {
  chainId: string;
  rollupId: string;
  inboxAcc: Record<string, string>;
  entries: { sequence: number; height: number; poster: string; payloadHex: string }[];
  batches: Omit<LiveBatch, "submittedAt">[];
};
const env = { chainId: replay.chainId, rollupId: replay.rollupId };
const HONEST_ROOT = "778c8a0fa6d0918655ec681fc59eedaa26a5fab16a889a1b0b2477fc58dbd561";

/** A tracker that has seen vigil-pay-1's honest batches 0..5, as the watchtower had when drill 1's batch 6 arrived. */
async function trackerBeforeDrill(): Promise<RollupTracker> {
  const upTo5 = replay.batches.filter((b) => b.batchIndex <= 5);
  const t = new RollupTracker(
    env,
    {
      listBatches: async () => upTo5.map((b) => ({ ...b, submittedAt: 0 })),
      fetchEntries: async (from, to): Promise<ArchivedEntry[]> =>
        replay.entries.filter((e) => e.sequence > from && e.sequence <= to).map((e) => ({ ...e, acc: replay.inboxAcc[String(e.sequence)]! })),
    },
    new InboxArchive(env),
  );
  const tracked = await t.sync();
  expect(tracked.every((x) => x.judgement.kind === "valid")).toBe(true);
  return t;
}

describe("batches decoded from their submitting tx (fraud drill 1)", () => {
  it("reads the evil submitter's batch 6 exactly as published", () => {
    const [b, ...rest] = batchesFromTx(drill.txs.bad.txBase64, drill.txs.bad.events, "vigil-pay-1");
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({ batchIndex: 6, inboxStart: 6, inboxEnd: 7, prevStateRoot: HONEST_ROOT, withdrawalsRoot: "", status: "submitted" });
    // The drill flipped the first hex digit of the honest root.
    expect(b!.stateRoot).toBe("0" + HONEST_ROOT.slice(1));
    // Same inbox range as Keel's honest batch 6, so the same data hash.
    expect(b!.dataHash).toBe(replay.batches.find((x) => x.batchIndex === 6)!.dataHash.toLowerCase());
  });

  it("reads Keel's honest batch 6 as the chain recorded it", () => {
    const [b] = batchesFromTx(drill.txs.honest.txBase64, drill.txs.honest.events, "vigil-pay-1");
    const onChain = replay.batches.find((x) => x.batchIndex === 6)!;
    expect(b).toMatchObject({ batchIndex: 6, inboxStart: onChain.inboxStart, inboxEnd: onChain.inboxEnd, stateRoot: onChain.stateRoot.toLowerCase(), prevStateRoot: onChain.prevStateRoot.toLowerCase(), dataHash: onChain.dataHash.toLowerCase() });
  });

  it("ignores batches of other rollups", () => {
    expect(batchesFromTx(drill.txs.bad.txBase64, drill.txs.bad.events, "some-other-rollup")).toEqual([]);
  });

  it("reads post sequences from rdk_data_posted events", () => {
    const ev = { "rdk_data_posted.rollup_id": ["vigil-pay-1", "other", "vigil-pay-1"], "rdk_data_posted.sequence": ["8", "3", "9"] };
    expect(postsFromEvents(ev, "vigil-pay-1")).toEqual([8, 9]);
  });

  it("judges the drill batch invalid the moment it arrives, and the proof wins", async () => {
    const t = await trackerBeforeDrill();
    const [bad] = batchesFromTx(drill.txs.bad.txBase64, drill.txs.bad.events, "vigil-pay-1");
    const j = await t.judgeNow(bad!);
    expect(j.kind).toBe("invalid");
    if (j.kind === "invalid") {
      expect(j.mismatches).toEqual(["stateRoot"]);
      expect(j.honestStateRoot).toBe(HONEST_ROOT);
    }
    const c = t.challenge(bad!);
    expect(c.wins).toBe(true);
    // Byte for byte the proof the chain upheld in drill 1 (tx 1BF5B717…, 149 bytes).
    expect(Buffer.from(c.proof).toString("base64")).toBe(drill.upheldChallenge.proofBase64);
  });

  it("judges Keel's honest batch 6 valid and never wins against it", async () => {
    const t = await trackerBeforeDrill();
    const [honest] = batchesFromTx(drill.txs.honest.txBase64, drill.txs.honest.events, "vigil-pay-1");
    expect((await t.judgeNow(honest!)).kind).toBe("valid");
    expect(t.challenge(honest!).wins).toBe(false);
  });
});

// The BIP-39 test mnemonic: never funded, never used on chain.
const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function fakeTransport(opts: { failFirstWith?: number } = {}) {
  const sent: Uint8Array[] = [];
  let sequence = 7n;
  let fail = opts.failFirstWith;
  const t: ChallengeTransport & { sent: Uint8Array[]; accountCalls: number } = {
    sent,
    accountCalls: 0,
    async account() {
      t.accountCalls++;
      return { accountNumber: 42n, sequence };
    },
    async broadcastSync(tx) {
      if (fail !== undefined) {
        const code = fail;
        fail = undefined;
        sequence = 9n; // the chain moved on
        throw Object.assign(new Error(`CheckTx code ${code}`), { code });
      }
      sent.push(tx);
      return `HASH${sent.length}`;
    },
    async result() {
      return { code: 0, height: 1, rawLog: "", gasUsed: 1n };
    },
  };
  return t;
}

describe("Challenger", () => {
  it("signs locally with the cached account, the configured gas price and proof-sized gas", async () => {
    const t = await trackerBeforeDrill();
    const [bad] = batchesFromTx(drill.txs.bad.txBase64, drill.txs.bad.events, "vigil-pay-1");
    await t.judgeNow(bad!);
    const challenge = t.challenge(bad!);
    const account = await deriveUnifiedAccount(TEST_MNEMONIC, 0);
    const transport = fakeTransport();
    const ch = new Challenger(account, env.chainId, transport, { gasPrice: 0.3, signBytesVersion: "v2" });
    await ch.ready();
    const a = await ch.send("vigil-pay-1", challenge, 1);
    const b = await ch.send("vigil-pay-1", challenge, 1);
    expect([a.hash, b.hash]).toEqual(["HASH1", "HASH2"]);
    expect(transport.accountCalls).toBe(1); // looked up once, not per challenge
    expect(a.gas).toBe(Challenger.gasFor(challenge.proof.length, 1));
    expect(a.gas).toBeLessThan(2_000_000); // drill 1 paid for a 2M limit and used 178k
    expect(a.gas).toBeGreaterThan(343_412); // what the upheld drill-1 challenge used
    expect(a.feeUqor).toBe(Math.ceil(a.gas * 0.3));

    const tx = decodeTxRaw(transport.sent[0]!);
    expect(tx.authInfo.fee?.gasLimit).toBe(BigInt(a.gas));
    expect(tx.authInfo.fee?.amount[0]).toEqual({ denom: "uqor", amount: String(a.feeUqor) });
    expect(tx.authInfo.signerInfos[0]!.sequence).toBe(7n);
    expect(decodeTxRaw(transport.sent[1]!).authInfo.signerInfos[0]!.sequence).toBe(8n);
    const msg = createRdkRegistry().decode(tx.body.messages[0]!) as { challenger: string; batchIndex: bigint; proof: Uint8Array };
    expect(tx.body.messages[0]!.typeUrl).toBe("/qorechain.rdk.v1.MsgChallengeBatch");
    expect(msg.challenger).toBe(account.cosmos);
    expect(Number(msg.batchIndex)).toBe(6);
    expect(msg.proof).toEqual(challenge.proof);
  });

  it("re-reads the account and retries once on a sequence mismatch", async () => {
    const t = await trackerBeforeDrill();
    const [bad] = batchesFromTx(drill.txs.bad.txBase64, drill.txs.bad.events, "vigil-pay-1");
    await t.judgeNow(bad!);
    const transport = fakeTransport({ failFirstWith: 32 });
    const ch = new Challenger(await deriveUnifiedAccount(TEST_MNEMONIC, 0), env.chainId, transport, { signBytesVersion: "v2" });
    await ch.ready();
    expect((await ch.send("vigil-pay-1", t.challenge(bad!), 1)).hash).toBe("HASH1");
    expect(transport.accountCalls).toBe(2);
    expect(decodeTxRaw(transport.sent[0]!).authInfo.signerInfos[0]!.sequence).toBe(9n);
  });

  it("refuses a challenge the chain would not uphold", async () => {
    const t = await trackerBeforeDrill();
    const [honest] = batchesFromTx(drill.txs.honest.txBase64, drill.txs.honest.events, "vigil-pay-1");
    await t.judgeNow(honest!);
    const ch = new Challenger(await deriveUnifiedAccount(TEST_MNEMONIC, 0), env.chainId, fakeTransport(), { signBytesVersion: "v2" });
    await expect(ch.send("vigil-pay-1", t.challenge(honest!), 1)).rejects.toThrow(/checkQledgerFraud/);
  });

  it("scales gas with proof size and entries, doubles on retry, and caps it", () => {
    expect(Challenger.gasFor(149, 1, 2)).toBe(2 * Challenger.gasFor(149, 1));
    expect(Challenger.gasFor(138_965, 41)).toBeGreaterThan(Challenger.gasFor(149, 1));
    expect(Challenger.gasFor(10_000_000, 64, 4)).toBe(50_000_000);
  });
});

/** A WebSocket stand-in: records what is sent and lets the test push messages. */
class FakeSocket {
  static last?: FakeSocket;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.onclose?.();
  }
  push(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe("TxFollower", () => {
  it("subscribes to block headers and each query, and hands over matching txs", async () => {
    expect(websocketUrl("https://rpc-testnet.qore.host")).toBe("wss://rpc-testnet.qore.host/websocket");
    const got: TxEvent[] = [];
    const q = "tm.event='Tx' AND batch_submitted.rollup_id='vigil-pay-1'";
    const f = new TxFollower("wss://x/websocket", [q], (e) => got.push(e), { webSocket: FakeSocket as unknown as typeof WebSocket });
    f.start();
    await new Promise((r) => setTimeout(r, 0));
    const s = FakeSocket.last!;
    expect(f.connected).toBe(true);
    expect(s.sent.map((m) => JSON.parse(m).params.query)).toEqual(["tm.event='NewBlockHeader'", q]);
    s.push({ result: { query: "tm.event='NewBlockHeader'", data: { value: { header: { height: "10370239" } } } } });
    expect(f.lastHeight).toBe(10370239);
    s.push({ result: { query: q, data: { value: { TxResult: { height: "10370239", tx: drill.txs.bad.txBase64 } } }, events: drill.txs.bad.events } });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ query: 0, height: 10370239 });
    expect(batchesFromTx(got[0]!.txBase64, got[0]!.events, "vigil-pay-1")[0]!.batchIndex).toBe(6);
    f.stop();
    expect(f.connected).toBe(false);
  });
});
