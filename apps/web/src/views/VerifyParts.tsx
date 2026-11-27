/**
 * The Verify page's instruments.
 *
 * The sector light: on a chart, a sector light shows a ship green or red depending on whether it is on a
 * safe course. Here each sector is one check, in the order the checks run, left to right: starboard green
 * when it passed, port red where it failed, an outline where it was not reached, lamp amber while it is
 * still pending. While a check runs, the lamp sweeps the fan.
 *
 * The receipt: the receipt itself, set as a document. When it differs from the one the page built from
 * the chain for the same batch (each forgery changes one field), the changed field is named and its
 * changed characters are marked.
 */
import type { SettlementReceipt } from "@qorechain/rdk";
import { KNOWN, short, stamp } from "../config.ts";
import { changedFields } from "../forge.ts";
import type { Tone } from "../ui.tsx";

const SPREAD = 62; // degrees either side of straight up
const GAP = 1.4;
const CX = 200;
const CY = 226;
const R0 = 54;
const R1 = 196;

const pt = (r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};

function wedge(a0: number, a1: number): string {
  const [x0, y0] = pt(R0, a0);
  const [x1, y1] = pt(R1, a0);
  const [x2, y2] = pt(R1, a1);
  const [x3, y3] = pt(R0, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}L${x1.toFixed(2)} ${y1.toFixed(2)}A${R1} ${R1} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}L${x3.toFixed(2)} ${y3.toFixed(2)}A${R0} ${R0} 0 0 0 ${x0.toFixed(2)} ${y0.toFixed(2)}Z`;
}

export function SectorLight({ tones, busy, word, wordTone, runKey }: { tones: Tone[] | undefined; busy: boolean; word: string | undefined; wordTone: string | undefined; runKey: string }) {
  const n = tones?.length || 9;
  const each = (SPREAD * 2) / n;
  const passed = tones?.filter((t) => t === "ok").length ?? 0;
  return (
    <figure className="sector" aria-hidden="true">
      <svg viewBox="0 0 400 250" className={busy ? "sl busy" : tones ? "sl done" : "sl idle"}>
        <defs>
          <radialGradient id="sl-beam" cx={CX} cy={CY} r={R1} gradientUnits="userSpaceOnUse">
            <stop offset="0.15" stopColor="var(--lamp-glow)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--lamp-glow)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="sl-lamp">
            <stop offset="0" stopColor="var(--lamp-glow)" stopOpacity="0.7" />
            <stop offset="1" stopColor="var(--lamp-glow)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* The arc charts draw across a light's sector. */}
        <path className="sl-arc" d={`M${pt(R1 + 14, -SPREAD).join(" ")}A${R1 + 14} ${R1 + 14} 0 0 1 ${pt(R1 + 14, SPREAD).join(" ")}`} />
        <g key={runKey}>
          {Array.from({ length: n }, (_, i) => {
            const a0 = -SPREAD + i * each + GAP / 2;
            const a1 = -SPREAD + (i + 1) * each - GAP / 2;
            const tone = tones?.[i];
            const [lx, ly] = pt(R1 + 28, (a0 + a1) / 2);
            return (
              <g key={i} className={`sl-w t-${tone ?? "none"}`} style={{ animationDelay: `${i * 90}ms` }}>
                <path d={wedge(a0, a1)} />
                <text x={lx} y={ly + 3}>
                  {String(i + 1).padStart(2, "0")}
                </text>
              </g>
            );
          })}
        </g>
        {busy && (
          <g className="sl-sweep">
            <path d={wedge(-each / 2 - 4, each / 2 + 4)} fill="url(#sl-beam)" />
          </g>
        )}
        <circle cx={CX} cy={CY} r={34} fill="url(#sl-lamp)" className="sl-glow" />
        <circle cx={CX} cy={CY} r={6} className="sl-lamp" />
      </svg>
      <figcaption className={`sl-word ${wordTone ?? ""}`} key={`w:${runKey}`}>
        {busy ? <span className="sl-busy">Checking…</span> : word ? <span>{word}</span> : <span className="sl-wait">Waiting for a receipt</span>}
        {tones && !busy && (
          <small>
            {passed} of {n} checks passed
          </small>
        )}
      </figcaption>
    </figure>
  );
}

/** The state root in groups of eight, with any digit that differs from `was` marked. */
function Hex({ value, was }: { value: string; was: string | undefined }) {
  const groups: { chars: { c: string; diff: boolean }[] }[] = [];
  for (let i = 0; i < value.length; i += 8) {
    groups.push({ chars: [...value.slice(i, i + 8)].map((c, j) => ({ c, diff: was !== undefined && was[i + j] !== c })) });
  }
  return (
    <code className="hexgrid">
      {groups.map((g, i) => (
        <span key={i}>
          {g.chars.map((ch, j) =>
            ch.diff ? (
              <mark key={j} title={`was ${was?.[i * 8 + j] ?? "?"}`}>
                {ch.c}
              </mark>
            ) : (
              ch.c
            ),
          )}
        </span>
      ))}
    </code>
  );
}

/** `value` with each character that differs from `was` (same position) marked. */
function Marked({ value, was }: { value: string; was: string }) {
  return (
    <>
      {[...value].map((c, i) =>
        was[i] !== c ? (
          <mark key={i} title={`was ${was[i] ?? "nothing"}`}>
            {c}
          </mark>
        ) : (
          c
        ),
      )}
    </>
  );
}

const DIFFERS = "differs from the receipt built from the chain";

export function ReceiptDoc({ r, built, stampTone, stampText }: { r: SettlementReceipt; built: SettlementReceipt | undefined; stampTone: string | undefined; stampText: string | undefined }) {
  // Compared only with the receipt the page built for the same batch, field by field.
  const base = built && built.batchIndex === r.batchIndex && built.layerHeight === r.layerHeight ? built : undefined;
  const diff = changedFields(r, base);
  const digits = base && diff.has("stateRoot") ? [...r.stateRoot].filter((c, i) => base.stateRoot[i] !== c).length + Math.abs(r.stateRoot.length - base.stateRoot.length) : 0;
  const sigByte = base && diff.has("pqcSignature") ? Math.floor([...r.pqcSignature].findIndex((c, i) => base.pqcSignature[i] !== c) / 2) + 1 : 0;
  const sigBytes = Math.floor(r.pqcSignature.length / 2);
  const tag = (what: string) => <span className="rdoc-diff">{what}</span>;
  return (
    <article className={diff.size ? "rdoc forged" : "rdoc"} aria-label={`Settlement receipt for batch ${r.batchIndex} of ${r.rollupId}`}>
      <header className="rdoc-top">
        <span>Settlement receipt</span>
        <span>version {r.version}</span>
      </header>
      <h3 className="rdoc-t">
        {base && diff.has("rollupId") ? <Marked value={r.rollupId} was={base.rollupId} /> : r.rollupId} <span>·</span> batch {r.batchIndex}
      </h3>
      {base && diff.has("rollupId") && <p className="rdoc-note">{tag(`Rollup ${DIFFERS} (${base.rollupId})`)}</p>}
      <dl className="rdoc-kv">
        <div>
          <dt>Chain {base && diff.has("chainId") && tag(DIFFERS)}</dt>
          <dd>{base && diff.has("chainId") ? <mark>{r.chainId ?? "not named"}</mark> : (r.chainId ?? "not named (version 1)")}</dd>
        </div>
        <div>
          <dt>Layer height</dt>
          <dd>{r.layerHeight}</dd>
        </div>
        <div>
          <dt>Main-chain block</dt>
          <dd>{Number(r.mainChainHeight).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Anchored</dt>
          <dd>{r.anchoredAt ? stamp(r.anchoredAt) : "—"}</dd>
        </div>
        <div className="wide">
          <dt>Signer {base && diff.has("creator") && tag(DIFFERS)}</dt>
          <dd title={r.creator}>{base && diff.has("creator") ? <mark>{KNOWN[r.creator] ?? short(r.creator, 10)}</mark> : (KNOWN[r.creator] ?? short(r.creator, 10))}</dd>
        </div>
        <div className="wide">
          <dt>
            State root{" "}
            {digits > 0 && tag(`${digits === 1 ? "one digit differs" : `${digits} digits differ`} from the receipt built from the chain`)}
          </dt>
          <dd>
            <Hex value={r.stateRoot} was={base?.stateRoot} />
          </dd>
        </div>
        <div className="wide">
          <dt>Signature {sigByte > 0 && tag(`byte ${sigByte.toLocaleString()} ${DIFFERS}`)}</dt>
          <dd>
            {r.algorithm}, {sigBytes.toLocaleString()} bytes{" "}
            <code className="rdoc-sig">
              {base && diff.has("pqcSignature") ? <Marked value={r.pqcSignature.slice(0, 12)} was={base.pqcSignature.slice(0, 12)} /> : r.pqcSignature.slice(0, 12)}…
              {r.pqcSignature.slice(-12)}
            </code>
          </dd>
        </div>
      </dl>
      {stampText && (
        <p className={`rdoc-stamp ${stampTone ?? ""}`} key={stampText + r.stateRoot + r.pqcSignature.slice(0, 4) + r.chainId + r.creator + r.rollupId}>
          {stampText}
        </p>
      )}
    </article>
  );
}
