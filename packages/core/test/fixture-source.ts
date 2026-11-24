/**
 * Recorded chain data for the inbox reader (test/vectors/inbox-<rollup>.json,
 * written by scripts/record-inbox-fixture.ts), served as an `InboxSource` that
 * counts what it is asked, plus a synthetic source for made-up inboxes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { postedDataHash, type BatchView } from "@qorechain/rdk";
import { EMPTY_ACC, accumulate, type DepositEvent, type InboxEnv, type InboxHead, type InboxSource, type PostedData } from "../src/inbox/index.ts";

export interface InboxFixture {
  chainId: string;
  rollupId: string;
  recordedAt: string;
  inbox: InboxHead;
  postedData: Record<string, PostedData | null>;
  blocks: Record<string, string[]>;
  deposits: Record<string, (Omit<DepositEvent, "amount"> & { amount: string })[]>;
  batches: BatchView[];
}

export function loadFixture(rollupId: string): InboxFixture {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../test/vectors", `inbox-${rollupId}.json`), "utf8")) as InboxFixture;
}

export interface Counted {
  calls: { postedData: number; block: number; deposits: number; inbox: number };
}

/** Serve a fixture; `prune` lists sequences to answer as pruned, `blocksGone` makes every block read fail. */
export function fixtureSource(fx: InboxFixture, opts: { prune?: (seq: number) => boolean; blocksGone?: boolean; edit?: (pd: PostedData) => PostedData } = {}): InboxSource & Counted {
  const calls = { postedData: 0, block: 0, deposits: 0, inbox: 0 };
  return {
    calls,
    async postedData(s) {
      calls.postedData++;
      const pd = fx.postedData[String(s)];
      if (!pd || opts.prune?.(s)) return undefined;
      return opts.edit ? opts.edit({ ...pd }) : { ...pd };
    },
    async blockTxs(h) {
      calls.block++;
      if (opts.blocksGone) throw new Error(`block ${h} is not available`);
      const txs = fx.blocks[String(h)];
      if (!txs) throw new Error(`no block ${h} in the fixture`);
      return txs.map((t) => Uint8Array.from(Buffer.from(t, "base64")));
    },
    async deposits(h) {
      calls.deposits++;
      return (fx.deposits[String(h)] ?? []).map((d) => ({ ...d, amount: BigInt(d.amount) }));
    },
    async inbox() {
      calls.inbox++;
      return { ...fx.inbox };
    },
  };
}

/** A made-up inbox: `n` posts, entry `s` at height 1000 + s, each in its own block, wrapped by `wrap`. */
export function syntheticInbox(
  env: InboxEnv,
  n: number,
  opts: { payload?: (s: number) => Uint8Array; wrap?: (payload: Uint8Array, s: number) => Uint8Array[]; prune?: (s: number) => boolean; reportedHead?: () => number } = {},
): InboxSource & Counted & { accs: string[]; payloads: Uint8Array[] } {
  const payloadOf = opts.payload ?? ((s: number) => new TextEncoder().encode(`synthetic post ${s} of ${env.rollupId}`));
  const wrap = opts.wrap ?? ((p: Uint8Array) => [rawTx([anyOf("/qorechain.rdk.v1.MsgPostRollupData", postMsg("qor1poster", env.rollupId, p))])]);
  const accs = [EMPTY_ACC];
  const payloads: Uint8Array[] = [new Uint8Array()];
  const hashes: string[] = [""];
  for (let s = 1; s <= n; s++) {
    const p = payloadOf(s);
    payloads.push(p);
    const dataHash = Buffer.from(postedDataHash(p)).toString("hex");
    hashes.push(dataHash);
    accs.push(accumulate(env, accs[s - 1]!, { sequence: s, height: 1000 + s, poster: "qor1poster", dataHash }));
  }
  const calls = { postedData: 0, block: 0, deposits: 0, inbox: 0 };
  return {
    calls,
    accs,
    payloads,
    async postedData(s) {
      calls.postedData++;
      if (s < 1 || s > n || opts.prune?.(s)) return undefined;
      return { sequence: s, height: 1000 + s, poster: "qor1poster", dataHash: hashes[s]!, size: payloads[s]!.length, inboxAcc: accs[s]! };
    },
    async blockTxs(h) {
      calls.block++;
      return wrap(payloads[h - 1000]!, h - 1000);
    },
    async deposits() {
      calls.deposits++;
      return [];
    },
    async inbox() {
      calls.inbox++;
      const head = opts.reportedHead?.() ?? n;
      return { headSequence: head, headAcc: accs[head]!, consumedSequence: head, consumedAcc: accs[head]! };
    },
  };
}

// ---------------------------------------------------------------- protobuf by hand

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}
const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const all = parts.flatMap((p) => [...p]);
  return Uint8Array.from(all);
};
/** A length-delimited field. */
export const field = (no: number, bytes: Uint8Array | string): Uint8Array => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return cat(varint(no * 8 + 2), varint(b.length), b);
};
/** A varint field. */
export const vfield = (no: number, n: number): Uint8Array => cat(varint(no * 8), varint(n));
/** google.protobuf.Any */
export const anyOf = (typeUrl: string, value: Uint8Array): Uint8Array => cat(field(1, typeUrl), field(2, value));
/** qorechain.rdk.v1.MsgPostRollupData { poster = 1; rollup_id = 2; data = 3 } */
export const postMsg = (poster: string, rollupId: string, data: Uint8Array): Uint8Array => cat(field(1, poster), field(2, rollupId), field(3, data));
/** A wrapper message that carries other messages as `repeated Any msgs = 2` (authz MsgExec's shape). */
export const execMsg = (grantee: string, msgs: Uint8Array[]): Uint8Array => cat(field(1, grantee), ...msgs.map((m) => field(2, m)));
/** TxRaw { body_bytes = 1 (TxBody { messages = 1, memo = 2 }); auth_info_bytes = 2; signatures = 3 } */
export const rawTx = (messages: Uint8Array[], memo = ""): Uint8Array =>
  cat(field(1, cat(...messages.map((m) => field(1, m)), memo ? field(2, memo) : [])), field(2, cat(vfield(1, 1), field(2, "fee"))), field(3, new Uint8Array(64).fill(7)));
