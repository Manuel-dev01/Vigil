/**
 * Network hardening for scripts that talk to the chain.
 *
 * - Prefer IPv4: some networks advertise IPv6 routes to the qore.host CDN that
 *   never connect.
 * - Allow slow TCP connects (seen at 9 to 20 s on some links; undici's default
 *   is 10 s) and keep connections alive so each request does not reconnect.
 *
 * Import this first in every script that uses the network.
 */
import { setDefaultResultOrder } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

setDefaultResultOrder("ipv4first");
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000 },
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connections: 8,
  }),
);
