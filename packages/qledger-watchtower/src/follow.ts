/**
 * Push-based following over CometBFT's websocket (`<rpc>/websocket`).
 *
 * The node pushes each matching tx as soon as its block commits. That is about
 * 1.8 s after the block's header time on qorechain-diana (measured 19 Nov), and
 * a 10 s REST poll cannot match it. `NewBlockHeader` doubles as a heartbeat:
 * when no header arrives for `staleMs`, the socket is assumed dead and
 * reopened, and `connected` stays false until it is back, so the caller can
 * poll in the meantime.
 */
import type { TxEventMap } from "./fast.ts";

export interface TxEvent {
  /** Index of the query (in the order given) that matched. */
  query: number;
  height: number;
  txBase64: string;
  events: TxEventMap;
  receivedAt: number;
}

export interface FollowerOptions {
  /** Treat the socket as dead after this long without a block header. Default 15 s. */
  staleMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** For tests. */
  webSocket?: typeof WebSocket;
}

/** `https://host` → `wss://host/websocket`. */
export function websocketUrl(rpc: string): string {
  return rpc.replace(/^http/, "ws").replace(/\/+$/, "") + "/websocket";
}

const HEADER = "tm.event='NewBlockHeader'";

export class TxFollower {
  connected = false;
  lastHeight = 0;
  private ws?: WebSocket;
  private stopped = false;
  private backoffMs = 1000;
  private lastHeaderAt = 0;
  private watchdog?: ReturnType<typeof setInterval>;

  constructor(
    private readonly url: string,
    private readonly queries: string[],
    private readonly onTx: (e: TxEvent) => void,
    private readonly opts: FollowerOptions = {},
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
    const staleMs = this.opts.staleMs ?? 15_000;
    this.watchdog = setInterval(() => {
      if (this.connected && Date.now() - this.lastHeaderAt > staleMs) {
        this.opts.log?.("ws-stale", { sinceHeaderMs: Date.now() - this.lastHeaderAt });
        this.ws?.close();
      }
    }, 2_000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  private open(): void {
    const WS = this.opts.webSocket ?? WebSocket;
    const ws = new WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      [HEADER, ...this.queries].forEach((query, id) => ws.send(JSON.stringify({ jsonrpc: "2.0", method: "subscribe", id, params: { query } })));
      this.lastHeaderAt = Date.now();
      this.connected = true;
      this.backoffMs = 1000;
      this.opts.log?.("ws-open", { url: this.url, queries: this.queries.length });
    };
    ws.onmessage = (m: MessageEvent) => this.handle(String(m.data));
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (this.stopped) return;
      if (was) this.opts.log?.("ws-closed", { reconnectInMs: this.backoffMs });
      setTimeout(() => this.open(), this.backoffMs).unref?.();
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }

  private handle(raw: string): void {
    let msg: { result?: { query?: string; data?: { value?: Record<string, any> }; events?: TxEventMap } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const r = msg.result;
    if (!r?.query) return; // subscription acks
    if (r.query === HEADER) {
      this.lastHeaderAt = Date.now();
      const h = Number(r.data?.value?.header?.height ?? 0);
      if (h > this.lastHeight) this.lastHeight = h;
      return;
    }
    const query = this.queries.indexOf(r.query);
    const txr = r.data?.value?.TxResult;
    if (query < 0 || !txr?.tx) return;
    this.onTx({ query, height: Number(txr.height), txBase64: String(txr.tx), events: r.events ?? {}, receivedAt: Date.now() });
  }
}
