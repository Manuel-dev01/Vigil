/**
 * The Payslip page's instrument: the rollup's whole inbox, one mark per entry in the order posted, with the
 * batches that settled them bracketed underneath. Each entry is drawn by what the page decoded it to be:
 *   - a sealed envelope (QoreSeal), drawn as an envelope; it opens when your seal key opens it here;
 *   - a transfer whose ML-DSA-44 signature verifies in this browser;
 *   - an L2 withdrawal request, or a deposit from L1;
 *   - a watchtower's signed attestation for an instant exit;
 *   - a fraud drill's text post (the entries the two forged batches claimed to settle);
 *   - anything else.
 * The sealed table below stays the accessible record; this drawing is hidden from screen readers, which
 * get a one-line count instead.
 */
import { useState } from "react";
import { decodeQledgerDeposit, decodeQledgerTx, QLEDGER_KIND_WITHDRAW, type BatchView } from "@qorechain/rdk";
import type { InboxPost } from "@vigil/sealed/inbox";
import { transferOf } from "@vigil/sealed/inbox";
import { isSealedEnvelope } from "@vigil/sealed/payslip";
import { decodeAttestation } from "../attest.ts";
import { KNOWN, shortAddr } from "../config.ts";
import { useWidth } from "../ui.tsx";

export type EntryKind = "sealed" | "transfer" | "withdrawal" | "deposit" | "attestation" | "drill" | "other";

const NAMES: Record<EntryKind, string> = {
  sealed: "sealed envelope",
  transfer: "transfer, ML-DSA-44 signature verified here",
  withdrawal: "L2 withdrawal request",
  deposit: "deposit from L1",
  attestation: "watchtower attestation for an instant exit",
  drill: "fraud drill's text post",
  other: "other post",
};

export function kindOf(p: InboxPost, env: { chainId: string; rollupId: string }): EntryKind {
  if (isSealedEnvelope(p.payload)) return "sealed";
  if (transferOf(p.payload, env)) return "transfer";
  const q = decodeQledgerTx(p.payload);
  if (q?.kind === QLEDGER_KIND_WITHDRAW) return "withdrawal";
  if (decodeQledgerDeposit(p.payload)) return "deposit";
  try {
    if (decodeAttestation(p.payload)) return "attestation";
  } catch {
    // not an attestation
  }
  if (new TextDecoder().decode(p.payload.slice(0, 17)) === "vigil fraud drill") return "drill";
  return "other";
}

export function InboxStrip({
  posts,
  kinds,
  batches,
  opened,
  onOpen,
}: {
  posts: InboxPost[] | undefined;
  kinds: Map<number, EntryKind>;
  batches: BatchView[] | undefined;
  /** Sequences of envelopes opened with the visitor's key. */
  opened: Set<number>;
  onOpen: (sequence: number) => void;
}) {
  const [ref, width] = useWidth<HTMLElement>();
  const [hover, setHover] = useState<number>();
  const phone = width > 0 && width < 640;
  const n = posts?.length ?? 0;
  const pad = 4;
  const slot = width && n ? Math.min(phone ? 26 : 46, (width - pad * 2) / n) : 0;
  const x = (seq: number) => pad + slot * (seq - 0.5);
  const H = phone ? 150 : 170;
  const rowY = phone ? 58 : 66;
  const every = slot >= 22 ? 1 : slot >= 11 ? 5 : 10;
  const g = Math.max(5, Math.min(11, slot * 0.36)); // glyph half-size

  const settled = (batches ?? []).filter((b) => b.status !== "rejected" && b.inboxEnd > b.inboxStart).sort((a, b) => a.inboxStart - b.inboxStart);
  const counts = { sealed: 0, transfer: 0, withdrawal: 0, deposit: 0, attestation: 0, drill: 0, other: 0 } as Record<EntryKind, number>;
  for (const k of kinds.values()) counts[k]++;
  const summary = posts
    ? `${n} inbox entries: ${counts.sealed} sealed envelopes, ${counts.transfer} transfers, ${counts.withdrawal} withdrawals, ${counts.deposit} deposits, ${counts.attestation} watchtower attestations${counts.drill ? `, ${counts.drill} fraud-drill posts` : ""}${counts.other ? `, ${counts.other} other` : ""}.`
    : "Reading the inbox.";

  // The entry under the pointer, from the event itself (a click must not use a hover from an earlier render).
  const at = (e: React.MouseEvent<SVGSVGElement>): number | undefined => {
    if (!slot) return undefined;
    const seq = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - pad) / slot) + 1;
    return seq >= 1 && seq <= n ? seq : undefined;
  };
  const hp = hover !== undefined ? posts?.[hover - 1] : undefined;
  const hb = hp ? settled.find((b) => b.inboxStart < hp.sequence && hp.sequence <= b.inboxEnd) : undefined;

  return (
    <figure className="inst inbox" ref={ref}>
      <figcaption className="inst-cap">
        <span>
          <b>The inbox</b>, every entry in the order posted · bracketed by the batch that settled it
        </span>
        <span>{posts ? `entries 1–${n}` : "reading…"}</span>
      </figcaption>
      <p className="sr-only">{summary}</p>
      <div className="ib-wrap" style={{ height: H }}>
        {width > 0 && (
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            aria-hidden="true"
            className={posts ? "ib" : "ib loading"}
            onPointerMove={(e) => setHover(at(e))}
            onPointerLeave={() => setHover(undefined)}
            onClick={(e) => {
              const seq = at(e);
              if (seq !== undefined && opened.has(seq)) onOpen(seq);
            }}
            style={{ cursor: hover !== undefined && opened.has(hover) ? "pointer" : "default" }}
          >
            <line className="ib-line" x1={0} x2={width} y1={rowY} y2={rowY} />
            {!posts &&
              Array.from({ length: Math.floor(width / 34) }, (_, i) => (
                <circle key={i} className="ib-ghost" cx={17 + i * 34} cy={rowY} r={3} style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            {posts?.map((p, i) => {
              const k = kinds.get(p.sequence) ?? "other";
              const cx = x(p.sequence);
              const open = opened.has(p.sequence);
              const delay = { animationDelay: `${Math.min(i, 60) * 30}ms` };
              return (
                <g key={p.sequence} className={`ib-e ${k}${open ? " opened" : ""}${hover === p.sequence ? " on" : ""}`} style={delay}>
                  {hover === p.sequence && <rect className="ib-hit" x={cx - slot / 2} y={rowY - 42} width={slot} height={84} />}
                  {k === "sealed" ? (
                    <g className="env" transform={`translate(${cx} ${rowY})`}>
                      <rect x={-g} y={-g * 0.72} width={g * 2} height={g * 1.44} rx={1} />
                      <path className="flap" d={`M${-g} ${-g * 0.72}L0 ${g * 0.18}L${g} ${-g * 0.72}`} />
                    </g>
                  ) : k === "transfer" ? (
                    <circle cx={cx} cy={rowY} r={Math.max(2.5, g * 0.42)} />
                  ) : k === "withdrawal" ? (
                    <path d={`M${cx} ${rowY - g * 0.7}L${cx + g * 0.55} ${rowY + g * 0.35}L${cx - g * 0.55} ${rowY + g * 0.35}Z`} />
                  ) : k === "deposit" ? (
                    <path d={`M${cx} ${rowY + g * 0.7}L${cx + g * 0.55} ${rowY - g * 0.35}L${cx - g * 0.55} ${rowY - g * 0.35}Z`} />
                  ) : k === "drill" ? (
                    <rect x={cx - g * 0.38} y={rowY - g * 0.38} width={g * 0.76} height={g * 0.76} />
                  ) : k === "attestation" ? (
                    <rect x={cx - g * 0.4} y={rowY - g * 0.4} width={g * 0.8} height={g * 0.8} transform={`rotate(45 ${cx} ${rowY})`} />
                  ) : (
                    <circle cx={cx} cy={rowY} r={2} />
                  )}
                  {(p.sequence % every === 0 || p.sequence === 1 || p.sequence === n) && (
                    <text className="ib-n" x={cx} y={rowY - (phone ? 24 : 28)}>
                      {p.sequence}
                    </text>
                  )}
                </g>
              );
            })}
            {posts &&
              settled.map((b) => {
                const x0 = x(b.inboxStart + 1) - slot * 0.42;
                const x1 = x(b.inboxEnd) + slot * 0.42;
                const y0 = rowY + (phone ? 22 : 26);
                return (
                  <g key={`${b.batchIndex}:${b.inboxStart}`} className={`ib-b ${b.status}`}>
                    <path d={`M${x0} ${y0}V${y0 + 6}H${x1}V${y0}`} />
                    {(slot >= 24 || b.batchIndex % 5 === 0) && (
                      <text x={(x0 + x1) / 2} y={y0 + 20}>
                        {b.batchIndex}
                      </text>
                    )}
                  </g>
                );
              })}
            {posts && (
              <text className="ib-cap" x={0} y={rowY + (phone ? 64 : 72)}>
                batch
              </text>
            )}
          </svg>
        )}
        {hp && hover !== undefined && (
          <div className="bl-tip ib-tip" style={{ left: Math.min(Math.max(x(hover), 130), width - 130), top: 0 }} role="presentation">
            <p className="bl-tip-h">Entry {hp.sequence}</p>
            <p>
              {NAMES[kinds.get(hp.sequence) ?? "other"]} · {hp.payload.length.toLocaleString()} B · posted by {KNOWN[hp.poster] ?? shortAddr(hp.poster)} at block{" "}
              {hp.height.toLocaleString()}
            </p>
            <p>{hb ? `Settled in batch ${hb.batchIndex} (${hb.status}).` : "Not in a batch the chain still keeps."}</p>
            {opened.has(hp.sequence) && <p className="bl-tip-go">Opened with your key: click to read it ↓</p>}
          </div>
        )}
      </div>
      <ul className="legend-row">
        <li>
          <svg width="16" height="12" viewBox="-8 -6 16 12" className="ib-lg env-lg" aria-hidden="true">
            <rect x={-7} y={-5} width={14} height={10} rx={1} />
            <path d="M-7 -5L0 1L7 -5" />
          </svg>{" "}
          sealed envelope ({counts.sealed})
        </li>
        <li>
          <i className="lg ib-tr" /> transfer ({counts.transfer})
        </li>
        <li>
          <i className="lg ib-wd" /> withdrawal ({counts.withdrawal})
        </li>
        <li>
          <i className="lg ib-dp" /> deposit ({counts.deposit})
        </li>
        <li>
          <i className="lg ib-at" /> watchtower attestation ({counts.attestation})
        </li>
        {counts.drill > 0 && (
          <li>
            <i className="lg ib-dr" /> fraud-drill post ({counts.drill})
          </li>
        )}
        {counts.other > 0 && (
          <li>
            <i className="lg ib-ot" /> other ({counts.other})
          </li>
        )}
      </ul>
    </figure>
  );
}
