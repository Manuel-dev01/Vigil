import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Mark } from "./brand/Mark.tsx";
import { EVM_HOST, NODE_HOST, REPO, ROLLUP } from "./config.ts";
import { Landing } from "./landing/Landing.tsx";
import { startLive } from "./live.ts";
import { badgeOf, health, onHealth, wasOpen } from "./rpc.ts";
import { ErrorBoundary } from "./ui.tsx";

// Every view loads on demand, with the chain libraries it needs, so the shell paints first. The same
// loaders preload a view before a page transition, so the transition never shows "Loading…".
const loaders = {
  rollup: () => import("./views/Rollup.tsx"),
  exits: () => import("./views/Exits.tsx"),
  verify: () => import("./views/Verify.tsx"),
  payslip: () => import("./views/Payslip.tsx"),
};
const RollupView = lazy(() => loaders.rollup().then((m) => ({ default: m.RollupView })));
const VerifyView = lazy(() => loaders.verify().then((m) => ({ default: m.VerifyView })));
const PayslipView = lazy(() => loaders.payslip().then((m) => ({ default: m.PayslipView })));
const ExitsView = lazy(() => loaders.exits().then((m) => ({ default: m.ExitsView })));

type Route = "home" | keyof typeof loaders;
const routeOf = (hash: string): Route =>
  hash.startsWith("#/rollup")
    ? "rollup"
    : hash.startsWith("#/exits")
      ? "exits"
      : hash.startsWith("#/verify")
        ? "verify"
        : hash.startsWith("#/payslip")
          ? "payslip"
          : "home";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function App() {
  const [route, setRoute] = useState<Route>(routeOf(location.hash));
  const current = useRef(route);
  const [h, setH] = useState(health());

  useEffect(() => {
    // Change page inside a view transition (where the browser has them): the old page lifts away and
    // the new one rises, while the header stays put and the tab marker slides to its new tab.
    const onHash = async () => {
      const next = routeOf(location.hash);
      if (next === current.current) return;
      if (next !== "home") await loaders[next]().catch(() => undefined);
      const apply = () => {
        flushSync(() => setRoute(next));
        current.current = next;
        scrollTo(0, 0);
      };
      if (!("startViewTransition" in document) || reducedMotion()) apply();
      else document.startViewTransition(apply);
    };
    addEventListener("hashchange", onHash);
    const off = onHealth(setH);
    // The live subscriptions drive the badge on every page: "Live" means the node confirmed them.
    startLive();

    // Pressing a button flashes it like a signal lamp: a ring that opens and fades (transform and
    // opacity only; none with reduced motion).
    const onDown = (e: PointerEvent) => {
      const b = (e.target as Element | null)?.closest?.(".btn, button");
      if (!b || reducedMotion()) return;
      b.classList.remove("signal");
      void (b as HTMLElement).offsetWidth;
      b.classList.add("signal");
    };
    document.addEventListener("pointerdown", onDown);
    return () => {
      removeEventListener("hashchange", onHash);
      document.removeEventListener("pointerdown", onDown);
      off();
    };
  }, []);
  const badge = badgeOf(h, wasOpen());

  // Each tab has a full label and a short one for phones (the full one stays the accessible name).
  const tab = (r: Route, label: string, short: string, href: string) => (
    <a href={href} className={route === r ? "tab active" : "tab"} aria-current={route === r ? "page" : undefined} aria-label={label}>
      <span className="tab-long" aria-hidden="true">
        {label}
      </span>
      <span className="tab-short" aria-hidden="true">
        {short}
      </span>
      {route === r && <span className="tab-mark" aria-hidden="true" />}
    </a>
  );

  return (
    <>
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="top">
        <div className="top-in">
          <a className="brand" href="#/" aria-label="Vigil, home">
            <Mark size={26} className="brand-mark" />
            <span className="brand-word" aria-hidden="true">
              Vigil
            </span>
          </a>
          <nav className="tabs" aria-label="Sections">
            {tab("rollup", "Rollup", "Rollup", "#/rollup")}
            {tab("exits", "Instant exits", "Exits", "#/exits")}
            {tab("verify", "Verify a receipt", "Verify", "#/verify")}
            {tab("payslip", "Open a payslip", "Payslip", "#/payslip")}
          </nav>
          <span className={`conn ${badge.tone}`} title={badge.detail} role="status" aria-label={`Chain connection: ${badge.label}. ${badge.detail}`}>
            <span className="dot" aria-hidden="true" />
            {badge.label}
          </span>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={route === "home" ? "main-home" : "page"}>
        <ErrorBoundary resetKey={route}>
          {route === "home" ? (
            <Landing />
          ) : (
            <Suspense fallback={<p className="empty">Loading…</p>}>
              {route === "rollup" && <RollupView />}
              {route === "exits" && <ExitsView />}
              {route === "verify" && <VerifyView />}
              {route === "payslip" && <PayslipView />}
            </Suspense>
          )}
        </ErrorBoundary>
      </main>
      <footer className="foot">
        <div className="foot-in">
          <p className="foot-word">
            <Mark size={20} /> Vigil · Build Before Q-Day · Protocol Builders
          </p>
          <p>
            This page reads one public QoreChain node, <code>{NODE_HOST}</code> (over its websocket), and the same operator's EVM endpoint,{" "}
            <code>{EVM_HOST}</code>. Their answers come without proofs, so the page trusts that operator for what the chain holds. There is no Vigil
            server in between. Checked in your browser: ML-DSA-87 signatures (settlement anchors and watchtower attestations), with each signer's key
            compared to one pinned in this page; ML-DSA-44 transfer signatures; the inbox accumulator; data receipts; exit messages and exit addresses.
            Rollup <code>{ROLLUP}</code> on testnet <code>qorechain-diana</code>. Times are UTC.
          </p>
          <p className="foot-links">
            <a href={REPO} target="_blank" rel="noopener noreferrer">
              Source
            </a>
            <a href={`${REPO}/blob/main/EVIDENCE.md`} target="_blank" rel="noopener noreferrer">
              Evidence ledger
            </a>
            <a href={`${REPO}/blob/main/THREAT_MODEL.md`} target="_blank" rel="noopener noreferrer">
              Threat model
            </a>
            <a href={`${REPO}/blob/main/AI_USAGE.md`} target="_blank" rel="noopener noreferrer">
              AI usage
            </a>
            <a href="https://build.qorechain.io/p/vigil" target="_blank" rel="noopener noreferrer">
              Project page
            </a>
          </p>
        </div>
      </footer>
    </>
  );
}
