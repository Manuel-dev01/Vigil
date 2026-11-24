/**
 * The websocket client's subscriptions, against a scripted socket: each is sent once per connection,
 * a refused or dropped one is kept and asked for again, and health() says how many are live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsRpc, type RpcHealth } from "../src/rpc.ts";

interface Sent {
  id: number;
  method: string;
  params: { query?: string };
}

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Sent[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  // ---- driven by the test
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  refuse(): void {
    this.readyState = 3;
    this.onerror?.({});
    this.onclose?.({});
  }
  answer(id: number, result: unknown = {}): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) });
  }
  fail(id: number, message: string): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }) });
  }
  subscribes(): Sent[] {
    return this.sent.filter((m) => m.method === "subscribe");
  }
}

const last = (): FakeSocket => FakeSocket.all.at(-1)!;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function client(): { rpc: WsRpc; health: () => RpcHealth } {
  const rpc = new WsRpc({ url: "wss://node.invalid/websocket", timeoutMs: 5_000, WebSocket: FakeSocket as unknown as typeof WebSocket });
  return { rpc, health: () => rpc.health() };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("WsRpc subscriptions", () => {
  it("sends each subscription once on the first connect", async () => {
    const { rpc, health } = client();
    const a = rpc.subscribe("tm.event='NewBlockHeader'", () => undefined);
    const b = rpc.subscribe("tm.event='Tx'", () => undefined);
    expect(FakeSocket.all).toHaveLength(1);
    last().accept();
    await flush();
    const subs = last().subscribes();
    expect(subs.map((s) => s.params.query).sort()).toEqual(["tm.event='NewBlockHeader'", "tm.event='Tx'"]);
    for (const s of subs) last().answer(s.id);
    await Promise.all([a, b]);
    expect(health()).toMatchObject({ socket: "open", subscriptions: 2, active: 2, failed: 0 });
    rpc.close();
  });

  it("keeps a subscription whose socket never opened, and renews it after the reconnect", async () => {
    const { rpc, health } = client();
    const events: unknown[] = [];
    const sub = rpc.subscribe("tm.event='NewBlockHeader'", (e) => events.push(e));
    last().refuse();
    await sub; // resolves: the subscription is kept, not dropped
    expect(health()).toMatchObject({ subscriptions: 1, active: 0 });
    expect(health().socket).not.toBe("open");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    last().accept();
    await flush();
    const [s] = last().subscribes();
    expect(s?.params.query).toBe("tm.event='NewBlockHeader'");
    last().answer(s!.id);
    await flush();
    expect(health()).toMatchObject({ socket: "open", active: 1 });
    last().answer(s!.id, { query: "tm.event='NewBlockHeader'", data: { type: "x", value: {} } });
    expect(events).toHaveLength(1);
    rpc.close();
  });

  it("asks again for a subscription the node refused while the socket stays open", async () => {
    const { rpc, health } = client();
    const sub = rpc.subscribe("tm.event='Tx'", () => undefined);
    last().accept();
    await flush();
    const [first] = last().subscribes();
    last().fail(first!.id, "max_subscriptions_per_client reached");
    await sub;
    expect(health()).toMatchObject({ socket: "open", subscriptions: 1, active: 0, failed: 1 });
    expect(health().lastError).toMatch(/max_subscriptions/);

    await vi.advanceTimersByTimeAsync(2_000);
    const again = last().subscribes();
    expect(again).toHaveLength(2);
    last().answer(again[1]!.id);
    await flush();
    expect(health()).toMatchObject({ active: 1, failed: 0 });
    rpc.close();
  });

  it("renews live subscriptions once each after the socket drops", async () => {
    const { rpc, health } = client();
    const sub = rpc.subscribe("tm.event='Tx'", () => undefined);
    last().accept();
    await flush();
    last().answer(last().subscribes()[0]!.id);
    await sub;
    expect(health().active).toBe(1);

    last().close();
    expect(health().active).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    last().accept();
    await flush();
    expect(last().subscribes()).toHaveLength(1);
    rpc.close();
  });

  it("rejects a call whose socket closes before it opens", async () => {
    const { rpc } = client();
    const call = rpc.call("status");
    last().readyState = 3;
    last().onclose?.({}); // closed with no error event
    await expect(call).rejects.toThrow(/closed before it opened/);
    rpc.close();
  });

  it("stops asking once a subscription is ended", async () => {
    const { rpc, health } = client();
    const end = rpc.subscribe("tm.event='Tx'", () => undefined);
    last().accept();
    await flush();
    last().answer(last().subscribes()[0]!.id);
    const ending = (await end)();
    await flush();
    expect(health().subscriptions).toBe(0);
    const un = last().sent.find((m) => m.method === "unsubscribe");
    expect(un?.params.query).toBe("tm.event='Tx'");
    last().answer(un!.id);
    await ending;
    rpc.close();
  });
});
