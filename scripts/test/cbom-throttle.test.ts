/**
 * Pacing (scripts/cbom/throttle.ts): the slot rule, the pacer on a fake clock, and the CONNECT proxy over
 * 127.0.0.1 only, with no other network.
 */
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { nextSlot, pacer, startThrottleProxy } from "../cbom/throttle.ts";

describe("pacing", () => {
  it("lets the first write go at once and spaces the rest", () => {
    expect(nextSlot(undefined, 50, 1000)).toBe(50);
    expect(nextSlot(50, 60, 1000)).toBe(1050);
    expect(nextSlot(50, 5000, 1000)).toBe(5000);
  });

  it("releases waiters in order, a gap apart, on a fake clock", async () => {
    let t = 0;
    const p = pacer(1000, { now: () => t, sleep: async (ms) => void (t += ms) });
    const at: number[] = [];
    await Promise.all([1, 2, 3].map(() => p.wait().then(() => at.push(t))));
    expect(at).toEqual([0, 1000, 2000]);
    t += 5000;
    await p.wait();
    expect(t).toBe(7000);
  });

  it("paces a client's writes through the proxy and refuses targets it was not given (loopback only)", async () => {
    const arrivals: number[] = [];
    const upstream = createServer((s) => s.on("data", () => arrivals.push(Date.now())));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const target = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const gap = 60;
    const proxy = await startThrottleProxy({ allow: [target], gapMs: gap });
    const port = Number(new URL(proxy.url).port);
    const tunnel = (to: string) =>
      new Promise<{ socket: Socket; status: string }>((ok, fail) => {
        const socket = connect(port, "127.0.0.1", () => socket.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`));
        socket.once("data", (d) => ok({ socket, status: d.toString("latin1").split("\r\n")[0] ?? "" }));
        socket.once("error", fail);
      });
    try {
      const refused = await tunnel("127.0.0.1:1");
      expect(refused.status).toBe("HTTP/1.1 403 Forbidden");
      refused.socket.destroy();

      const { socket, status } = await tunnel(target);
      expect(status).toBe("HTTP/1.1 200 Connection Established");
      // Each write goes once the previous one has arrived, as a scanner's next request follows its last
      // answer, so no two writes can merge in transit; the pacer must still hold each one a gap back.
      const arrived = async (n: number) => {
        for (let waited = 0; arrivals.length < n; waited += 2) {
          if (waited > 5_000) throw new Error(`only ${arrivals.length} of ${n} writes arrived`);
          await new Promise((r) => setTimeout(r, 2));
        }
      };
      for (const [i, chunk] of ["one", "two", "three"].entries()) {
        socket.write(chunk);
        await arrived(i + 1);
      }
      expect(arrivals).toHaveLength(3);
      expect(proxy.writes()).toBe(3);
      expect(proxy.tunnels()).toBe(1);
      for (let i = 1; i < arrivals.length; i++) expect(arrivals[i]! - arrivals[i - 1]!).toBeGreaterThanOrEqual(gap - 2);
      socket.destroy();
    } finally {
      await proxy.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });
});
