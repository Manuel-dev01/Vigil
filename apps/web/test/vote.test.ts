/** The People's Choice notice follows the clock in UTC: "opens 6 Dec" before, "vote" from 6 to 15 Dec, gone from 16 Dec. */
import { describe, expect, it } from "vitest";
import { CARD_FINE_PRINT, CARD_LEDE, CARD_STEPS, cardWords } from "../src/vote/card.ts";
import { PROJECT_PAGE, VOTE_OPENS, VOTE_OVER, noticeFor, untilNextPhase, votePhase } from "../src/vote/phase.ts";

const utc = (iso: string): number => Date.parse(iso);

describe("votePhase", () => {
  it("pins the boundaries to 6 Dec and 16 Dec 2026, 00:00 UTC", () => {
    expect(new Date(VOTE_OPENS).toISOString()).toBe("2026-12-06T00:00:00.000Z");
    expect(new Date(VOTE_OVER).toISOString()).toBe("2026-12-16T00:00:00.000Z");
  });

  it("says voting opens 6 Dec until 5 Dec 23:59:59 UTC", () => {
    expect(votePhase(utc("2026-11-27T12:00:00Z"))).toBe("soon");
    expect(votePhase(utc("2026-12-02T23:59:59Z"))).toBe("soon");
    expect(votePhase(utc("2026-12-05T23:59:59Z"))).toBe("soon");
    expect(votePhase(utc("2026-12-05T23:59:59.999Z"))).toBe("soon");
  });

  it("says vote from 6 Dec 00:00:00 UTC through 15 Dec 23:59:59 UTC", () => {
    expect(votePhase(utc("2026-12-06T00:00:00Z"))).toBe("open");
    expect(votePhase(utc("2026-12-10T12:00:00Z"))).toBe("open");
    expect(votePhase(utc("2026-12-15T23:59:59Z"))).toBe("open");
    expect(votePhase(utc("2026-12-15T23:59:59.999Z"))).toBe("open");
  });

  it("is gone from 16 Dec 00:00:00 UTC", () => {
    expect(votePhase(utc("2026-12-16T00:00:00Z"))).toBe("over");
    expect(votePhase(utc("2026-12-16T12:00:00Z"))).toBe("over");
    expect(votePhase(utc("2027-06-01T00:00:00Z"))).toBe("over");
  });

  it("goes by the instant, not the viewer's time zone", () => {
    // Near a boundary the local date and the UTC date differ; only the UTC instant counts.
    expect(votePhase(utc("2026-12-05T19:00:00-05:00"))).toBe("open"); // 6 Dec 00:00 UTC
    expect(votePhase(utc("2026-12-06T00:59:59+01:00"))).toBe("soon"); // 5 Dec 23:59:59 UTC
    expect(votePhase(utc("2026-12-16T08:59:59+09:00"))).toBe("open"); // 15 Dec 23:59:59 UTC
    expect(votePhase(utc("2026-12-15T19:00:00-05:00"))).toBe("over"); // 16 Dec 00:00 UTC
  });
});

describe("untilNextPhase", () => {
  it("counts down to the next boundary and stops after the vote", () => {
    expect(untilNextPhase(utc("2026-12-05T23:59:59Z"))).toBe(1000);
    expect(untilNextPhase(utc("2026-12-06T00:00:00Z"))).toBe(10 * 86_400_000);
    expect(untilNextPhase(utc("2026-12-15T23:59:59Z"))).toBe(1000);
    expect(untilNextPhase(utc("2026-12-16T00:00:00Z"))).toBeUndefined();
  });
});

describe("noticeFor", () => {
  it("before 6 Dec: voting opens 6 Dec, no link", () => {
    expect(noticeFor(votePhase(utc("2026-12-05T23:59:59Z")))).toEqual({ text: "Voting opens 6 Dec" });
  });

  it("6 to 15 Dec: vote with QoreX on mainnet, linking to Vigil's project page", () => {
    expect(noticeFor(votePhase(utc("2026-12-06T00:00:00Z")))).toEqual({ text: "Vote with QoreX on mainnet", href: "https://build.qorechain.io/p/vigil" });
    expect(noticeFor(votePhase(utc("2026-12-15T23:59:59Z")))?.href).toBe(PROJECT_PAGE);
  });

  it("from 16 Dec: nothing", () => {
    expect(noticeFor(votePhase(utc("2026-12-16T00:00:00Z")))).toBeUndefined();
  });
});

describe("how-to-vote card", () => {
  it("reads in under a minute (at most 180 words)", () => {
    expect(cardWords().length).toBeLessThanOrEqual(180);
  });

  it("states the rules' vote facts and nothing about stakes, balances or rewards", () => {
    const text = [CARD_LEDE, ...CARD_STEPS.map((s) => s.body), ...CARD_FINE_PRINT].join(" ");
    expect(text).toContain("6 to 15 December");
    expect(text).toContain("QoreX on mainnet");
    expect(text).toContain("3 votes, at most 1 per project");
    expect(text).toContain("cannot vote for their own project");
    expect(text).toContain("Counts stay hidden until 16 December");
    // The rules name no minimum balance, and we offer nothing for a vote.
    expect(text).not.toMatch(/\d+\s*QOR\b|reward|airdrop|giveaway|in return/i);
  });
});
