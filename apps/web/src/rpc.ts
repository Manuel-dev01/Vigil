/**
 * The page's one websocket to the node, and its health for the status badge. Light on purpose: the
 * app shell imports it, and the chain libraries (the RDK and its SDK) load later, with the views.
 */
import { WsRpc, type RpcHealth } from "@vigil/chain-ws/rpc";
import { WS_URL } from "./config.ts";

export type { RpcEvent, RpcHealth } from "@vigil/chain-ws/rpc";

type Listener = (h: RpcHealth) => void;
const listeners = new Set<Listener>();
let current: RpcHealth = { socket: "connecting", subscriptions: 0, active: 0, failed: 0 };
let everOpen = false;
const reconnectListeners = new Set<() => void>();

export const rpc = new WsRpc({
  url: WS_URL,
  timeoutMs: 30_000,
  onHealth: (h) => {
    const reopened = h.socket === "open" && current.socket !== "open" && everOpen;
    if (h.socket === "open") everOpen = true;
    current = h;
    for (const l of listeners) l(h);
    if (reopened) for (const f of reconnectListeners) f();
  },
});

export const health = (): RpcHealth => current;
/** Whether the socket has been open before (so "connecting" now means reconnecting). */
export const wasOpen = (): boolean => everOpen;

export function onHealth(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Called each time the socket opens again after it had dropped. */
export function onReconnect(f: () => void): () => void {
  reconnectListeners.add(f);
  return () => reconnectListeners.delete(f);
}

export interface Badge {
  tone: "open" | "connecting" | "closed" | "degraded";
  label: string;
  detail: string;
}

/** What the header badge says: "Live" only when the socket is open and every subscription is confirmed. */
export function badgeOf(h: RpcHealth, reopening: boolean): Badge {
  const subs = `${h.active} of ${h.subscriptions} live subscriptions confirmed by the node`;
  if (h.socket !== "open") {
    return reopening
      ? { tone: "closed", label: "Reconnecting", detail: `The connection to ${WS_URL} dropped; reconnecting.` }
      : { tone: "connecting", label: "Connecting", detail: `Connecting to ${WS_URL}.` };
  }
  if (h.subscriptions === 0) return { tone: "open", label: "Connected", detail: `Connected to ${WS_URL}; no live subscription on this page.` };
  if (h.active === h.subscriptions) return { tone: "open", label: "Live", detail: `${WS_URL}: ${subs}.` };
  if (h.failed > 0)
    return { tone: "degraded", label: "Live feed degraded", detail: `${WS_URL}: ${subs}; the node refused ${h.failed}${h.lastError ? ` (${h.lastError})` : ""}. Retrying.` };
  return { tone: "connecting", label: "Subscribing", detail: `${WS_URL}: ${subs}.` };
}
