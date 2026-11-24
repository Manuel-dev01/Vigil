import { Suspense, lazy, useEffect, useState } from "react";
import { EVM_HOST, NODE_HOST, REPO, ROLLUP } from "./config.ts";
import { startLive } from "./live.ts";
import { badgeOf, health, onHealth, wasOpen } from "./rpc.ts";
import { ErrorBoundary } from "./ui.tsx";

// Every view loads on demand, with the chain libraries it needs, so the shell paints first.
const RollupView = lazy(() => import("./views/Rollup.tsx").then((m) => ({ default: m.RollupView })));
const VerifyView = lazy(() => import("./views/Verify.tsx").then((m) => ({ default: m.VerifyView })));
const PayslipView = lazy(() => import("./views/Payslip.tsx").then((m) => ({ default: m.PayslipView })));
const ExitsView = lazy(() => import("./views/Exits.tsx").then((m) => ({ default: m.ExitsView })));

type Route = "rollup" | "exits" | "verify" | "payslip";
const routeOf = (hash: string): Route =>
  hash.startsWith("#/exits") ? "exits" : hash.startsWith("#/verify") ? "verify" : hash.startsWith("#/payslip") ? "payslip" : "rollup";

export function App() {
  const [route, setRoute] = useState<Route>(routeOf(location.hash));
  const [h, setH] = useState(health());
  useEffect(() => {
    const onHash = () => setRoute(routeOf(location.hash));
    addEventListener("hashchange", onHash);
    const off = onHealth(setH);
    // The live subscriptions drive the badge on every page: "Live" means the node confirmed them.
    startLive();
    return () => {
      removeEventListener("hashchange", onHash);
      off();
    };
  }, []);
  const badge = badgeOf(h, wasOpen());

  const tab = (r: Route, label: string, href: string) => (
    <a href={href} className={route === r ? "tab active" : "tab"} aria-current={route === r ? "page" : undefined}>
      {label}
    </a>
  );

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/">
          <span className="mark" aria-hidden="true" />
          Vigil
        </a>
        <nav className="tabs" aria-label="Sections">
          {tab("rollup", "Rollup", "#/")}
          {tab("exits", "Instant exits", "#/exits")}
          {tab("verify", "Verify a receipt", "#/verify")}
          {tab("payslip", "Open a payslip", "#/payslip")}
        </nav>
        <span className={`conn ${badge.tone}`} title={badge.detail} role="status" aria-label={`Chain connection: ${badge.label}. ${badge.detail}`}>
          <span className="dot" aria-hidden="true" />
          {badge.label}
        </span>
      </header>
      <main className="page">
        <ErrorBoundary resetKey={route}>
          <Suspense fallback={<p className="empty">Loading…</p>}>
            {route === "rollup" && <RollupView />}
            {route === "exits" && <ExitsView />}
            {route === "verify" && <VerifyView />}
            {route === "payslip" && <PayslipView />}
          </Suspense>
        </ErrorBoundary>
      </main>
      <footer className="foot">
        <p>
          This page reads one public QoreChain node, <code>{NODE_HOST}</code> (over its websocket), and the same operator's EVM endpoint,{" "}
          <code>{EVM_HOST}</code>. Their answers come without proofs, so the page trusts that operator for what the chain holds. There is no Vigil server
          in between. Checked in your browser: ML-DSA-87 signatures (settlement anchors and watchtower attestations), with each signer's key compared
          to one pinned in this page; ML-DSA-44 transfer signatures; the inbox accumulator; data receipts; exit messages and exit addresses. Rollup{" "}
          <code>{ROLLUP}</code> on testnet{" "}
          <code>qorechain-diana</code>. Times are UTC.
        </p>
        <p>
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            Source
          </a>{" "}
          ·{" "}
          <a href={`${REPO}/blob/main/EVIDENCE.md`} target="_blank" rel="noopener noreferrer">
            Evidence ledger
          </a>{" "}
          ·{" "}
          <a href={`${REPO}/blob/main/THREAT_MODEL.md`} target="_blank" rel="noopener noreferrer">
            Threat model
          </a>
        </p>
      </footer>
    </div>
  );
}
