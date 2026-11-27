/**
 * The how-to-vote card's words, kept as data so a test can hold them to a 60-second read. Every voting
 * fact here is from the fest's Rules and About pages on build.qorechain.io as read on 27 Nov 2026,
 * nearly word for word; nothing is added to them. Loaded only when someone opens the card.
 */
import { PROJECT_PAGE } from "./phase.ts";

export interface CardStep {
  /** A short label, like a chart sounding. */
  k: string;
  body: string;
  link?: { label: string; href: string };
}

export const CARD_TITLE = "People's Choice in 60 seconds";

export const CARD_LEDE = "The People's Choice award is decided by a community vote. This is how it works, from the fest's rules.";

export const CARD_STEPS: CardStep[] = [
  { k: "When", body: "From 6 to 15 December 2026, UTC." },
  { k: "Wallet", body: "QoreX on mainnet. The vote is on mainnet, not on the testnet Vigil runs on." },
  { k: "Votes", body: "Each eligible wallet has 3 votes, at most 1 per project." },
  { k: "Own project", body: "Team members cannot vote for their own project, so Vigil's team cannot vote for Vigil." },
  { k: "Vigil", body: "Vigil's project page on the fest site:", link: { label: "build.qorechain.io/p/vigil", href: PROJECT_PAGE } },
  {
    k: "Results",
    body: "Counts stay hidden until 16 December, when winners are announced at the live demo show. The full list of votes is published after the vote.",
  },
];

export const CARD_FINE_PRINT = [
  "The rules ban vote manipulation and multiple accounts for one person.",
  "From the fest's Rules page as read on 27 Nov 2026. The organiser may still change the rules and dates, and announces every change on the fest site.",
];

/** Every word the card shows, for the reading-time test. */
export function cardWords(): string[] {
  const text = [CARD_TITLE, CARD_LEDE, ...CARD_STEPS.flatMap((s) => [s.k, s.body, s.link?.label ?? ""]), ...CARD_FINE_PRINT].join(" ");
  return text.split(/\s+/).filter(Boolean);
}
