import { Suspense, lazy, useEffect, useState } from "react";
import { REPO, ROLLUP, WS_URL, connectionState, onConnectionState } from "./chain.ts";
import { RollupView } from "./views/Rollup.tsx";

const VerifyView = lazy(() => import("./views/Verify.tsx").then((m) => ({ default: m.VerifyView })));
const PayslipView = lazy(() => import("./views/Payslip.tsx").then((m) => ({ default: m.PayslipView })));

type Route = "rollup" | "verify" | "payslip";
const routeOf = (hash: string): Route => (hash.startsWith("#/verify") ? "verify" : hash.startsWith("#/payslip") ? "payslip" : "rollup");

export function App() {
  const [route, setRoute] = useState<Route>(routeOf(location.hash));
  const [conn, setConn] = useState(connectionState());
  useEffect(() => {
    const onHash = () => setRoute(routeOf(location.hash));
    addEventListener("hashchange", onHash);
    const off = onConnectionState(setConn);
    return () => {
      removeEventListener("hashchange", onHash);
      off();
    };
  }, []);

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
          {tab("verify", "Verify a receipt", "#/verify")}
          {tab("payslip", "Open a payslip", "#/payslip")}
        </nav>
        <span className={`conn ${conn}`} title={`Chain connection: ${WS_URL}`}>
          <span className="dot" aria-hidden="true" />
          {conn === "open" ? "Live" : conn === "connecting" ? "Connecting" : "Reconnecting"}
        </span>
      </header>
      <main className="page">
        <Suspense fallback={<p className="empty">Loading…</p>}>
          {route === "rollup" && <RollupView />}
          {route === "verify" && <VerifyView />}
          {route === "payslip" && <PayslipView />}
        </Suspense>
      </main>
      <footer className="foot">
        <p>
          Everything on this page is read straight from a QoreChain node over its websocket, decoded with the chain's own schemas, and checked in your
          browser. There is no Vigil server in between. Rollup <code>{ROLLUP}</code> on testnet <code>qorechain-diana</code>.
        </p>
        <p>
          <a href={REPO}>Source</a> · <a href={`${REPO}/blob/main/EVIDENCE.md`}>Evidence ledger</a> · <a href={`${REPO}/blob/main/THREAT_MODEL.md`}>Threat model</a>
        </p>
      </footer>
    </div>
  );
}
