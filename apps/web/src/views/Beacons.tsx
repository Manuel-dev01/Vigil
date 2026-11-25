/**
 * The Rollup page's instrument: every batch of the rollup as a beacon on one line, oldest on the left.
 * A lit lamp is a batch anchored with the creator's ML-DSA-87 signature; a hollow one has no anchor (it
 * came from the standby sequencer or another bonded submitter). A batch still in its challenge window carries a ring that closes as the window
 * runs out. Where a fraud proof was upheld, a port-red mark sinks below the line beside the index the
 * forged batch held. Pointing at a beacon shows the batch; clicking a lit one opens its receipt.
 *
 * Drawn from the same rows as the batch table below it, which stays the accessible record: the drawing is
 * hidden from screen readers, which get a one-line summary instead.
 */
import { useMemo, useState } from "react";
import { qor, short, utcStamp } from "../config.ts";
import { useWidth } from "../ui.tsx";

export interface BeaconRow {
  batchIndex: number;
  status: string;
  anchored: boolean;
  block: number;
  stateRoot: string;
  /** Unix seconds the batch was submitted, when the chain still keeps its record. */
  submittedTime?: number | undefined;
}

export interface BeaconFraud {
  batchIndex: number;
  height: number;
  time: string;
  submitter: string;
  slashed: string;
  reward: string;
}

const H_DESK = 214;
const H_PHONE = 184;

export function BeaconLine({
  rows,
  frauds,
  windowSec,
  now,
  nameOf,
}: {
  rows: BeaconRow[] | undefined;
  frauds: BeaconFraud[] | undefined;
  windowSec: number | undefined;
  now: number;
  nameOf: (addr: string) => string;
}) {
  const [ref, width] = useWidth<HTMLElement>();
  const [hover, setHover] = useState<number>();
  const phone = width > 0 && width < 640;
  const H = phone ? H_PHONE : H_DESK;
  const base = H - 62;
  const postH = phone ? 66 : 88;

  // One beacon per index, newest record winning; indices the page did not read are left as gaps.
  const byIndex = useMemo(() => {
    const m = new Map<number, BeaconRow>();
    for (const r of [...(rows ?? [])].sort((a, b) => a.block - b.block)) m.set(r.batchIndex, r);
    return m;
  }, [rows]);
  const latest = Math.max(-1, ...byIndex.keys());
  const n = latest + 1;
  const slots = n + 1; // and one for the next batch
  const padL = 6;
  const slot = width ? Math.min(phone ? 30 : 54, (width - padL * 2) / Math.max(slots, 1)) : 0;
  const x = (i: number) => padL + slot * (i + 0.5);
  const r = Math.max(2.6, Math.min(5, slot * 0.2));
  const every = slot >= 24 ? 1 : slot >= 13 ? 5 : 10;

  const fraudAt = useMemo(() => {
    const m = new Map<number, BeaconFraud[]>();
    for (const f of frauds ?? []) m.set(f.batchIndex, [...(m.get(f.batchIndex) ?? []), f]);
    return m;
  }, [frauds]);

  const anchoredCount = [...byIndex.values()].filter((b) => b.anchored).length;
  const unanchored = [...byIndex.values()].filter((b) => !b.anchored).map((b) => b.batchIndex);
  const summary = rows
    ? `${n} batches. ${anchoredCount} anchored with ML-DSA-87${unanchored.length ? `; no anchor on batch ${unanchored.join(", ")}` : ""}.${frauds?.length ? ` Fraud proofs upheld against forged batches at index ${[...new Set(frauds.map((f) => f.batchIndex))].join(" and ")}; each index was then reused by a later batch.` : ""}`
    : "Reading the batches.";

  const hovered = hover !== undefined ? byIndex.get(hover) : undefined;
  const hoveredFraud = hover !== undefined ? fraudAt.get(hover) : undefined;
  // The batch under the pointer, from the event itself (a click must not use a hover from an earlier render).
  const at = (e: React.MouseEvent<SVGSVGElement>): number | undefined => {
    if (!slot) return undefined;
    const i = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - padL) / slot);
    return i >= 0 && i < n ? i : undefined;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => setHover(at(e));
  const open = (i: number | undefined) => {
    const b = i !== undefined ? byIndex.get(i) : undefined;
    if (b?.anchored) location.hash = `#/verify?batch=${b.batchIndex}`;
  };

  return (
    <figure className="inst beacons" ref={ref}>
      <figcaption className="inst-cap">
        <span>
          <b>Every batch</b>, oldest first · one beacon each
        </span>
        <span>{rows ? `batches 0–${latest}` : "reading…"}</span>
      </figcaption>
      <p className="sr-only">{summary}</p>
      <div className="bl-wrap" style={{ height: H }}>
        {width > 0 && (
          <svg
            className={rows ? "bl" : "bl loading"}
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            aria-hidden="true"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(undefined)}
            onClick={(e) => open(at(e))}
            style={{ cursor: hovered?.anchored ? "pointer" : "default" }}
          >
            <defs>
              <radialGradient id="bl-glow">
                <stop offset="0" stopColor="var(--lamp-glow)" stopOpacity="0.55" />
                <stop offset="1" stopColor="var(--lamp-glow)" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* The sea line */}
            <line className="bl-sea" x1={0} x2={width} y1={base} y2={base} />
            {!rows &&
              Array.from({ length: Math.max(1, Math.floor((width - padL * 2) / (phone ? 22 : 40))) }, (_, i) => {
                const sx = padL + (phone ? 22 : 40) * (i + 0.5);
                return <line key={i} className="bl-ghost" x1={sx} x2={sx} y1={base} y2={base - postH} style={{ animationDelay: `${i * 70}ms` }} />;
              })}
            {rows &&
              Array.from({ length: n }, (_, i) => {
                const b = byIndex.get(i);
                const cx = x(i);
                const top = base - postH;
                const delay = `${Math.min(i, 40) * 26}ms`;
                const label = i % every === 0 || i === latest;
                const inWindow = b?.status === "submitted";
                const left = inWindow && windowSec && b?.submittedTime ? Math.max(0, b.submittedTime + windowSec - now / 1000) : undefined;
                const frac = left !== undefined && windowSec ? 1 - left / windowSec : 0;
                const cls = !b ? "gap" : b.status === "pruned" ? "pruned" : b.status;
                return (
                  <g key={i} className={`bl-b ${cls}${b?.anchored ? " lit" : " open"}${hover === i ? " on" : ""}`}>
                    {hover === i && <rect className="bl-hit" x={cx - slot / 2} y={top - 26} width={slot} height={postH + 46} />}
                    <line className="bl-post" x1={cx} x2={cx} y1={base} y2={top + r} style={{ animationDelay: delay }} />
                    {b?.anchored && <circle className="bl-glow" cx={cx} cy={top} r={r * 4.2} fill="url(#bl-glow)" style={{ animationDelay: delay }} />}
                    <circle className="bl-lamp" cx={cx} cy={top} r={r} style={{ animationDelay: delay }} />
                    {inWindow && (
                      <circle
                        className="bl-window"
                        cx={cx}
                        cy={top}
                        r={r + 5}
                        pathLength={100}
                        strokeDasharray={`${Math.max(0, 100 - frac * 100)} 100`}
                        transform={`rotate(-90 ${cx} ${top})`}
                      />
                    )}
                    {label && (
                      <text className="bl-i" x={cx} y={base + 19}>
                        {i}
                      </text>
                    )}
                    {i === latest && (
                      <text className="bl-tag" x={cx} y={top - 16}>
                        {inWindow ? "in window" : "latest"}
                      </text>
                    )}
                    {fraudAt.has(i) && (
                      <g className="bl-fraud" style={{ animationDelay: `calc(${delay} + 600ms)` }}>
                        <line x1={cx + slot * 0.34} x2={cx + slot * 0.34} y1={base} y2={base + 30} />
                        <rect x={cx + slot * 0.34 - 4} y={base + 30} width={8} height={8} transform={`rotate(45 ${cx + slot * 0.34} ${base + 34})`} />
                      </g>
                    )}
                  </g>
                );
              })}
            {rows && width > 0 && (
              <g className="bl-b next">
                <line className="bl-post" x1={x(n)} x2={x(n)} y1={base} y2={base - postH + r} />
                <circle className="bl-lamp" cx={x(n)} cy={base - postH} r={r} />
                {slot >= 24 && (
                  <text className="bl-tag" x={x(n)} y={base - postH - 16}>
                    next
                  </text>
                )}
              </g>
            )}
          </svg>
        )}
        {(hovered || hoveredFraud) && hover !== undefined && (
          <div className="bl-tip" style={{ left: Math.min(Math.max(x(hover), 130), width - 130), top: 0 }} role="presentation">
            <p className="bl-tip-h">
              Batch {hover}
              {hovered && <span className={`st ${hovered.status}`}>{hovered.status}</span>}
            </p>
            {hovered && (
              <p>
                {hovered.anchored ? "Anchored with ML-DSA-87" : "No anchor: not submitted by the creator's sequencer, so no receipt"} · root <code>{short(hovered.stateRoot, 5)}</code> · block{" "}
                {hovered.block.toLocaleString()}
              </p>
            )}
            {hoveredFraud?.map((f) => (
              <p key={f.height} className="bl-tip-fraud">
                Fraud proof upheld at block {f.height.toLocaleString()}
                {f.time ? `, ${utcStamp(Date.parse(f.time))}` : ""}: a forged batch #{hover} by {nameOf(f.submitter)} was rejected, {qor(f.slashed)} slashed. The index went to
                the next batch.
              </p>
            ))}
            {hovered?.anchored && <p className="bl-tip-go">Click to verify its receipt →</p>}
          </div>
        )}
      </div>
      <ul className="legend-row">
        <li>
          <i className="lg lit" /> anchored with ML-DSA-87
        </li>
        <li>
          <i className="lg open" /> no anchor (not the creator's sequencer)
        </li>
        <li>
          <i className="lg wait" /> in its challenge window
        </li>
        <li>
          <i className="lg fraud" /> fraud proof upheld
        </li>
      </ul>
    </figure>
  );
}
