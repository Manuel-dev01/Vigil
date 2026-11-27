/**
 * When the People's Choice notice shows, and what it says. The fest's rules page (read on 27 Nov 2026)
 * puts the community vote with QoreX on mainnet from 6 to 15 December 2026, UTC, so the notice follows
 * the viewer's clock in UTC:
 * - before 6 Dec 00:00 UTC it says voting opens on 6 Dec;
 * - from 6 Dec 00:00 to 15 Dec 23:59:59 UTC it says to vote, and links to Vigil's project page;
 * - from 16 Dec 00:00 UTC it is gone.
 * No dependencies, so the app shell carries it without the chain libraries.
 */

/** 6 Dec 2026, 00:00 UTC: the vote opens. */
export const VOTE_OPENS = Date.UTC(2026, 11, 6);
/** 16 Dec 2026, 00:00 UTC: the day after the last voting day, when the notice goes. */
export const VOTE_OVER = Date.UTC(2026, 11, 16);

/** Vigil's page on the fest site. */
export const PROJECT_PAGE = "https://build.qorechain.io/p/vigil";

export type VotePhase = "soon" | "open" | "over";

/** The notice's phase at `now` (milliseconds since the epoch, so the viewer's time zone plays no part). */
export function votePhase(now: number): VotePhase {
  if (now < VOTE_OPENS) return "soon";
  if (now < VOTE_OVER) return "open";
  return "over";
}

/** Milliseconds from `now` until the phase next changes, or undefined once the vote is over. */
export function untilNextPhase(now: number): number | undefined {
  if (now < VOTE_OPENS) return VOTE_OPENS - now;
  if (now < VOTE_OVER) return VOTE_OVER - now;
  return undefined;
}

export interface Notice {
  /** What the strip says. */
  text: string;
  /** Where the text links, if anywhere. */
  href?: string;
}

/** What the strip says in each phase; nothing once the vote is over. */
export function noticeFor(phase: VotePhase): Notice | undefined {
  if (phase === "soon") return { text: "Voting opens 6 Dec" };
  if (phase === "open") return { text: "Vote with QoreX on mainnet", href: PROJECT_PAGE };
  return undefined;
}
