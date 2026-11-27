/**
 * The footer's "What's inside" label (src/inside.ts) is written by hand; this pins every scanned fact in it to
 * the committed QoreScan run (cbom/vigil.cdx.json, cbom/scan.json), and keeps its wording inside our rules:
 * no classical primitive called post-quantum, no absolute claims.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { algorithms, allComponents, parseCbom, props, scanDate, solidityWhere, tlsGroups } from "../../../scripts/cbom/lib.ts";
import { INSIDE, SCAN, TLS, TLS_NOTE } from "../src/inside.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const cbom = parseCbom(readFileSync(resolve(REPO, SCAN.cbom), "utf8"));
const run = JSON.parse(readFileSync(resolve(REPO, "cbom/scan.json"), "utf8")) as { date: string; height: string };
const byName = new Map(algorithms(cbom).map((a) => [a.name, a]));

describe("What's inside: the label matches the scan", () => {
  it("quotes the scan's date and height", () => {
    expect(SCAN.date).toBe(scanDate(cbom));
    expect(SCAN.date).toBe(run.date);
    expect(SCAN.height).toBe(run.height);
    expect(cbom.metadata?.tools?.components?.[0]).toMatchObject({ name: "qorescan", version: "0.1.0" });
  });

  it("gives each scanned primitive QoreScan's own class", () => {
    for (const p of INSIDE.filter((x) => x.qorescan)) {
      const found = byName.get(p.qorescan!.name);
      expect(found, p.name).toBeDefined();
      expect(found?.classification, p.name).toBe(p.qorescan!.cls);
      expect(p.seen.startsWith("Scanned"), p.name).toBe(true);
    }
  });

  it("names every primitive the scan found in the contracts", () => {
    const fromContracts = algorithms(cbom).filter((a) => a.sources.includes("solidity"));
    expect(fromContracts.map((a) => a.name).sort()).toEqual(["Keccak-256", "ML-DSA-87"]);
    for (const a of fromContracts) expect(INSIDE.some((p) => p.qorescan?.name === a.name)).toBe(true);
  });

  it("names the contracts each scanned primitive was found in, and no others", () => {
    const CONTRACTS = ["InstantExitVault", "PQGuardVault", "SettlementReceiptVerifier"];
    for (const p of INSIDE.filter((x) => x.qorescan)) {
      const asset = allComponents(cbom).find((c) => c.type === "cryptographic-asset" && c.name === p.qorescan!.name);
      const found = new Set(solidityWhere(asset!).map((w) => w.split(".sol:")[0]));
      const text = `${p.where}\n${p.seen}`;
      const claimed = /\bthree contracts\b/.test(text) ? CONTRACTS : CONTRACTS.filter((c) => text.includes(c));
      expect(claimed, p.name).toEqual(CONTRACTS.filter((c) => found.has(c)));
      expect([...found].every((f) => CONTRACTS.includes(f)), p.name).toBe(true);
    }
  });

  it("never calls a classical primitive post-quantum or hybrid", () => {
    for (const p of INSIDE) {
      if (p.qorescan?.cls === "quantum-vulnerable") expect(p.cls, p.name).toBe("classical");
      if (p.cls === "post-quantum" && p.qorescan) expect(p.qorescan.cls, p.name).toBe("post-quantum");
    }
    // The hybrid row's classical half is named as such.
    const seal = INSIDE.find((p) => p.cls === "hybrid");
    expect(seal?.clsNote).toMatch(/X25519 is classical/);
  });

  it("quotes the chain facts as the node reported them", () => {
    const validators = allComponents(cbom).find((c) => c["bom-ref"] === "crypto/key/active-validators/ed25519");
    expect(props(validators, "qorescan:count")).toEqual(["4"]);
    expect(INSIDE.find((p) => p.name === "Ed25519")?.seen).toMatch(/\b4 active validators\b/);
    expect(props(cbom.metadata, "qorescan:chain:pqc:hybrid-signature-mode")).toEqual(["required"]);
    expect(INSIDE.find((p) => p.name === "ECDSA secp256k1")?.where).toMatch(/hybrid mode is required, as the node reports/);
    expect(props(cbom.metadata, "qorescan:chain:account-pqc-status")).toHaveLength(10);
  });

  it("shows the TLS group each host negotiated, with its class", () => {
    const groups = tlsGroups(cbom);
    expect(TLS).toHaveLength(groups.size);
    for (const t of TLS) {
      expect(groups.get(`${t.host}:443`), t.host).toBe(t.group);
      expect(t.cls, t.host).toBe(byName.get(t.group)?.classification === "hybrid" ? "hybrid" : "classical");
      expect(TLS_NOTE[t.group], t.group).toBeDefined();
    }
  });

  it("says every certificate is signed classically, as the scan saw", () => {
    const certs = allComponents(cbom).filter((c) => c.cryptoProperties?.assetType === "certificate");
    expect(certs.length).toBeGreaterThan(0);
    const sigAlgs = algorithms(cbom).filter((a) => /^(ECDSA with|RSA )/.test(a.name));
    expect(sigAlgs.length).toBeGreaterThan(0);
    for (const a of sigAlgs) expect(a.classification).toBe("quantum-vulnerable");
  });
});

describe("What's inside: wording", () => {
  const text = [...INSIDE.flatMap((p) => [p.name, p.clsNote, p.where, p.seen]), ...TLS.map((t) => t.role), ...Object.values(TLS_NOTE)].join("\n");
  const page = readFileSync(resolve(import.meta.dirname, "../src/Inside.tsx"), "utf8");
  const shell = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

  it("is labelled an inventory aid, not a certification", () => {
    expect(shell).toMatch(/an inventory aid, not a certification/);
    expect(page).toMatch(/an inventory aid, not a certification/);
  });

  it("makes no absolute or novelty claims", () => {
    for (const word of [/quantum[- ]safe/i, /quantum[- ]proof/i, /unbreakable/i, /\bfirst\b/i, /\bonly\b/i, /\bunique\b/i]) {
      expect(text, String(word)).not.toMatch(word);
      expect(page, String(word)).not.toMatch(word);
    }
  });
});
