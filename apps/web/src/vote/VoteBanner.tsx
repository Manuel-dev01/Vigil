/**
 * The People's Choice notice: a slim strip at the top of every page, driven by the viewer's clock in UTC
 * (phase.ts), with a "How to vote" card in a dialog. The card's words load only when it is opened. A
 * viewer can hide the strip; it comes back when the phase changes. Gone from 16 Dec 2026, 00:00 UTC.
 */
import { Suspense, lazy, useEffect, useRef, useState, type ComponentType, type MouseEvent } from "react";
import { ErrorBoundary } from "../ui.tsx";
import { RULES_PAGE, noticeFor, untilNextPhase, votePhase, type VotePhase } from "./phase.ts";
import "./vote.css";

/** Shown in the dialog when the card's code cannot be fetched: offline, or a tab left open across a redeploy. */
export function CardMissing() {
  return (
    <div className="vote-body" role="alert">
      <p className="vote-lede">
        The card did not load. Reload the page to try again, or read the vote rules on the fest's{" "}
        <a href={RULES_PAGE} target="_blank" rel="noopener noreferrer">
          Rules page
          <span aria-hidden="true"> ↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </p>
    </div>
  );
}

/**
 * The lazy card's loader. A failed fetch gives the note above instead of throwing: the strip sits in the
 * header, outside the page's error boundary, and a throw there would blank the whole page. React keeps
 * whatever this gives, so only a reload tries the fetch again.
 */
export function cardOrNote(load: () => Promise<{ VoteCard: ComponentType }>): () => Promise<{ default: ComponentType }> {
  return () =>
    load().then(
      (m) => ({ default: m.VoteCard }),
      (e: unknown) => {
        console.warn("vote card did not load", e);
        return { default: CardMissing };
      },
    );
}

const loadCard = () => import("./VoteCard.tsx");
const VoteCard = lazy(cardOrNote(loadCard));
const preload = () => void loadCard().catch(() => undefined);

// Hiding is a per-browser convenience. Storage can be missing or blocked; then the strip simply shows.
const HIDE_KEY = "vigil.vote-notice.hidden";
const readHidden = (): string | null => {
  try {
    return localStorage.getItem(HIDE_KEY);
  } catch {
    return null;
  }
};
const writeHidden = (phase: VotePhase): void => {
  try {
    localStorage.setItem(HIDE_KEY, phase);
  } catch {
    // Hidden for this visit only.
  }
};

/** Checked again at most an hour apart, so a page left open across a boundary changes within the hour or sooner. */
export const RECHECK_MS = 3_600_000;

/** The part of `document` the phase watch needs, so a test can stand in for it. */
export interface Visibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `onPhase` with the phase now, then again when the next phase is due (and at least hourly until
 * then) and whenever the tab becomes visible, since timers can sleep with the laptop. Nothing is left
 * running once the vote is over. Returns a function that stops the watch.
 */
export function watchVotePhase(onPhase: (phase: VotePhase) => void, doc: Visibility = document): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    clearTimeout(timer);
    const now = Date.now();
    onPhase(votePhase(now));
    const wait = untilNextPhase(now);
    timer = wait === undefined ? undefined : setTimeout(check, Math.min(wait + 250, RECHECK_MS));
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") check();
  };
  check();
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}

/** The phase now, kept current by watchVotePhase. */
export function useVotePhase(): VotePhase {
  const [phase, setPhase] = useState<VotePhase>(() => votePhase(Date.now()));
  useEffect(() => watchVotePhase(setPhase), []);
  return phase;
}

/**
 * While the strip shows, marks the page with `has-vote` and the strip's height in `--vote-h`, kept current
 * as the strip wraps or unwraps, so the landing hero under the fixed header leaves room for it. Returns a
 * function that takes both off again.
 */
export function makeRoom(root: HTMLElement, strip: HTMLElement | null): () => void {
  if (!strip) return () => undefined;
  const measure = () => root.style.setProperty("--vote-h", `${Math.ceil(strip.getBoundingClientRect().height)}px`);
  root.classList.add("has-vote");
  measure();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
  ro?.observe(strip);
  return () => {
    ro?.disconnect();
    root.classList.remove("has-vote");
    root.style.removeProperty("--vote-h");
  };
}

/** Whether a point lies outside a box: a click there is on the dialog's backdrop, not on the card or its scrollbar. */
export function outside(box: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

/** A press on the backdrop itself: on the dialog element, and outside its box. */
const onBackdrop = (e: MouseEvent<HTMLDialogElement>): boolean =>
  e.target === e.currentTarget && outside(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);

export function VoteBanner() {
  const phase = useVotePhase();
  const [hidden, setHidden] = useState<string | null>(readHidden);
  const [cardLoaded, setCardLoaded] = useState(false);
  const strip = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const notice = noticeFor(phase);
  const shown = notice !== undefined && hidden !== phase;

  // The strip is only in the page while `shown`, so the ref is set exactly then.
  useEffect(() => makeRoom(document.documentElement, strip.current), [shown]);

  if (!notice || !shown) return null;

  const open = () => {
    setCardLoaded(true);
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  };
  const close = () => dialog.current?.close();

  return (
    <section ref={strip} className="vote-strip" aria-label="People's Choice vote">
      <div className="vote-in">
        <p className="vote-msg">
          <span className="vote-lamp" aria-hidden="true" />
          <span className="vote-tag">People's Choice</span>
          {notice.href ? (
            <a className="vote-go" href={notice.href} target="_blank" rel="noopener noreferrer">
              {notice.text}
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> on Vigil's project page (opens in a new tab)</span>
            </a>
          ) : (
            <span className="vote-text">{notice.text}</span>
          )}
        </p>
        <button
          type="button"
          className="link vote-how"
          aria-haspopup="dialog"
          aria-controls="vote-card"
          onClick={open}
          onPointerEnter={preload}
          onFocus={preload}
        >
          How to vote
        </button>
        <button
          type="button"
          className="vote-x"
          aria-label="Hide the People's Choice notice"
          title="Hide"
          onClick={() => {
            writeHidden(phase);
            setHidden(phase);
            // The button goes with the strip: keep keyboard focus in the header rather than losing it.
            document.querySelector<HTMLElement>(".top .brand")?.focus();
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {/*
        The dialog closes on a click that both starts and ends on the backdrop, so dragging its scrollbar or
        ending a text selection out there leaves it open. The title is named by aria-labelledby once the card
        has loaded; aria-label covers the moment before.
      */}
      <dialog
        ref={dialog}
        id="vote-card"
        className="vote-card"
        aria-labelledby="vote-card-title"
        aria-label="How to vote for People's Choice"
        data-lenis-prevent=""
        onPointerDown={(e) => {
          pressedOutside.current = onBackdrop(e);
        }}
        onClick={(e) => {
          if (pressedOutside.current && onBackdrop(e)) close();
          pressedOutside.current = false;
        }}
      >
        <div className="vote-card-in">
          <button type="button" className="vote-close" onClick={close}>
            Close
          </button>
          {cardLoaded && (
            <ErrorBoundary resetKey={phase}>
              <Suspense fallback={<p className="empty">Loading…</p>}>
                <VoteCard />
              </Suspense>
            </ErrorBoundary>
          )}
        </div>
      </dialog>
    </section>
  );
}
