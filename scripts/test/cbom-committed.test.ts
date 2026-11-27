/**
 * The committed QoreScan run (cbom/vigil.cdx.json, cbom/scan.json): it passes the contracts gate, PQGuardVault's
 * comment does not trip it, and it covers every target scripts/cbom/targets.ts names.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { algorithms, contractsGate, drift, parseCbom, props, scanDate, summaryMarkdown, tlsGroups } from "../cbom/lib.ts";
import { ACCOUNTS, TLS_ENDPOINTS } from "../cbom/targets.ts";

const REPO = resolve(import.meta.dirname, "../..");
const committed = parseCbom(readFileSync(resolve(REPO, "cbom/vigil.cdx.json"), "utf8"));

describe("contracts gate on the committed scan", () => {
  it("passes the committed scan of contracts/src: five files, ML-DSA-87 through pqcVerify in each contract, nothing classical", () => {
    const g = contractsGate(committed);
    expect(g.ok).toBe(true);
    expect(g.files).toBe(5);
    expect(g.violations).toEqual([]);
    const mldsa = g.postQuantum.find((p) => p.name === "ML-DSA-87");
    for (const c of ["InstantExitVault.sol", "PQGuardVault.sol", "SettlementReceiptVerifier.sol"]) {
      expect(mldsa?.where.some((w) => w.startsWith(`${c}:`) && w.endsWith("pqcVerify"))).toBe(true);
    }
  });

  it("is not tripped by PQGuardVault's comment that names ECDSA", () => {
    expect(readFileSync(resolve(REPO, "contracts/src/PQGuardVault.sol"), "utf8")).toMatch(/classical \(ECDSA\) key/);
    const ecdsa = algorithms(committed).find((a) => a.name.startsWith("ECDSA secp256k1"));
    expect(ecdsa?.sources).not.toContain("solidity");
  });

});

describe("the committed scan covers what targets.ts names", () => {
  it("records each of the ten L1 accounts' key status, all hybrid with ML-DSA-87, as the node reported on the scan date", () => {
    expect(scanDate(committed)).toBe("2026-11-27");
    const status = props(committed.metadata, "qorescan:chain:account-pqc-status");
    expect(status).toHaveLength(ACCOUNTS.length);
    for (const a of ACCOUNTS) expect(status).toContain(`${a}: hybrid key, dilithium5`);
  });

  it("records one TLS handshake per endpoint", () => {
    expect([...tlsGroups(committed).keys()].sort()).toEqual([...TLS_ENDPOINTS].sort());
  });

  it("matches cbom/scan.json, the run's own record", () => {
    const run = JSON.parse(readFileSync(resolve(REPO, "cbom/scan.json"), "utf8")) as { timestamp: string; accounts: string[]; tls: string[]; contractsGate: { ok: boolean } };
    expect(run.timestamp).toBe(committed.metadata?.timestamp);
    expect(run.accounts).toEqual([...ACCOUNTS]);
    expect(run.tls).toEqual([...TLS_ENDPOINTS]);
    expect(run.contractsGate.ok).toBe(true);
  });
});

describe("summary of the committed scan", () => {
  it("finds nothing between a scan and itself", () => {
    expect(drift(committed, committed)).toEqual({ added: [], removed: [], reclassed: [], tls: [] });
    expect(summaryMarkdown(committed, committed)).toMatch(/no change in algorithms, classes or TLS groups/);
  });

  it("summarises the committed scan with its disclaimer and gate result", () => {
    const md = summaryMarkdown(committed);
    expect(md).toMatch(/An inventory aid, not a certification/);
    expect(md).toMatch(/Contracts gate: pass \(5 Solidity files; classical public-key uses: none\)/);
    expect(md).toMatch(/\| vigil-pq\.up\.railway\.app:443 \| X25519 \|/);
  });
});
