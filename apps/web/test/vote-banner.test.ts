/** The notice and the card: rendered to markup with the clock set either side of each boundary (UTC), and the
 * strip's live parts (the phase watch, the room it makes, the backdrop click, a card that fails to load). */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VotePhase } from "../src/vote/phase.ts";
import { CardMissing, RECHECK_MS, VoteBanner, cardOrNote, makeRoom, outside, watchVotePhase } from "../src/vote/VoteBanner.tsx";
import { VoteCard } from "../src/vote/VoteCard.tsx";

const at = (iso: string): string => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  return renderToStaticMarkup(createElement(VoteBanner));
};

/** A stand-in for the browser's storage, so a test can say what this viewer hid before. */
const storage = (hidden?: string) => {
  const m = new Map<string, string>(hidden ? [["vigil.vote-notice.hidden", hidden]] : []);
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
};

beforeEach(() => storage());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("VoteBanner", () => {
  it("5 Dec 23:59:59 UTC: voting opens 6 Dec, with the how-to-vote button and no vote link", () => {
    const html = at("2026-12-05T23:59:59Z");
    expect(html).toContain("Voting opens 6 Dec");
    expect(html).toContain("How to vote");
    expect(html).not.toContain("build.qorechain.io");
  });

  it("6 Dec 00:00:00 UTC: vote with QoreX on mainnet, linking to Vigil's project page in a new tab", () => {
    const html = at("2026-12-06T00:00:00Z");
    expect(html).toContain("Vote with QoreX on mainnet");
    expect(html).toContain('href="https://build.qorechain.io/p/vigil"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("Voting opens");
  });

  it("15 Dec 23:59:59 UTC: still open", () => {
    expect(at("2026-12-15T23:59:59Z")).toContain("Vote with QoreX on mainnet");
  });

  it("16 Dec 00:00:00 UTC: renders nothing", () => {
    expect(at("2026-12-16T00:00:00Z")).toBe("");
  });

  it("stays hidden for a viewer who hid it, until the phase changes", () => {
    storage("soon");
    expect(at("2026-12-05T23:59:59Z")).toBe("");
    expect(at("2026-12-06T00:00:00Z")).toContain("Vote with QoreX on mainnet");
    storage("open");
    expect(at("2026-12-05T23:59:59Z")).toContain("Voting opens 6 Dec");
    expect(at("2026-12-10T00:00:00Z")).toBe("");
  });

  it("shows when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(at("2026-12-01T12:00:00Z")).toContain("Voting opens 6 Dec");
  });

  it("names its controls for screen readers", () => {
    const html = at("2026-12-01T12:00:00Z");
    expect(html).toContain('aria-label="People&#x27;s Choice vote"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Hide the People&#x27;s Choice notice"');
    expect(html).toContain('aria-labelledby="vote-card-title"');
  });
});

describe("VoteCard", () => {
  it("has the title the dialog is labelled by, and the project page link", () => {
    const html = renderToStaticMarkup(createElement(VoteCard));
    expect(html).toContain('id="vote-card-title"');
    expect(html).toContain("People&#x27;s Choice in 60 seconds");
    expect(html).toContain('href="https://build.qorechain.io/p/vigil"');
    expect(html).toContain("3 votes, at most 1 per project");
  });
});

/** A stand-in for `document`'s visibility: a real EventTarget whose state a test can set. */
const page = (state: DocumentVisibilityState = "visible") => {
  const target = new EventTarget();
  const doc = {
    visibilityState: state,
    addEventListener: (type: "visibilitychange", fn: () => void) => target.addEventListener(type, fn),
    removeEventListener: (type: "visibilitychange", fn: () => void) => target.removeEventListener(type, fn),
    show(next: DocumentVisibilityState) {
      doc.visibilityState = next;
      target.dispatchEvent(new Event("visibilitychange"));
    },
  };
  return doc;
};

/** Starts a phase watch at `iso` (UTC) and records every phase it reports. */
const watchFrom = (iso: string, doc = page()) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  const seen: VotePhase[] = [];
  const stop = watchVotePhase((p) => seen.push(p), doc);
  return { seen, stop, doc, last: () => seen.at(-1) };
};

describe("watchVotePhase: a page left open", () => {
  it("changes from 'opens 6 Dec' to the vote at 6 Dec 00:00 UTC, then goes at 16 Dec 00:00 UTC and stops", () => {
    const w = watchFrom("2026-12-05T23:59:59Z");
    expect(w.seen).toEqual(["soon"]);
    vi.advanceTimersByTime(1000); // 6 Dec 00:00:00; the check lands 250 ms after the boundary
    expect(w.last()).toBe("soon");
    vi.advanceTimersByTime(250);
    expect(w.last()).toBe("open");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(Date.parse("2026-12-15T23:59:59Z") - Date.now());
    expect(w.last()).toBe("open");
    vi.advanceTimersByTime(1250); // 16 Dec 00:00:00.250
    expect(w.last()).toBe("over");
    expect(vi.getTimerCount()).toBe(0); // nothing left running after the vote
    w.stop();
  });

  it("checks at least hourly while the next phase is far off", () => {
    const w = watchFrom("2026-11-27T12:00:00Z");
    expect(w.seen).toHaveLength(1);
    vi.advanceTimersByTime(RECHECK_MS);
    expect(w.seen).toHaveLength(2);
    w.stop();
  });

  it("re-reads the clock when the tab becomes visible, as timers can sleep with the laptop", () => {
    const w = watchFrom("2026-12-05T20:00:00Z");
    vi.setSystemTime(new Date("2026-12-06T07:00:00Z")); // the clock moves on without any timer firing
    w.doc.show("hidden");
    expect(w.seen).toEqual(["soon"]);
    w.doc.show("visible");
    expect(w.seen).toEqual(["soon", "open"]);
    w.stop();
  });

  it("stops cleanly: no timer left and no more reports", () => {
    const w = watchFrom("2026-12-05T23:59:59Z");
    w.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    w.doc.show("visible");
    expect(w.seen).toEqual(["soon"]);
  });
});

describe("makeRoom", () => {
  /** Just enough of <html> to watch the class and the custom property. */
  const root = () => {
    const classes = new Set<string>();
    const props = new Map<string, string>();
    const el = {
      classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
      style: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) },
    };
    return { el: el as unknown as HTMLElement, classes, props };
  };

  it("marks the page with has-vote and the strip's height while it shows, and follows it as it wraps", () => {
    let resized: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(fn: () => void) {
          resized = fn;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    let height = 34.4;
    const strip = { getBoundingClientRect: () => ({ height }) } as unknown as HTMLElement;
    const r = root();
    const undo = makeRoom(r.el, strip);
    expect(r.classes.has("has-vote")).toBe(true);
    expect(r.props.get("--vote-h")).toBe("35px");
    height = 57;
    resized?.();
    expect(r.props.get("--vote-h")).toBe("57px");
    undo();
    expect(r.classes.has("has-vote")).toBe(false);
    expect(r.props.has("--vote-h")).toBe(false);
    expect(disconnect).toHaveBeenCalled();
  });

  it("does nothing while the strip is not shown", () => {
    const r = root();
    makeRoom(r.el, null)();
    expect(r.classes.size).toBe(0);
    expect(r.props.size).toBe(0);
  });
});

describe("the dialog's backdrop", () => {
  const box = { left: 100, right: 660, top: 24, bottom: 600 };

  it("counts only points outside the card's box, so its scrollbar and its inside never close it", () => {
    expect(outside(box, 50, 300)).toBe(true);
    expect(outside(box, 700, 300)).toBe(true);
    expect(outside(box, 300, 10)).toBe(true);
    expect(outside(box, 300, 650)).toBe(true);
    expect(outside(box, 655, 300)).toBe(false); // the scrollbar, on the card's right edge
    expect(outside(box, 300, 300)).toBe(false);
    expect(outside(box, 100, 24)).toBe(false);
  });
});

describe("cardOrNote", () => {
  it("gives the card when its code loads", async () => {
    const m = await cardOrNote(async () => ({ VoteCard }))();
    expect(m.default).toBe(VoteCard);
  });

  it("gives a note, not a throw, when the fetch fails (offline, or an old tab after a redeploy)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const m = await cardOrNote(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")))();
    expect(m.default).toBe(CardMissing);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const html = renderToStaticMarkup(createElement(m.default));
    expect(html).toContain('role="alert"');
    expect(html).toContain("The card did not load. Reload the page to try again");
    expect(html).toContain('href="https://build.qorechain.io/rules"');
  });
});
