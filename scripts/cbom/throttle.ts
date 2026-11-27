/**
 * A local CONNECT proxy that spaces out what a client sends, so a scanner that fires its requests back to
 * back reaches the public node at about one a second. The public endpoints sit behind a rate limit that our
 * hosted services share, so every read we make by hand is paced.
 *
 * QoreScan reads the chain with Go's HTTP client, which honours HTTPS_PROXY: each request goes through a
 * CONNECT tunnel here, still encrypted end to end (the proxy never sees a request, only its bytes). The
 * scanner sends one request and waits for its answer before the next, so holding each client-to-node write
 * until at least `gapMs` after the previous one paces the requests. Handshake flights are paced the same way,
 * which only makes a scan slower. The node's answers pass straight through.
 *
 * Only the `host:port` pairs in `allow` are reachable, and the proxy listens on 127.0.0.1.
 */
import { connect, createServer, type Server, type Socket } from "node:net";

/** When the next write may go: at once for the first, else no sooner than `gapMs` after the last. */
export function nextSlot(last: number | undefined, now: number, gapMs: number): number {
  return last === undefined ? now : Math.max(now, last + gapMs);
}

export interface Pacer {
  /** Resolves when the caller may send; callers are released one at a time, in order. */
  wait(): Promise<void>;
}

export function pacer(
  gapMs: number,
  clock: { now(): number; sleep(ms: number): Promise<void> } = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
): Pacer {
  let last: number | undefined;
  let queue: Promise<void> = Promise.resolve();
  return {
    wait() {
      const turn = queue.then(async () => {
        const at = nextSlot(last, clock.now(), gapMs);
        const delay = at - clock.now();
        if (delay > 0) await clock.sleep(delay);
        last = at;
      });
      queue = turn;
      return turn;
    },
  };
}

export interface ThrottleProxy {
  /** For HTTPS_PROXY. */
  url: string;
  /** Client-to-node writes forwarded so far, each one paced. */
  writes(): number;
  /** Tunnels opened so far. */
  tunnels(): number;
  close(): Promise<void>;
}

const CONNECT_LINE = /^CONNECT ([A-Za-z0-9.-]+:\d{1,5}) HTTP\/1\.[01]$/;

export async function startThrottleProxy(opts: { allow: readonly string[]; gapMs: number }): Promise<ThrottleProxy> {
  const allow = new Set(opts.allow.map((a) => a.toLowerCase()));
  const pace = pacer(opts.gapMs);
  let writes = 0;
  let tunnels = 0;
  const open = new Set<Socket>();
  const track = (s: Socket) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  };

  const server: Server = createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onHead = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192) client.destroy();
        return;
      }
      client.off("data", onHead);
      client.pause();
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const target = CONNECT_LINE.exec(line)?.[1]?.toLowerCase();
      if (!target || !allow.has(target)) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const early = head.subarray(end + 4);
      const sep = target.lastIndexOf(":");
      const node = connect(Number(target.slice(sep + 1)), target.slice(0, sep));
      track(node);
      node.on("error", () => client.destroy());
      client.on("error", () => node.destroy());
      client.on("close", () => node.destroy());
      node.on("close", () => client.destroy());
      node.once("connect", () => {
        tunnels++;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        node.pipe(client);
        let sent: Promise<void> = Promise.resolve();
        const forward = (chunk: Buffer) => {
          sent = sent
            .then(() => pace.wait())
            .then(() => {
              writes++;
              if (!node.destroyed) node.write(chunk);
            });
        };
        if (early.length > 0) forward(early);
        client.on("data", forward);
        client.on("end", () => void sent.then(() => node.end()));
        client.resume();
      });
    };
    client.on("data", onHead);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    writes: () => writes,
    tunnels: () => tunnels,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}
