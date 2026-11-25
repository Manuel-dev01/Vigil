/** Small pieces every view shares: check marks, explorer links, copyable hashes, UTC times, refresh loops. */
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { EXPLORER, utcFull, utcStamp } from "./config.ts";
import { onReconnect } from "./rpc.ts";

export type Tone = "ok" | "bad" | "skip" | "wait";
const MARKS: Record<Tone, [string, string]> = { ok: ["✓", "passed"], bad: ["✕", "failed"], skip: ["–", "not checked"], wait: ["○", "pending"] };

/** A check mark that screen readers announce: role="img" with a label (the default, or `label`). */
export function Mark({ tone, label }: { tone: Tone; label?: string }) {
  const [glyph, fallback] = MARKS[tone];
  return (
    <span className={`mark-${tone}`} role="img" aria-label={label ?? fallback}>
      {glyph}
    </span>
  );
}

/** A link to the explorer (or any other site), in a new tab. */
export function Ext({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
    </a>
  );
}

/** The explorer opens on mainnet for a first-time visitor, where testnet links show "not found". */
export function ExplorerHint() {
  return (
    <p className="note hint">
      Explorer links open <a href={EXPLORER} target="_blank" rel="noopener noreferrer">explore.qore.network</a> in a new tab. If one shows "not found",
      switch the explorer to <strong>Testnet</strong> (it remembers the choice). EVM transaction hashes do not resolve there, so they are shown to copy.
    </p>
  );
}

/** An EVM hash (or any long value) shown short, with a button that copies the whole of it. */
export function CopyHash({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <span className="copy">
      {label} <code title={value}>{value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value}</code>
      <button type="button" className="copy-btn" onClick={copy} aria-label={`Copy ${label} ${value}`}>
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

/** A time (milliseconds) as "24 Nov, 21:05:37 UTC", with the full date on hover. */
export function When({ ms, className }: { ms: number; className?: string }) {
  return (
    <time className={className} dateTime={new Date(ms).toISOString()} title={utcFull(ms)}>
      {utcStamp(ms)}
    </time>
  );
}

/**
 * Run `load` now, every `everyMs` while the tab is visible, when the tab becomes visible after a
 * while, after the websocket reconnects, and whenever `trigger` is called. One load at a time: a
 * request that arrives meanwhile runs once the current one ends.
 */
export function useRefresh<T>(load: () => Promise<T>, everyMs: number): { data: T | undefined; error: string | undefined; refreshing: boolean; refresh: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const lastLoad = useRef(0);
  const alive = useRef(false);
  const refresh = useMemo(() => {
    let running = false;
    let again = false;
    const run = (): void => {
      if (!alive.current) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      setRefreshing(true);
      loadRef
        .current()
        .then((d) => {
          if (!alive.current) return;
          setData(d);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (alive.current) setError(String(e instanceof Error ? e.message : e));
        })
        .finally(() => {
          lastLoad.current = Date.now();
          running = false;
          if (alive.current) setRefreshing(false);
          if (again) {
            again = false;
            run();
          }
        });
    };
    return run;
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    const visible = () => document.visibilityState === "visible";
    const poll = setInterval(() => {
      if (visible()) refresh();
    }, everyMs);
    const onVisibility = () => {
      if (visible() && Date.now() - lastLoad.current > everyMs) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const offReconnect = onReconnect(refresh);
    return () => {
      alive.current = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      offReconnect();
    };
  }, [refresh, everyMs]);

  return { data, error, refreshing, refresh };
}

/** Catches a render error in the views, so one broken answer cannot blank the whole page. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | undefined; key: string }> {
  override state = { error: undefined as Error | undefined, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | undefined; key: string }) {
    // Moving to another page clears the error.
    return props.resetKey !== state.key ? { error: undefined, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn("view error", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="err" role="alert">
        <p>
          <strong>This part of the page hit an error and stopped:</strong> {this.state.error.message}
        </p>
        <p>
          <button type="button" onClick={() => this.setState({ error: undefined })}>
            Try again
          </button>{" "}
          or reload the page.
        </p>
      </div>
    );
  }
}

/** An element's width in CSS pixels, kept current as it resizes: `const [ref, width] = useWidth()`. */
export function useWidth<E extends HTMLElement = HTMLDivElement>(): [(el: E | null) => void, number] {
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver>(undefined);
  const ref = useMemo(
    () => (el: E | null) => {
      ro.current?.disconnect();
      if (!el) return;
      setWidth(Math.round(el.getBoundingClientRect().width));
      ro.current = new ResizeObserver((es) => {
        const w = es[0]?.contentRect.width;
        if (w !== undefined) setWidth(Math.round(w));
      });
      ro.current.observe(el);
    },
    [],
  );
  useEffect(() => () => ro.current?.disconnect(), []);
  return [ref, width];
}
