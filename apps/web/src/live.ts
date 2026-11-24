/**
 * The page's live view of the chain: one set of websocket subscriptions,
 * opened once and shared by every component (a node allows only a few
 * subscriptions per client). A subscription the node refuses, or loses on a
 * reconnect, is kept and asked for again by the client (see @vigil/chain-ws).
 */
import { ROLLUP } from "./config.ts";
import { rpc, type RpcEvent } from "./rpc.ts";

export type LiveItem =
  | { kind: "post"; at: number; height: number; tx: string; sequence: number; poster: string; size: number }
  | { kind: "batch"; at: number; height: number; tx: string; batchIndex: number; stateRoot: string; pqcVerified: boolean; inboxEnd: number }
  | { kind: "fraud"; at: number; height: number; tx: string; batchIndex: number; challenger: string; submitter: string; reward: string; slashed: string };

export interface Head {
  height: number;
  time: string;
}

type Sink = { onHead?(h: Head): void; onItem?(i: LiveItem): void };
const sinks = new Set<Sink>();
const recent: LiveItem[] = [];
let head: Head | undefined;
let started = false;

const first = (ev: RpcEvent, key: string): string => ev.events?.[key]?.[0] ?? "";
const num = (s: string): number => {
  const n = Number(s || 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

function emit(item: LiveItem): void {
  recent.unshift(item);
  recent.splice(40);
  for (const s of sinks) s.onItem?.(item);
}

/** Open the shared subscriptions (once). The client keeps renewing any that fail. */
export function startLive(): void {
  if (started) return;
  started = true;
  const tx = (type: string) => `tm.event='Tx' AND ${type}.rollup_id='${ROLLUP}'`;
  void rpc.subscribe("tm.event='NewBlockHeader'", (ev) => {
    const h = (ev.data.value as { header?: { height?: string; time?: string } }).header;
    if (!h) return;
    head = { height: num(h.height ?? ""), time: h.time ?? "" };
    for (const s of sinks) s.onHead?.(head);
  });
  void rpc.subscribe(tx("rdk_data_posted"), (ev) =>
    emit({
      kind: "post",
      at: Date.now(),
      height: num(first(ev, "tx.height")),
      tx: first(ev, "tx.hash"),
      sequence: num(first(ev, "rdk_data_posted.sequence")),
      poster: first(ev, "rdk_data_posted.poster"),
      size: num(first(ev, "rdk_data_posted.size")),
    }),
  );
  void rpc.subscribe(tx("batch_submitted"), (ev) =>
    emit({
      kind: "batch",
      at: Date.now(),
      height: num(first(ev, "tx.height")),
      tx: first(ev, "tx.hash"),
      batchIndex: num(first(ev, "batch_submitted.batch_index")),
      stateRoot: first(ev, "state_anchored.state_root"),
      pqcVerified: first(ev, "state_anchored.pqc_verified") === "true",
      inboxEnd: num(first(ev, "rdk_inbox_consumed.inbox_end")),
    }),
  );
  void rpc.subscribe(tx("rdk_fraud_upheld"), (ev) =>
    emit({
      kind: "fraud",
      at: Date.now(),
      height: num(first(ev, "tx.height")),
      tx: first(ev, "tx.hash"),
      batchIndex: num(first(ev, "rdk_fraud_upheld.batch_index")),
      challenger: first(ev, "rdk_fraud_upheld.challenger"),
      submitter: first(ev, "rdk_fraud_upheld.submitter"),
      reward: first(ev, "rdk_fraud_upheld.challenger_reward"),
      slashed: first(ev, "rdk_fraud_upheld.slashed"),
    }),
  );
}

/** Listen to the live feed. Returns the items seen so far (newest first) and an unsubscribe function. */
export function listen(sink: Sink): { recent: LiveItem[]; head: Head | undefined; stop(): void } {
  startLive();
  sinks.add(sink);
  return { recent: [...recent], head, stop: () => sinks.delete(sink) };
}
