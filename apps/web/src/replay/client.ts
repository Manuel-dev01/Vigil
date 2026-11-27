/**
 * The page's side of the browser watchtower's Web Worker (worker.ts): one request at a time, each
 * answered by id. Types only from the core, so its code stays in the worker's own file.
 */
import type { Forgery, Lookup, ReplayInput, ReplayResult } from "./core.ts";
import type { ReplayAnswer, ReplayRequest, ReplayResponse } from "./worker.ts";

type Pending = { resolve: (v: ReplayAnswer) => void; reject: (e: Error) => void };
type Ask = { kind: "run"; input: ReplayInput } | { kind: "lookup"; account: string } | { kind: "forge"; key: string; sequence: number; amount: string };

export class ReplayWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 1;

  constructor() {
    // A same-origin module file (Vite emits it under assets/), so the site's CSP (worker-src falls back
    // to script-src 'self') allows it.
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "vigil-browser-watchtower" });
    this.worker.addEventListener("message", (ev: MessageEvent<ReplayResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.value);
      else p.reject(new Error(ev.data.error));
    });
    this.worker.addEventListener("error", (ev) => this.failAll(new Error(ev.message || "the re-execution worker stopped")));
  }

  private ask(req: Ask): Promise<ReplayAnswer> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id } satisfies ReplayRequest);
    });
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  run(input: ReplayInput): Promise<ReplayResult> {
    return this.ask({ kind: "run", input }) as Promise<ReplayResult>;
  }

  lookup(account: string): Promise<Lookup> {
    return this.ask({ kind: "lookup", account }) as Promise<Lookup>;
  }

  forge(key: string, sequence: number, amount: bigint): Promise<Forgery & { command: string }> {
    return this.ask({ kind: "forge", key, sequence, amount: amount.toString() }) as Promise<Forgery & { command: string }>;
  }

  dispose(): void {
    this.failAll(new Error("stopped"));
    this.worker.terminate();
  }
}
