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

export interface WsRpcOptions {
  /** For example `wss://rpc-testnet.qore.host/websocket`. */
  url: string;
  /** Per-call timeout (default 20 s). */
  timeoutMs?: number;
  /** Reopen the socket after it closes while subscriptions are live (default true). */
  reconnect?: boolean;
  /** A WebSocket constructor, if the platform has none. */
  WebSocket?: typeof WebSocket;
  onState?: (state: RpcState) => void;
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

interface Subscription {
  query: string;
  on(event: RpcEvent): void;
  rpcId?: number;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

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

  constructor(readonly opts: WsRpcOptions) {}

  get url(): string {
    return this.opts.url;
  }

  private open(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("the RPC client was closed"));
    if (this.socket && this.socket.readyState === 1) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    const Ctor = this.opts.WebSocket ?? globalThis.WebSocket;
    if (!Ctor) return Promise.reject(new Error("no WebSocket on this platform: pass one in the options"));
    this.opts.onState?.("connecting");
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new Ctor(this.opts.url);
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.socket = ws;
        this.opening = undefined;
        this.retries = 0;
        this.opts.onState?.("open");
        resolve(ws);
        for (const s of this.subs) void this.sendSubscribe(s).catch(() => undefined);
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          this.opening = undefined;
          reject(new Error(`websocket ${this.opts.url} did not open`));
        }
      };
      ws.onclose = () => this.onClose(ws);
      ws.onmessage = (m: MessageEvent) => this.onMessage(typeof m.data === "string" ? m.data : String(m.data));
    });
    return this.opening;
  }

  private onClose(ws: WebSocket): void {
    if (this.socket === ws) this.socket = undefined;
    this.byRpcId.clear();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`websocket closed during ${p.method}`));
      this.pending.delete(id);
    }
    this.opts.onState?.("closed");
    if (!this.closed && (this.opts.reconnect ?? true) && this.subs.size > 0 && !this.reconnectTimer) {
      const delay = Math.min(30_000, 1_000 * 2 ** this.retries++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.open().catch(() => this.onClose(ws));
      }, delay);
    }
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
    if (sub && result && typeof result.query === "string") sub.on(result);
  }

  private send(ws: WebSocket, id: number, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.opts.timeoutMs ?? 20_000} ms`));
      }, this.opts.timeoutMs ?? 20_000);
      this.pending.set(id, { method, resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
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

  private async sendSubscribe(s: Subscription): Promise<void> {
    const ws = await this.open();
    const id = ++this.nextId;
    s.rpcId = id;
    this.byRpcId.set(id, s);
    try {
      await this.send(ws, id, "subscribe", { query: s.query });
    } catch (e) {
      this.byRpcId.delete(id);
      throw e;
    }
  }

  /**
   * Subscribe to a CometBFT event query, for example `tm.event='NewBlockHeader'`
   * or `tm.event='Tx' AND batch_submitted.rollup_id='vigil-pay-1'`. The
   * subscription is renewed after a reconnect. Returns a function that ends it.
   */
  async subscribe(query: string, on: (event: RpcEvent) => void): Promise<() => Promise<void>> {
    const s: Subscription = { query, on };
    this.subs.add(s);
    try {
      await this.sendSubscribe(s);
    } catch (e) {
      this.subs.delete(s);
      throw e;
    }
    return async () => {
      this.subs.delete(s);
      if (s.rpcId !== undefined) this.byRpcId.delete(s.rpcId);
      if (this.socket && this.socket.readyState === 1) await this.call("unsubscribe", { query }).catch(() => undefined);
    };
  }

  /** Close the socket and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.subs.clear();
    this.byRpcId.clear();
    this.socket?.close();
    this.socket = undefined;
  }
}
