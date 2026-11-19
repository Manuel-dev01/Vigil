/**
 * Network hardening for scripts that talk to the chain.
 *
 * - Prefer IPv4: some networks advertise IPv6 routes to the qore.host CDN that
 *   never connect.
 * - Allow slow TCP connects (seen at 9 to 20 s on some links; undici's default
 *   is 10 s) and keep connections alive so each request does not reconnect.
 * - Use undici's OWN fetch together with its Agent. Node's built-in fetch ships
 *   a different undici; pairing it with an npm undici Agent made large gzip
 *   replies come back undecoded on Node 26 (found by OoJae's agent in PR #1:
 *   pqcKeyStatus and /qorechain/pqc/v1/account replies). Replacing
 *   globalThis.fetch keeps the dispatcher and the fetch implementation in step
 *   for every library that calls fetch at request time (RDK, SDK, viem).
 *
 * Import this first in every entry point that uses the network. Kept in step
 * with scripts/lib/net.ts.
 */
import { setDefaultResultOrder } from "node:dns";
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

setDefaultResultOrder("ipv4first");
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 60_000 },
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 300_000,
    connections: 8,
  }),
);

/** The fetch every script should use (also installed as globalThis.fetch). */
export const netFetch = undiciFetch as unknown as typeof globalThis.fetch;
globalThis.fetch = netFetch;
