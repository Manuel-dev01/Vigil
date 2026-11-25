/**
 * The head every app page shares, laid out as a chart and its legend: the words on the left (an eyebrow
 * in mono, the title in Bodoni, the lede), and soundings on the right: what the page has just read from
 * the chain, in mono, each with a short note. A sounding with no value yet shows a placeholder bar, so the
 * page holds its shape while the chain answers.
 */
import type { ReactNode } from "react";
import { reveal } from "../reveal.ts";

export interface Sounding {
  k: string;
  /** Undefined while it is being read. */
  v: ReactNode | undefined;
  s?: ReactNode;
  /** Flash when the value changes (the chain height). */
  live?: boolean;
  tone?: "ok" | "bad" | "warn";
}

export function PageHead({ eyebrow, title, lede, soundings, label }: { eyebrow: ReactNode; title: ReactNode; lede: ReactNode; soundings?: Sounding[]; label?: string }) {
  return (
    <header className="ph">
      <div className="ph-copy">
        <p className="eyebrow ph-rise" style={{ animationDelay: "40ms" }}>
          {eyebrow}
        </p>
        <h1 className="ph-title ph-rise" style={{ animationDelay: "110ms" }}>
          {title}
        </h1>
        <div className="ph-lede ph-rise" style={{ animationDelay: "220ms" }}>
          {lede}
        </div>
      </div>
      {soundings && <Soundings items={soundings} label={label ?? "Read from the chain"} />}
    </header>
  );
}

export function Soundings({ items, label }: { items: Sounding[]; label: string }) {
  return (
    <aside className="ph-sound ph-rise" style={{ animationDelay: "300ms" }} aria-label={label}>
      <dl>
        {items.map((it) => (
          <div key={it.k} className={it.tone ? `tone-${it.tone}` : undefined}>
            <dt>{it.k}</dt>
            <dd>
              {it.v === undefined ? (
                <span className="skel" aria-label="reading" />
              ) : it.live ? (
                <span className="tick" key={String(it.v)}>
                  {it.v}
                </span>
              ) : (
                it.v
              )}
            </dd>
            {it.s && <p className="ph-s">{it.s}</p>}
          </div>
        ))}
      </dl>
    </aside>
  );
}

/** A section of a page: a hairline rule, a Bodoni heading with a mono aside, then the content. Revealed as it scrolls in. */
export function Section({ title, aside, children, className, id, live }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; id?: string; live?: boolean }) {
  return (
    <section className={className ? `sec ${className}` : "sec"} ref={reveal} id={id} aria-live={live ? "polite" : undefined}>
      <h2 className="sec-h">
        <span>{title}</span>
        {aside && <small>{aside}</small>}
      </h2>
      {children}
    </section>
  );
}

/** What a page shows while the chain answers: a line in mono with a lamp sweeping under it. */
export function Reading({ children }: { children: ReactNode }) {
  return (
    <p className="reading" role="status">
      <span>{children}</span>
    </p>
  );
}
