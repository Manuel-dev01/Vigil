/**
 * The browser watchtower's Web Worker: re-execution, lookups and the tamper demo run here, off the
 * page's main thread. It receives what the page read from the node and answers with plain data. It
 * has no network code, no key and no way to send a transaction.
 */
import { challengeCommand, forge, lookup, replay, type Forgery, type Lookup, type ReplayInput, type ReplayResult, type Session } from "./core.ts";

export type ReplayRequest =
  | { id: number; kind: "run"; input: ReplayInput }
  | { id: number; kind: "lookup"; account: string }
  | { id: number; kind: "forge"; key: string; sequence: number; amount: string };

export type ReplayAnswer = ReplayResult | Lookup | (Forgery & { command: string });

export type ReplayResponse = { id: number; ok: true; value: ReplayAnswer } | { id: number; ok: false; error: string };

let session: Session | undefined;

function answer(req: ReplayRequest): ReplayAnswer {
  if (req.kind === "run") {
    session = replay(req.input);
    return session.result;
  }
  if (!session) throw new Error("re-execute the rollup first");
  if (req.kind === "lookup") return lookup(session, req.account);
  const f = forge(session, req.key, req.sequence, BigInt(req.amount));
  return { ...f, command: challengeCommand(session.env.rollupId, session.env.chainId, f.batchIndex, f.proofHex) };
}

addEventListener("message", (ev: MessageEvent<ReplayRequest>) => {
  const req = ev.data;
  let res: ReplayResponse;
  try {
    res = { id: req.id, ok: true, value: answer(req) };
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  postMessage(res);
});
