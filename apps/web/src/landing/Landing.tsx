/**
 * The landing page: what Vigil is, in one scroll. A lattice sea at night is swept by Vigil's lamp; one
 * batch goes through its life as you scroll; the page ends at dawn and hands you to the live app.
 * Every number on it is read from the chain or links to a row of EVIDENCE.md.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { REPO, txUrl } from "../config.ts";
import { listen } from "../live.ts";
import type { Facts, Quorum } from "./facts.ts";
import type { Watch } from "./scene.ts";
import "./landing.css";

const EVIDENCE = `${REPO}/blob/main/EVIDENCE.md`;
/** A numbered row of the evidence ledger (each row carries an `rN` anchor). */
const row = (n: number): string => `${EVIDENCE}#r${n}`;

interface Step {
  n: string;
  title: string;
  body: string;
  sounding?: { label: string; href: string };
}

/** The life of one batch, in the order it happens. */
const STEPS: Step[] = [
  {
    n: "01",
    title: "Signed",
    body: "A payment is signed with ML-DSA-44 and posted to the rollup's inbox on QoreChain.",
  },
  {
    n: "02",
    title: "Batched",
    body: "Keel, the sequencer, orders the inbox into a batch and anchors its state root with an ML-DSA-87 signature, in the same transaction.",
    sounding: { label: "EVIDENCE 13 to 23", href: row(13) },
  },
  {
    n: "03",
    title: "Re-executed",
    body: "Two watchtowers replay the batch from its parent. A wrong state root is challenged on chain: in our fraud drill the challenge was upheld in the very next block and the forger's 1,000 QOR bond was slashed.",
    sounding: { label: "EVIDENCE 55 · block 10,382,607", href: txUrl("4963FCFD2D33188456572D27C16D96DD2CB03604767DCBEEF0EDFB54E0F5B915") },
  },
  {
    n: "04",
    title: "Fronted",
    body: "Leaving early? Both watchtowers sign your withdrawal, the vault checks their ML-DSA-87 signatures with pqcVerify and can pay you before the batch is final. Our first automatic exit was paid 11 blocks after its batch: about 23 seconds from the block that took the withdrawal to the block that paid it.",
    sounding: { label: "EVIDENCE 99 to 104", href: row(99) },
  },
  {
    n: "05",
    title: "Final",
    body: "After the challenge window the batch is final. Anyone can rebuild its receipt from chain state and check it, in the browser or in Solidity.",
    sounding: { label: "Verify batch 0", href: "#/verify?batch=0" },
  },
];

interface Entry {
  date: string;
  height: string;
  what: string;
  tx: string;
  /** EVM transactions don't resolve in the explorer: they link to their row of the ledger instead. */
  evm?: number;
}

const LOG: Entry[] = [
  { date: "19 Nov", height: "10,351,825", what: "Rollup vigil-pay-1 created, hybrid-signed, by an account that has never opened an EVM window", tx: "02993B293296A749036459D56D2C9C4A9D84DB5AB66059F3B7F62F4771F692F0" },
  { date: "19 Nov", height: "10,382,607", what: "A forged batch 8 challenged by our watchtower and rejected in the next block; 1,000 QOR bond slashed", tx: "4963FCFD2D33188456572D27C16D96DD2CB03604767DCBEEF0EDFB54E0F5B915" },
  { date: "20 Nov", height: "10,433,596", what: "Our own sequencer stopped; a bonded standby in another region batched a user's withdrawal", tx: "07FF243ADEC001154ADA0B35A4850BFE5010D790AF1AB1C1EA4D5D9954929941" },
  { date: "24 Nov", height: "10,686,385", what: "An instant exit paid 11 blocks after its batch and about 23 s after the withdrawal was posted, with nobody in the loop", tx: "0x6542b5f393cd4b37f349ef3b2e9edfe103d81b2f675d4ee48c0bd2f2de627c8f", evm: 104 },
  { date: "24 Nov", height: "10,688,909", what: "After finality, the vault repaid itself", tx: "0x08b645d1225ff366b60f2b8db982f0ed08d451999a0107b637a1338fd4464ba7", evm: 108 },
  { date: "24 Nov", height: "10,691,360", what: "A December payslip sealed with ML-KEM-1024 to three recipients", tx: "8ADA7C5E04F5A1CB66C3372A4DA3C8A81CD7B3094DFF0BED6D7A17F0068A1739" },
];

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const grouped = (n: number): string => n.toLocaleString("en-US");

export function Landing() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const lifeRef = useRef<HTMLElement>(null);
  const dawnRef = useRef<HTMLElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [height, setHeight] = useState<number>();
  const [facts, setFacts] = useState<Facts>();
  // undefined while reading; null if the EVM endpoint did not answer in time.
  const [quorum, setQuorum] = useState<Quorum | null>();
  const [noGl, setNoGl] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("on-landing");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let watch: Watch | undefined;
    let lenis: { raf(t: number): void; destroy(): void } | undefined;
    let raf = 0;
    let gone = false;
    let shownStep = 0;
    const progress = { hero: 0, life: 0, dawn: 0 };

    const measure = () => {
      const vh = innerHeight;
      const hero = heroRef.current;
      const life = lifeRef.current;
      const dawn = dawnRef.current;
      if (!hero || !life || !dawn) return;
      const hr = hero.getBoundingClientRect();
      progress.hero = clamp01(-hr.top / Math.max(1, hr.height));
      const lr = life.getBoundingClientRect();
      const span = lr.height - vh;
      progress.life = span > 0 ? clamp01(-lr.top / span) * 5 : 0;
      const dr = dawn.getBoundingClientRect();
      progress.dawn = clamp01((vh - dr.top) / (vh * 0.85));
      const next = Math.min(4, Math.floor(progress.life));
      if (next !== shownStep) {
        shownStep = next;
        setStep(next);
      }
      root.classList.toggle("is-scrolled", hr.top < -40);
      root.classList.toggle("is-dawn", progress.dawn > 0.55);
      if (skyRef.current) skyRef.current.style.opacity = String(progress.dawn);
    };

    const loop = (now: number) => {
      lenis?.raf(now);
      measure();
      watch?.frame(now, progress);
      raf = requestAnimationFrame(loop);
    };

    // The page paints first; the scene and smooth scrolling load after.
    const boot = async () => {
      const canvas = canvasRef.current;
      if (canvas) {
        try {
          const { startWatch } = await import("./scene.ts");
          if (gone) return;
          watch = startWatch(canvas, { reduced });
        } catch {
          watch = undefined;
        }
        if (!watch) setNoGl(true);
      }
      if (!reduced) {
        const { default: Lenis } = await import("lenis");
        if (gone) return;
        lenis = new Lenis({ lerp: 0.1, autoRaf: false });
      }
      if (reduced) {
        // No loop: one frame now and one per resize.
        measure();
        watch?.frame(performance.now(), progress);
      } else raf = requestAnimationFrame(loop);
    };
    const idle = setTimeout(() => void boot(), 60);

    const onResize = () => {
      watch?.resize();
      if (reduced) watch?.frame(performance.now(), progress);
    };
    addEventListener("resize", onResize);
    // Without the loop (reduced motion), scroll still decides the header and the dawn.
    const onScroll = () => measure();
    if (reduced) addEventListener("scroll", onScroll, { passive: true });
    const onVisible = () => {
      if (reduced) return;
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", onVisible);

    // Reveal blocks once, as they come near the viewport.
    root.classList.add("js-reveal");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries)
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));

    // Live: every new block sends a ring from the lamp; a new batch adds a beacon.
    let beacons = 0;
    const feed = listen({
      onHead: (h) => {
        setHeight(h.height);
        watch?.pulse();
      },
      onItem: (item) => {
        if (item.kind === "batch") {
          beacons = Math.max(beacons, item.batchIndex + 1);
          watch?.setBeacons(beacons);
        }
      },
    });
    if (feed.head) setHeight(feed.head.height);

    // The node's facts and the EVM's quorum load apart, so neither waits on the other.
    void import("./facts.ts")
      .then((m) => {
        void m
          .loadFacts()
          .then((f) => {
            if (gone) return;
            setFacts(f);
            beacons = Math.max(beacons, f.anchors);
            const set = () => watch?.setBeacons(beacons);
            set();
            setTimeout(set, 1500);
          })
          .catch(() => undefined);
        void m.loadQuorum().then((q) => {
          if (!gone) setQuorum(q ?? null);
        });
      })
      .catch(() => undefined);

    return () => {
      gone = true;
      clearTimeout(idle);
      cancelAnimationFrame(raf);
      removeEventListener("resize", onResize);
      removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisible);
      io.disconnect();
      feed.stop();
      lenis?.destroy();
      watch?.dispose();
      root.classList.remove("on-landing", "is-scrolled", "is-dawn", "js-reveal");
    };
  }, []);

  return (
    <div className="landing night">
      <div className="sky" aria-hidden="true">
        <div className="sky-dawn" ref={skyRef} />
        <canvas ref={canvasRef} className={noGl ? "sea off" : "sea"} />
      </div>

      <section className="hero" ref={heroRef} aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">
            Rollup <span className="mono">vigil-pay-1</span> · QoreChain testnet<span className="since"> · on watch since 19 Nov 2026</span>
          </p>
          <h1 id="hero-title" className="hero-title">
            <span className="line">
              <span style={{ "--i": 0 } as CSSProperties}>Keeping watch</span>
            </span>
            <span className="line">
              <span style={{ "--i": 1 } as CSSProperties}>
                until <em>Q-Day.</em>
              </span>
            </span>
          </h1>
          <p className="hero-lede">
            Vigil is a payments rollup on QoreChain. Users sign with ML-DSA-44, our sequencer anchors each batch it posts with ML-DSA-87, and two
            watchtowers re-execute every batch and challenge fraud on chain.
          </p>
          <div className="cta">
            <a className="btn primary" href="#/rollup">
              Watch the rollup live
            </a>
            <a className="btn ghost" href="#/verify?batch=0">
              Verify a receipt
            </a>
          </div>
        </div>
        <aside className="soundings" aria-label="Read from the chain just now">
          <dl>
            <div>
              <dt>Block</dt>
              <dd>{height ? grouped(height) : "reading…"}</dd>
            </div>
            <div>
              <dt>Latest batch</dt>
              <dd>{facts ? `${facts.latestIndex} · ${facts.latestStatus}` : "reading…"}</dd>
            </div>
            <div>
              <dt>Anchors on chain</dt>
              <dd>{facts ? facts.anchors : "reading…"}</dd>
            </div>
            <div title="Watchtowers that must sign an instant exit, of those in the quorum: InstantExitVault's threshold() and quorum(), read from QoreChain's EVM">
              <dt>Exit quorum</dt>
              <dd>{quorum ? `${quorum.threshold} of ${quorum.members}` : quorum === null ? "—" : "reading…"}</dd>
            </div>
          </dl>
        </aside>
        <p className="scroll-cue" aria-hidden="true">
          Follow one batch <span>↓</span>
        </p>
      </section>

      <section className="life" ref={lifeRef} aria-labelledby="life-title">
        <div className="life-stage">
          <div className="life-legend">
            <p className="eyebrow" id="life-title">
              One batch, from signature to final
            </p>
            <ol className="life-steps">
              {STEPS.map((s, i) => (
                <li key={s.n} className={i === step ? "on" : i < step ? "past" : "next"} aria-current={i === step ? "step" : undefined}>
                  <span className="life-n mono" aria-hidden="true">
                    {s.n}
                  </span>
                  <h2 className="life-title">{s.title}</h2>
                  <p className="life-body">{s.body}</p>
                  {s.sounding && (
                    <a
                      className="life-sounding mono"
                      href={s.sounding.href}
                      {...(s.sounding.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    >
                      {s.sounding.label} →
                    </a>
                  )}
                </li>
              ))}
            </ol>
            <div className="life-rail mono" aria-hidden="true">
              {STEPS.map((s, i) => (
                <span key={s.n} className={i === step ? "on" : i < step ? "past" : ""}>
                  {s.n}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="also" aria-labelledby="also-title">
        <h2 id="also-title" className="sec-title" data-reveal>
          Also on watch
        </h2>
        <div className="also-grid">
          <article data-reveal style={{ "--i": 0 } as CSSProperties}>
            <h3>Sealed payslips</h3>
            <p>Payslips sealed with ML-KEM-1024 sit in the rollup's public inbox. Anyone can see each one was posted and settled; only its recipients can open it.</p>
            <a href="#/payslip">Open a payslip →</a>
          </article>
          <article data-reveal style={{ "--i": 1 } as CSSProperties}>
            <h3>A standby sequencer</h3>
            <p>We stopped our own sequencer. A bonded standby on another key, in another region, took over, and a user's withdrawal was still paid.</p>
            <a href={row(65)} target="_blank" rel="noopener noreferrer">
              EVIDENCE 65 to 72 →
            </a>
          </article>
          <article data-reveal style={{ "--i": 2 } as CSSProperties}>
            <h3>Five languages agree</h3>
            <p>10,056 generated rollup histories, run through the TypeScript, Go, Rust, Python and Java rollup kits: the same state roots and withdrawals every time.</p>
            <a href={`${REPO}/tree/main/scripts/fuzz`} target="_blank" rel="noopener noreferrer">
              The fuzzing harness →
            </a>
          </article>
        </div>
      </section>

      <section className="log" aria-labelledby="log-title">
        <div className="log-head" data-reveal>
          <h2 id="log-title" className="sec-title">
            From the log
          </h2>
          <p>Each entry below is a transaction you can look up. Dates are UTC; heights are QoreChain testnet blocks.</p>
        </div>
        <ol className="logbook" data-reveal>
          {LOG.map((e) => (
            <li key={e.tx}>
              <span className="lb-date mono">{e.date}</span>
              <span className="lb-height mono">{e.height}</span>
              <span className="lb-what">{e.what}</span>
              {e.evm ? (
                <a className="lb-tx mono" href={row(e.evm)} target="_blank" rel="noopener noreferrer" title={e.tx}>
                  {e.tx.slice(0, 10)}… (EVM)
                </a>
              ) : (
                <a className="lb-tx mono" href={txUrl(e.tx)} target="_blank" rel="noopener noreferrer" title={e.tx}>
                  {e.tx.slice(0, 10)}…
                </a>
              )}
            </li>
          ))}
        </ol>
        <p className="log-more" data-reveal>
          <a href={EVIDENCE} target="_blank" rel="noopener noreferrer">
            Read the full evidence ledger →
          </a>
          <span className="note">The explorer opens on mainnet: switch it to Testnet if a link shows "not found".</span>
        </p>
      </section>

      <section className="dawn day" ref={dawnRef} aria-labelledby="dawn-title">
        <div className="dawn-copy">
          <p className="eyebrow">Q-Day</p>
          <h2 id="dawn-title" className="dawn-title">
            Built for the morning
            <br /> after <em>Q-Day.</em>
          </h2>
          <p className="dawn-lede">
            Batches, exits and receipts on Vigil are authorized by ML-DSA signatures, the NIST post-quantum standard, and checked on chain. Where a
            classical key is still involved, the threat model says so.
          </p>
          <div className="cta">
            <a className="btn primary" href="#/rollup">
              Watch the rollup live
            </a>
            <a className="btn ghost" href={`${REPO}/blob/main/THREAT_MODEL.md`} target="_blank" rel="noopener noreferrer">
              Read the threat model
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
