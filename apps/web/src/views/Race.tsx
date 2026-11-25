/**
 * The Instant exits page's instrument: one real exit, on one time axis that starts when the user withdrew
 * on L2. Three lanes:
 *   - you, with the vault: withdrawn, signed by the quorum, paid (seconds later);
 *   - the vault: out of pocket from that payment until the withdrawal itself repays it, via sweep();
 *   - without the vault: the withdrawal waits out the challenge window, until its batch could be final.
 * Every mark is a time the page read from the chain (the inbox, the vault's logs, the batch record). The
 * lanes draw as the figure scrolls in: the first in a blink, the other two at the pace of the window.
 */
import { useMemo, type ReactNode } from "react";
import { dur, qor, stamp } from "../config.ts";
import type { ExitView } from "../exits.ts";
import { reveal } from "../reveal.ts";
import { useWidth } from "../ui.tsx";

export interface RaceTimes {
  withdrew: number;
  signed: number | undefined;
  paid: number;
  repaid: number | undefined;
  finalFrom: number;
}

/** The times the race needs, if this exit has them all (unix seconds). */
export function raceTimes(x: ExitView, threshold: number): RaceTimes | undefined {
  const withdrew = x.withdrawal?.entry.time;
  const paid = x.fronted?.time;
  const finalFrom = x.batch?.finalFrom;
  if (!withdrew || !paid || !finalFrom || x.error) return undefined;
  const counted = x.attestations.filter((a) => a.sameClaim && a.local === true && a.pqc.valid !== false);
  return { withdrew, signed: counted[threshold - 1]?.entry.time, paid, repaid: x.repayment?.completedBy?.time, finalFrom };
}

const STEPS = [30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600];

export function Race({ x, t, title, nowSec }: { x: ExitView | undefined; t: RaceTimes | undefined; title: ReactNode; nowSec: number }) {
  const [ref, width] = useWidth<HTMLElement>();
  // One stable ref for both jobs, so React does not detach and re-attach it on every render.
  const figRef = useMemo(
    () => (el: HTMLElement | null) => {
      ref(el);
      reveal(el);
    },
    [ref],
  );
  const phone = width > 0 && width < 640;
  const L = phone ? 0 : 168;
  const R = phone ? 8 : 20;
  const laneGap = phone ? 78 : 56;
  const y = (i: number) => (phone ? 46 : 34) + i * laneGap;
  // A lane's note sits above its line on wide screens; on phones the lane's name is there, so the note goes below.
  const noteY = (i: number) => (phone ? y(i) + 21 : y(i) - 12);
  const axisY = y(2) + (phone ? 40 : 36);
  const H = axisY + 26;

  // The axis runs to the later of finality and the repayment; while a repayment is pending, on to now (at most
  // one more window).
  const end = !t ? 3600 : t.repaid ? Math.max(t.finalFrom, t.repaid) : Math.max(t.finalFrom, Math.min(nowSec, t.finalFrom + (t.finalFrom - t.withdrew)));
  const t0 = t?.withdrew ?? 0;
  const span = Math.max(1, (end - t0) * 1.03);
  const X = (s: number) => L + ((s - t0) / span) * Math.max(1, width - L - R);
  const step = STEPS.find((s) => span / s <= (phone ? 4 : 6)) ?? 86400;
  const ticks = Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step);

  const ahead = t ? t.finalFrom - t.paid : 0;
  const repaidX = t?.repaid ? X(t.repaid) : t ? X(Math.min(nowSec, end)) : 0;
  const lanes = ["You, with the vault", "The vault", "Without the vault"];

  return (
    <figure className="inst race" ref={figRef}>
      <figcaption className="inst-cap">
        <span>{title}</span>
        {x && x.fronted && <span>{qor(x.claim?.amountUqor ?? "0")} · exit {x.id.slice(0, 8)}…</span>}
      </figcaption>
      {t && ahead > 0 && (
        <p className="race-big">
          Paid <em>{dur(ahead)}</em> before its batch could be final.
        </p>
      )}
      {!t && <p className="race-big ghost">The latest fronted exit, read from the chain…</p>}
      <div className="race-wrap" style={{ height: H }}>
        {width > 0 && (
          <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true" className={t ? "race-svg" : "race-svg loading"}>
            {lanes.map((name, i) => (
              <g key={name}>
                <text className="rc-lane" x={0} y={phone ? y(i) - 16 : y(i) + 4}>
                  {name}
                </text>
                <line className="rc-track" x1={L} x2={width - R} y1={y(i)} y2={y(i)} />
              </g>
            ))}
            {/* The time axis */}
            <line className="rc-axis" x1={L} x2={width - R} y1={axisY - 10} y2={axisY - 10} />
            {t &&
              ticks.map((s) => (
                <g key={s}>
                  <line className="rc-tick" x1={X(t0 + s)} x2={X(t0 + s)} y1={axisY - 14} y2={axisY - 6} />
                  <text className="rc-t" x={X(t0 + s)} y={axisY + 8}>
                    {s === 0 ? "withdrawn" : `+${dur(s)}`}
                  </text>
                </g>
              ))}
            {t && (
              <>
                {/* Lane 1: paid at once */}
                <g className="rc-l1 anim">
                  <line className="rc-run lamp" x1={X(t0)} x2={Math.max(X(t.paid), X(t0) + 2)} y1={y(0)} y2={y(0)} />
                  <circle className="rc-dot ink" cx={X(t0)} cy={y(0)} r={3.5} />
                  {t.signed && <circle className="rc-dot lamp small" cx={X(t.signed)} cy={y(0)} r={3} />}
                  <circle className="rc-glow" cx={X(t.paid)} cy={y(0)} r={18} />
                  <circle className="rc-dot lamp big" cx={X(t.paid)} cy={y(0)} r={6} />
                  <text className="rc-say lamp" x={X(t.paid) + 14} y={noteY(0)}>
                    paid at +{dur(t.paid - t0)}
                    {t.signed ? ` · quorum signed at +${dur(t.signed - t0)}` : ""}
                  </text>
                </g>
                {/* Lane 2: the vault waits instead */}
                <g className="rc-l2 anim" style={{ ["--dx" as string]: `${repaidX - X(t.paid)}px` }}>
                  <line className="rc-run vault" x1={X(t.paid)} x2={repaidX} y1={y(1)} y2={y(1)} />
                  <circle className="rc-dot lamp small" cx={X(t.paid)} cy={y(1)} r={3} />
                  {t.repaid ? (
                    <>
                      <circle className="rc-dot lamp end" cx={repaidX} cy={y(1)} r={5} />
                      <text className="rc-say end" x={repaidX - 12} y={noteY(1)}>
                        repaid by the withdrawal itself, +{dur(t.repaid - t0)}
                      </text>
                    </>
                  ) : (
                    <text className="rc-say end" x={repaidX - 12} y={noteY(1)}>
                      repayment pending
                    </text>
                  )}
                </g>
                {/* Lane 3: waiting out the window */}
                <g className="rc-l3 anim" style={{ ["--dx" as string]: `${X(t.finalFrom) - X(t0)}px` }}>
                  <line className="rc-run wait" x1={X(t0)} x2={X(t.finalFrom)} y1={y(2)} y2={y(2)} />
                  <circle className="rc-dot ink" cx={X(t0)} cy={y(2)} r={3.5} />
                  <circle className="rc-crawl" cx={X(t0)} cy={y(2)} r={4} />
                  <circle className="rc-dot ink end" cx={X(t.finalFrom)} cy={y(2)} r={5} />
                  <text className="rc-say end ink" x={X(t.finalFrom) - 12} y={noteY(2)}>
                    could be final at the earliest, +{dur(t.finalFrom - t0)}
                  </text>
                </g>
              </>
            )}
          </svg>
        )}
      </div>
      {t && (
        <p className="race-foot">
          Withdrawn {stamp(t.withdrew)} · paid by the vault {stamp(t.paid)} · batch could be final from {stamp(t.finalFrom)}
          {t.repaid ? ` · vault repaid ${stamp(t.repaid)}` : ""}
        </p>
      )}
    </figure>
  );
}
