/**
 * The page's side of the browser watchtower's Web Worker (worker.ts): one request at a time, each
 * answered by id. Types only from the core, so its code stays in the worker's own file.
 *
 * A worker that fails to load (a blocked or missing file), throws, or sends an answer the page cannot
 * read is marked failed: every pending request and every later one is refused at once, so the panel
 * shows the error instead of waiting for good. A request with no answer in time fails the worker too.
 */
import type { Lookup, ReplayInput, ReplayResult } from "./core.ts";
import type { ForgeAnswer, ReplayAnswer, ReplayRequest, ReplayResponse } from "./worker.ts";

type Pending = { resolve: (v: ReplayAnswer) => void; reject: (e: Error) => void };
type Ask = { kind: "run"; input: ReplayInput } | { kind: "lookup"; account: string } | { kind: "forge"; key: string; sequence: number; amount: string };

/** Generous limits: vigil-pay-1's whole history re-executes in a few seconds. */
export const TIMEOUT_MS = { run: 180_000, other: 60_000 };

/** The worker's file. A same-origin module (Vite emits it under assets/), so the site's CSP (worker-src falls back to script-src 'self') allows it. */
const startWorker = (): Worker => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "vigil-browser-watchtower" });

export class ReplayWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  /** The first failure; once set, the worker is not asked anything again. */
  private failed: Error | undefined;

  /** `start` and `timeouts` are for tests; the page uses the defaults. */
  constructor(start: () => Worker = startWorker, private readonly timeouts = TIMEOUT_MS) {
    this.worker = start();
    this.worker.addEventListener("message", (ev: MessageEvent<ReplayResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.value);
      else p.reject(new Error(ev.data.error));
    });
    this.worker.addEventListener("error", (ev: ErrorEvent) =>
      this.fail(new Error(ev.message ? `the re-execution worker stopped: ${ev.message}` : "the re-execution worker did not load or stopped")),
    );
    this.worker.addEventListener("messageerror", () => this.fail(new Error("the re-execution worker sent an answer this page could not read")));
  }

  private ask(req: Ask): Promise<ReplayAnswer> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.next++;
    const ms = req.kind === "run" ? this.timeouts.run : this.timeouts.other;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`the re-execution worker did not answer within ${Math.round(ms / 1000)} s`)), ms);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.worker.postMessage({ ...req, id } satisfies ReplayRequest);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private fail(e: Error): void {
    this.failed ??= e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.worker.terminate();
  }

  run(input: ReplayInput): Promise<ReplayResult> {
    return this.ask({ kind: "run", input }) as Promise<ReplayResult>;
  }

  lookup(account: string): Promise<Lookup> {
    return this.ask({ kind: "lookup", account }) as Promise<Lookup>;
  }

  forge(key: string, sequence: number, amount: bigint): Promise<ForgeAnswer> {
    return this.ask({ kind: "forge", key, sequence, amount: amount.toString() }) as Promise<ForgeAnswer>;
  }

  dispose(): void {
    this.fail(new Error("stopped"));
  }
}
