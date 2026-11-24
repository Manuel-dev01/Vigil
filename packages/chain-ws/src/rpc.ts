/**
 * JSON-RPC 2.0 over a CometBFT websocket (`wss://<node>/websocket`).
 *
 * QoreChain's public REST and RPC endpoints send no CORS headers, so a web page
 * on another origin cannot read them with `fetch`. A websocket is not subject
 * to CORS, and the node's websocket answers every CometBFT RPC method,
 * including `abci_query` (any gRPC query), `tx`, `tx_search` and event
 * subscriptions. This client is the one connection a browser page needs.
 *
 * It uses the platform `WebSocket` (browsers, and Node 22 or later).
 */

export interface RpcEvent {
  query: string;
  data: { type: string; value: unknown };
  /** CometBFT's flattened events: `"<type>.<key>"` to values, one per occurrence. */
  events?: Record<string, string[]>;
}

export interface AbciQueryResult {
  code: number;
  log: string;
  codespace: string;
  height: number;
  value: Uint8Array;
}

export type RpcState = "connecting" | "open" | "closed";

/** The socket and the subscriptions on it, as one picture for a status badge. */
export interface RpcHealth {
  socket: RpcState;
  /** Subscriptions the client holds (live or waiting to be renewed). */
  subscriptions: number;
  /** Subscriptions the node has confirmed on the current connection. */
  active: number;
  /** Subscriptions the node refused or did not answer; each is retried. */
  failed: number;
  /** The last reason a subscription failed, if one has. */
  lastError?: string;
}

export interface WsRpcOptions {
  /** For example `wss://rpc-testnet.qore.host/websocket`. */
  url: string;
  /** Per-call timeout (default 20 s). */
  timeoutMs?: number;
  /** Reopen the socket after it closes while subscriptions are live (default true). */
  reconnect?: boolean;
  /** First delay before a refused subscription is asked again (default 2 s, doubling up to 60 s). */
  resubscribeMs?: number;
  /** A WebSocket constructor, if the platform has none. */
  WebSocket?: typeof WebSocket;
  onState?: (state: RpcState) => void;
  /** Called whenever the socket or any subscription changes state. */
  onHealth?: (health: RpcHealth) => void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type SubStatus = "idle" | "inflight" | "active" | "failed";

interface Subscription {
  query: string;
  on(event: RpcEvent): void;
  status: SubStatus;
  /** Request ids whose events belong to this subscription. */
  ids: Set<number>;
  error?: string | undefined;
  retries: number;
  retryTimer?: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
}

class TimeoutError extends Error {}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class WsRpc {
  private socket: WebSocket | undefined;
  private opening: Promise<WebSocket> | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly subs = new Set<Subscription>();
  private readonly byRpcId = new Map<number, Subscription>();
  private closed = false;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError: string | undefined;

  constructor(readonly opts: WsRpcOptions) {}

  get url(): string {
    return this.opts.url;
  }

  /** The socket and the subscriptions, now. */
  health(): RpcHealth {
    let active = 0;
    let failed = 0;
    for (const s of this.subs) {
      if (s.status === "active") active++;
      else if (s.status === "failed") failed++;
    }
    const socket: RpcState = this.socket && this.socket.readyState === 1 ? "open" : this.opening || this.reconnectTimer ? "connecting" : "closed";
    return { socket, subscriptions: this.subs.size, active, failed, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  private changed(): void {
    this.opts.onHealth?.(this.health());
  }

  private setState(s: RpcState): void {
    this.opts.onState?.(s);
    this.changed();
  }

  private open(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("the RPC client was closed"));
    if (this.socket && this.socket.readyState === 1) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const Ctor = this.opts.WebSocket ?? globalThis.WebSocket;
    if (!Ctor) return Promise.reject(new Error("no WebSocket on this platform: pass one in the options"));
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new Ctor(this.opts.url);
      let settled = false;
      // A socket can fail with an error event, or close with none: either way the caller hears of it.
      const fail = (why: string): void => {
        if (settled) return;
        settled = true;
        if (this.opening === p) this.opening = undefined;
        reject(new Error(why));
      };
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        this.socket = ws;
        this.opening = undefined;
        this.retries = 0;
        resolve(ws);
        this.setState("open");
        this.resubscribe();
      };
      ws.onerror = () => fail(`websocket ${this.opts.url} did not open`);
      ws.onclose = () => {
        fail(`websocket ${this.opts.url} closed before it opened`);
        this.onClose(ws);
      };
      ws.onmessage = (m: MessageEvent) => this.onMessage(typeof m.data === "string" ? m.data : String(m.data));
    });
    const p = this.opening;
    // The promise may already have failed synchronously; never leave a rejection unobserved here.
    p.catch(() => undefined);
    this.setState("connecting");
    return p;
  }

  private onClose(ws: WebSocket): void {
    if (this.socket === ws) this.socket = undefined;
    else if (this.socket) return; // an old socket closing late: the current one is unaffected
    for (const [id, s] of this.byRpcId) {
      this.byRpcId.delete(id);
      s.ids.delete(id);
    }
    for (const s of this.subs) {
      if (s.status === "active" || s.status === "failed") s.status = "idle";
      if (s.retryTimer) clearTimeout(s.retryTimer);
      s.retryTimer = undefined;
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`websocket closed during ${p.method}`));
      this.pending.delete(id);
    }
    this.scheduleReconnect();
    this.setState("closed");
  }

  private scheduleReconnect(): void {
    if (this.closed || !(this.opts.reconnect ?? true) || this.subs.size === 0 || this.reconnectTimer || this.opening) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.retries++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private onMessage(raw: string): void {
    let msg: { id?: number | string; result?: unknown; error?: { code: number; message: string; data?: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const id = Number(msg.id);
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(`${p.method}: ${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`, msg.error.code, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    const sub = this.byRpcId.get(id);
    const result = msg.result as RpcEvent | undefined;
    if (sub && !sub.ended && result && typeof result.query === "string") sub.on(result);
  }

  private send(ws: WebSocket, id: number, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`${method} timed out after ${this.opts.timeoutMs ?? 20_000} ms`));
      }, this.opts.timeoutMs ?? 20_000);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Call one CometBFT RPC method, for example `status`, `block`, `tx` or `tx_search`. */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = await this.open();
    return (await this.send(ws, ++this.nextId, method, params)) as T;
  }

  /** Run a gRPC query (`/package.Service/Method`) through `abci_query`. */
  async abciQuery(path: string, data: Uint8Array, height?: number): Promise<AbciQueryResult> {
    const res = await this.call<{ response: { code?: number; log?: string; codespace?: string; height?: string; value?: string | null } }>("abci_query", {
      path,
      data: toHex(data),
      height: height === undefined ? "0" : String(height),
      prove: false,
    });
    const r = res.response;
    return {
      code: r.code ?? 0,
      log: r.log ?? "",
      codespace: r.codespace ?? "",
      height: Number(r.height ?? 0),
      value: r.value ? fromBase64(r.value) : new Uint8Array(),
    };
  }

  /** Renew every subscription that is not live or already being asked for (after a (re)connect). */
  private resubscribe(): void {
    for (const s of this.subs) if (s.status === "idle" || s.status === "failed") void this.sendSubscribe(s);
  }

  /** Ask the node for one subscription. Never throws: the outcome is the subscription's status. */
  private async sendSubscribe(s: Subscription): Promise<void> {
    if (s.ended || s.status === "inflight" || s.status === "active") return;
    if (s.retryTimer) clearTimeout(s.retryTimer);
    s.retryTimer = undefined;
    s.status = "inflight";
    this.changed();
    let ws: WebSocket;
    try {
      ws = await this.open();
    } catch (e) {
      // The socket did not open; the reconnect renews this subscription.
      s.status = "idle";
      s.error = message(e);
      this.scheduleReconnect();
      this.changed();
      return;
    }
    if (s.ended) return;
    const id = ++this.nextId;
    s.ids.add(id);
    this.byRpcId.set(id, s);
    try {
      await this.send(ws, id, "subscribe", { query: s.query });
      s.retries = 0;
      s.error = undefined;
      if (s.ended) {
        // Ended while the node was answering: end it on the node too.
        s.status = "idle";
        void this.call("unsubscribe", { query: s.query }).catch(() => undefined);
      } else {
        s.status = "active";
      }
    } catch (e) {
      const live = this.socket === ws && ws.readyState === 1;
      // A refusal answers for this id; a timeout may still be followed by events for it, so keep routing those.
      if (!(e instanceof TimeoutError)) {
        this.byRpcId.delete(id);
        s.ids.delete(id);
      }
      if (live && /already subscribed/i.test(message(e))) {
        s.status = "active"; // the node holds it already on this connection
      } else if (!live) {
        s.status = "idle"; // the socket went away; the reconnect renews it
      } else {
        s.status = "failed";
        s.error = message(e);
        this.lastError = s.error;
        const delay = Math.min(60_000, (this.opts.resubscribeMs ?? 2_000) * 2 ** s.retries++);
        s.retryTimer = setTimeout(() => {
          s.retryTimer = undefined;
          if (s.status === "failed") void this.sendSubscribe(s);
        }, delay);
      }
    }
    this.changed();
  }

  /**
   * Subscribe to a CometBFT event query, for example `tm.event='NewBlockHeader'`
   * or `tm.event='Tx' AND batch_submitted.rollup_id='vigil-pay-1'`. The
   * subscription is kept until the returned function ends it: if the node
   * refuses it or the socket drops, it is asked for again (after a reconnect,
   * or after a backoff while the socket stays open). Resolves once the first
   * attempt has been answered either way; `health()` tells which.
   */
  async subscribe(query: string, on: (event: RpcEvent) => void): Promise<() => Promise<void>> {
    const s: Subscription = { query, on, status: "idle", ids: new Set(), retries: 0, ended: false };
    this.subs.add(s);
    await this.sendSubscribe(s);
    return async () => {
      if (s.ended) return;
      s.ended = true;
      if (s.retryTimer) clearTimeout(s.retryTimer);
      this.subs.delete(s);
      for (const id of s.ids) this.byRpcId.delete(id);
      const wasActive = s.status === "active";
      s.status = "idle";
      this.changed();
      if (wasActive && this.socket && this.socket.readyState === 1) await this.call("unsubscribe", { query }).catch(() => undefined);
    };
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const s of this.subs) {
      s.ended = true;
      if (s.retryTimer) clearTimeout(s.retryTimer);
    }
    this.subs.clear();
    this.byRpcId.clear();
    this.socket?.close();
    this.socket = undefined;
  }
}
