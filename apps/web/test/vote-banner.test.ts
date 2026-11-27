/** The notice and the card, rendered to markup with the clock set either side of each boundary (UTC). */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoteBanner } from "../src/vote/VoteBanner.tsx";
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
