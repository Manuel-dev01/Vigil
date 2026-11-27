/** The how-to-vote card, shown in the notice's dialog. Loaded only when someone opens it. */
import { CARD_FINE_PRINT, CARD_LEDE, CARD_STEPS, CARD_TITLE } from "./card.ts";

export function VoteCard() {
  return (
    <div className="vote-body">
      <p className="vote-eyebrow">People's Choice · Build Before Q-Day</p>
      <h2 id="vote-card-title" className="vote-title">
        {CARD_TITLE}
      </h2>
      <p className="vote-lede">{CARD_LEDE}</p>
      <ol className="vote-steps">
        {CARD_STEPS.map((s) => (
          <li key={s.k}>
            <span className="vote-k">{s.k}</span>
            <span className="vote-v">
              {s.body}
              {s.link && (
                <>
                  {" "}
                  <a href={s.link.href} target="_blank" rel="noopener noreferrer">
                    {s.link.label}
                    <span aria-hidden="true"> ↗</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
      <div className="vote-fine">
        {CARD_FINE_PRINT.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </div>
    </div>
  );
}
