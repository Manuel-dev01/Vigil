/**
 * Where the inbox reader gets chain data: one posted-data commitment per
 * sequence, the raw transactions of one block, and the deposit events of one
 * block. `restInboxSource` serves them from a node's REST API (and, for
 * deposits, its RPC as a fallback); tests serve recorded data.
 */
import { TESTNET } from "../index.ts";

/** One posted-data commitment, as the chain keeps it (hex lower case, no 0x). */
export interface PostedData {
  sequence: number;
  /** The height of the block that included the post. */
  height: number;
  /** The poster address, or `deposit:<depositor>` for a deposit. */
  poster: string;
  /** SHA-256 of the payload. */
  dataHash: string;
  /** Payload length in bytes, when the node reports it. */
  size?: number;
  /** The inbox accumulator after this entry. */
  inboxAcc: string;
}

/** One `rdk_rollup_deposit` event. */
export interface DepositEvent {
  rollupId: string;
  sequence: number;
  depositor: string;
  /** The L2 account credited (32 bytes, hex). */
  account: string;
  amount: bigint;
}

export interface InboxHead {
  headSequence: number;
  headAcc: string;
  consumedSequence: number;
  consumedAcc: string;
}

export interface InboxSource {
  /** The commitment of entry `sequence`, or undefined if the chain no longer holds it (pruned) or never did. */
  postedData(sequence: number): Promise<PostedData | undefined>;
  /** The raw transactions (TxRaw bytes) of the block at `height`. */
  blockTxs(height: number): Promise<Uint8Array[]>;
  /** The rollup's deposit events in the block at `height`. */
  deposits(height: number): Promise<DepositEvent[]>;
  /** The inbox's head and consumed position with their accumulators. */
  inbox(): Promise<InboxHead>;
}

export interface RestInboxSourceOptions {
  /** REST base URL (default: testnet). */
  rest?: string;
  /** CometBFT RPC base URL, used for deposit events when the REST tx search finds none (default: testnet). */
  rpc?: string;
  fetch?: typeof globalThis.fetch;
}

/** What a source has asked the node for, by kind (for logs and tests). */
export type RequestCounts = Record<"postedData" | "block" | "depositSearch" | "blockResults" | "inbox", number>;

const hexOf = (v: unknown): string => String(v ?? "").toLowerCase().replace(/^0x/, "");

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Attr = { key?: unknown; value?: unknown };
type RawEvent = { type?: unknown; attributes?: Attr[] };

/** The rollup's `rdk_rollup_deposit` events in a list of raw events. */
export function depositEventsOf(events: RawEvent[], rollupId: string): DepositEvent[] {
  const out: DepositEvent[] = [];
  for (const ev of events) {
    if (ev.type !== "rdk_rollup_deposit") continue;
    const a: Record<string, string> = {};
    for (const x of ev.attributes ?? []) a[String(x.key ?? "")] = String(x.value ?? "");
    if (a["rollup_id"] !== rollupId) continue;
    const amount = (a["amount"] ?? "").replace(/uqor$/, "");
    if (!/^\d+$/.test(amount) || !/^\d+$/.test(a["sequence"] ?? "")) continue;
    out.push({ rollupId, sequence: Number(a["sequence"]), depositor: a["depositor"] ?? "", account: hexOf(a["account"]), amount: BigInt(amount) });
  }
  return out;
}

export function restInboxSource(rollupId: string, opts: RestInboxSourceOptions = {}): InboxSource & { readonly requests: RequestCounts } {
  const rest = (opts.rest ?? TESTNET.rest).replace(/\/+$/, "");
  const rpc = (opts.rpc ?? TESTNET.rpc).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const requests: RequestCounts = { postedData: 0, block: 0, depositSearch: 0, blockResults: 0, inbox: 0 };
  const rid = encodeURIComponent(rollupId);

  async function get(url: string, kind: keyof RequestCounts): Promise<Record<string, unknown>> {
    requests[kind]++;
    const res = await doFetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new HttpError(`GET ${url.replace(/^https?:\/\/[^/]+/, "")} -> HTTP ${res.status}${body ? `: ${body}` : ""}`, res.status);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  return {
    requests,

    async postedData(sequence) {
      let body: Record<string, unknown>;
      try {
        body = await get(`${rest}/qorechain/rdk/v1/posted_data/${rid}/${sequence}`, "postedData");
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return undefined;
        throw err;
      }
      const p = (body["posted_data"] ?? body["postedData"] ?? body) as Record<string, unknown>;
      const size = Number(p["size"]);
      const pd: PostedData = {
        sequence: Number(p["sequence"] ?? sequence),
        height: Number(p["height"]),
        poster: String(p["poster"] ?? ""),
        dataHash: hexOf(p["data_hash"] ?? p["dataHash"]),
        inboxAcc: hexOf(p["inbox_acc"] ?? p["inboxAcc"]),
        ...(Number.isInteger(size) && size >= 0 && { size }),
      };
      if (pd.sequence !== sequence || !Number.isInteger(pd.height) || pd.height <= 0 || pd.dataHash.length !== 64 || pd.inboxAcc.length !== 64) {
        throw new Error(`posted data ${rollupId}/${sequence}: the node's answer is malformed`);
      }
      return pd;
    },

    async blockTxs(height) {
      const body = await get(`${rest}/cosmos/base/tendermint/v1beta1/blocks/${height}`, "block");
      const block = (body["sdk_block"] ?? body["block"]) as { header?: { height?: unknown }; data?: { txs?: unknown[] } } | undefined;
      if (!block || Number(block.header?.height) !== height) throw new Error(`block ${height}: the node's answer is malformed`);
      return (block.data?.txs ?? []).map((t) => Uint8Array.from(Buffer.from(String(t), "base64")));
    },

    async deposits(height) {
      const out: DepositEvent[] = [];
      const q = encodeURIComponent(`tx.height=${height} AND rdk_rollup_deposit.rollup_id='${rollupId}'`);
      try {
        for (let page = 1; page <= 100; page++) {
          const body = await get(`${rest}/cosmos/tx/v1beta1/txs?query=${q}&page=${page}&limit=100`, "depositSearch");
          const txs = (body["tx_responses"] ?? []) as { events?: RawEvent[] }[];
          for (const tx of txs) out.push(...depositEventsOf(tx.events ?? [], rollupId));
          const total = Number(body["total"] ?? 0);
          if (txs.length < 100 || (total > 0 && page * 100 >= total)) break;
        }
      } catch {
        // No transaction index on this node: fall through to the block results.
      }
      if (out.length > 0) return out;
      const body = await get(`${rpc}/block_results?height=${height}`, "blockResults");
      const r = (body["result"] ?? body) as { txs_results?: { events?: RawEvent[] }[] | null; finalize_block_events?: RawEvent[] | null };
      for (const tx of r.txs_results ?? []) out.push(...depositEventsOf(tx.events ?? [], rollupId));
      out.push(...depositEventsOf(r.finalize_block_events ?? [], rollupId));
      return out;
    },

    async inbox() {
      const body = await get(`${rest}/qorechain/rdk/v1/inbox/${rid}`, "inbox");
      const i = (body["inbox"] ?? body) as Record<string, unknown>;
      return {
        headSequence: Number(i["head_sequence"] ?? i["headSequence"] ?? 0),
        headAcc: hexOf(i["head_acc"] ?? i["headAcc"]),
        consumedSequence: Number(i["consumed_sequence"] ?? i["consumedSequence"] ?? 0),
        consumedAcc: hexOf(i["consumed_acc"] ?? i["consumedAcc"]),
      };
    },
  };
}
