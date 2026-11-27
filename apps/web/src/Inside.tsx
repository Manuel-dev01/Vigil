/**
 * The body of the footer's "What's inside" label (inside.ts), loaded when a reader opens it, so the
 * shell's initial download stays the same size.
 */
import { REPO } from "./config.ts";
import { INSIDE, SCAN, TLS, TLS_NOTE, type InsideClass } from "./inside.ts";
import "./inside.css";

/** The shell's chip tones: green for post-quantum, the lamp for hybrid, red for classical, plain for hashes. */
const TONE: Record<InsideClass, string> = { "post-quantum": "ok", hybrid: "info", classical: "bad", hash: "pruned" };

function Cls({ cls }: { cls: InsideClass }) {
  return <span className={`chip ${TONE[cls]}`}>{cls}</span>;
}

/** "2026-11-27" as "27 Nov 2026". */
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default function Inside() {
  const blob = (path: string) => `${REPO}/blob/main/${path}`;
  return (
    <div className="inside-body">
      <p>
        Each primitive Vigil relies on, where it is used and what QoreScan saw. From one {SCAN.tool} run on {day(SCAN.date)} (UTC), at testnet height{" "}
        {SCAN.height}; chain facts are as the node reports them. This is an inventory aid, not a certification. Read the{" "}
        <a href={blob(SCAN.cbom)} target="_blank" rel="noopener noreferrer">
          CBOM
        </a>{" "}
        and the{" "}
        <a href={blob("cbom/README.md")} target="_blank" rel="noopener noreferrer">
          notes on the scan
        </a>
        .
      </p>
      <ul className="inside-list">
        {INSIDE.map((p) => (
          <li key={p.name}>
            <p className="inside-head">
              <strong>{p.name}</strong> <Cls cls={p.cls} /> <span className="inside-note">{p.clsNote}</span>
            </p>
            <p>{p.where}</p>
            <p className="inside-seen">{p.seen}</p>
          </li>
        ))}
        <li>
          <p className="inside-head">
            <strong>TLS key exchange</strong> <span className="inside-note">one TLS 1.3 handshake per host</span>
          </p>
          <ul className="inside-tls">
            {TLS.map((t) => (
              <li key={t.host}>
                <code>{t.host}</code> ({t.role}): <code>{t.group}</code> <Cls cls={t.cls} /> <span className="inside-note">{TLS_NOTE[t.group]}</span>
              </li>
            ))}
          </ul>
          <p className="inside-seen">
            Scanned. One handshake shows what a server picks for a modern client, not everything it accepts. Every certificate in these chains is
            signed with ECDSA or RSA, which are classical.
          </p>
        </li>
      </ul>
    </div>
  );
}
