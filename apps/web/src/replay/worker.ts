/**
 * The browser watchtower's Web Worker: re-execution, lookups and the tamper demo run here, off the
 * page's main thread. It receives what the page read from the node and answers with plain data. It
 * has no network code, no key and no way to send a transaction.
 */
import {
  CHALLENGE_GAS_PRICE,
  challengeCommand,
  challengeGas,
  forge,
  lookup,
  replay,
  type Forgery,
  type Lookup,
  type ReplayInput,
  type ReplayResult,
  type Session,
} from "./core.ts";

export type ReplayRequest =
  | { id: number; kind: "run"; input: ReplayInput }
  | { id: number; kind: "lookup"; account: string }
  | { id: number; kind: "forge"; key: string; sequence: number; amount: string };

/** The tamper demo's answer: the forgery, and the challenge command printed for it with its gas and fee. */
export type ForgeAnswer = Forgery & { command: string; gas: number; feeUqor: number };

export type ReplayAnswer = ReplayResult | Lookup | ForgeAnswer;

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
  const gas = challengeGas(f.proofHex.length / 2, f.entries);
  return {
    ...f,
    command: challengeCommand(session.env.rollupId, session.env.chainId, f.batchIndex, f.proofHex, f.entries),
    gas,
    feeUqor: Math.ceil(gas * CHALLENGE_GAS_PRICE),
  };
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
