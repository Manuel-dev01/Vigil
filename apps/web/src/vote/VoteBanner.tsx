/**
 * The People's Choice notice: a slim strip at the top of every page, driven by the viewer's clock in UTC
 * (phase.ts), with a "How to vote" card in a dialog. The card's words load only when it is opened. A
 * viewer can hide the strip; it comes back when the phase changes. Gone from 16 Dec 2026, 00:00 UTC.
 */
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { noticeFor, untilNextPhase, votePhase, type VotePhase } from "./phase.ts";
import "./vote.css";

const loadCard = () => import("./VoteCard.tsx");
const VoteCard = lazy(() => loadCard().then((m) => ({ default: m.VoteCard })));
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
const RECHECK_MS = 3_600_000;

/** The phase now, kept current: re-read when the next phase is due and whenever the tab becomes visible. */
export function useVotePhase(): VotePhase {
  const [phase, setPhase] = useState<VotePhase>(() => votePhase(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const now = Date.now();
      setPhase(votePhase(now));
      const wait = untilNextPhase(now);
      if (wait !== undefined) timer = setTimeout(check, Math.min(wait + 250, RECHECK_MS));
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return phase;
}

export function VoteBanner() {
  const phase = useVotePhase();
  const [hidden, setHidden] = useState<string | null>(readHidden);
  const [cardLoaded, setCardLoaded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const notice = noticeFor(phase);
  const shown = notice !== undefined && hidden !== phase;

  // The landing page's hero sits under a fixed header; this lets it leave room for the strip.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("has-vote", shown);
    return () => root.classList.remove("has-vote");
  }, [shown]);

  if (!notice || !shown) return null;

  const open = () => {
    setCardLoaded(true);
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  };
  const close = () => dialog.current?.close();

  return (
    <section className="vote-strip" aria-label="People's Choice vote">
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
        A click on the backdrop lands on the dialog itself (its box has no padding of its own) and closes it.
        The title is named by aria-labelledby once the card has loaded; aria-label covers the moment before.
      */}
      <dialog
        ref={dialog}
        id="vote-card"
        className="vote-card"
        aria-labelledby="vote-card-title"
        aria-label="How to vote for People's Choice"
        data-lenis-prevent=""
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="vote-card-in">
          <button type="button" className="vote-close" onClick={close}>
            Close
          </button>
          {cardLoaded && (
            <Suspense fallback={<p className="empty">Loading…</p>}>
              <VoteCard />
            </Suspense>
          )}
        </div>
      </dialog>
    </section>
  );
}
