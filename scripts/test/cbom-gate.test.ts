/**
 * The contracts gate (scripts/cbom/gate.ts) on real QoreScan output, recorded from the two canaries in
 * test/vectors/cbom, and on small hand-made CBOMs for each rule. Also what `drift` reports between scans.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contractsGate, drift, parseCbom, type Cbom, type Component } from "../cbom/lib.ts";

const REPO = resolve(import.meta.dirname, "../..");
const load = (path: string): Cbom => parseCbom(readFileSync(resolve(REPO, path), "utf8"));

/** A minimal QoreScan-shaped CBOM. */
function cbomWith(components: unknown[], extra: Partial<Cbom> = {}, files = "1"): Cbom {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    metadata: { timestamp: "2026-11-27T00:00:00Z", properties: [{ name: "qorescan:solidity:files", value: files }] },
    components: components as Component[],
    ...extra,
  };
}
const alg = (ref: string, name: string, primitive: string | undefined, cls: string, sources: string[], line?: number) => ({
  type: "cryptographic-asset",
  "bom-ref": ref,
  name,
  evidence: { occurrences: [{ location: line === undefined ? "https://node/x" : "A.sol", ...(line === undefined ? {} : { line, symbol: "x" }) }] },
  cryptoProperties: { assetType: "algorithm", algorithmProperties: primitive === undefined ? {} : { primitive } },
  properties: [{ name: "qorescan:classification", value: cls }, ...sources.map((s) => ({ name: "qorescan:source", value: s }))],
});

describe("contracts gate on recorded QoreScan scans of the canaries", () => {
  it("fails the canary that calls ecrecover (recorded scan of test/vectors/cbom/classical)", () => {
    const g = contractsGate(load("test/vectors/cbom/classical.cdx.json"));
    expect(g.ok).toBe(false);
    expect(g.problems).toEqual([]);
    expect(g.violations).toEqual([{ name: "ECDSA secp256k1", classification: "quantum-vulnerable", where: ["ClassicalCanary.sol:8 ecrecover"] }]);
  });

  it("passes the canary that names ECDSA and ecrecover only in comments and strings", () => {
    const g = contractsGate(load("test/vectors/cbom/comments.cdx.json"));
    expect(g.ok).toBe(true);
    expect(g.postQuantum.map((p) => p.name)).toEqual(["ML-DSA-87"]);
  });
});

describe("contracts gate rules", () => {
  it("ignores classical primitives the chain or TLS scans found", () => {
    const g = contractsGate(cbomWith([alg("a", "ECDSA secp256k1", "signature", "quantum-vulnerable", ["chain"]), alg("b", "X25519", "key-agree", "quantum-vulnerable", ["tls"])]));
    expect(g.ok).toBe(true);
  });

  it("fails an asset that both the chain and the contracts use", () => {
    const g = contractsGate(cbomWith([alg("a", "ECDSA secp256k1", "signature", "quantum-vulnerable", ["chain", "solidity"], 12)]));
    expect(g.ok).toBe(false);
    expect(g.violations[0]?.where).toEqual(["A.sol:12 x"]);
  });

  it("fails P-256 and RSA verification, and a hybrid or unknown public-key primitive", () => {
    for (const [name, primitive, cls] of [
      ["ECDSA P-256", "signature", "quantum-vulnerable"],
      ["RSA", "signature", "quantum-vulnerable"],
      ["X25519MLKEM768", "kem", "hybrid"],
      ["Mystery", undefined, "unknown"],
    ] as const) {
      expect(contractsGate(cbomWith([alg("a", name, primitive, cls, ["solidity"], 3)])).ok, name).toBe(false);
    }
  });

  it("passes hashes in the contracts", () => {
    expect(contractsGate(cbomWith([alg("k", "Keccak-256", "hash", "symmetric", ["solidity"], 4)])).ok).toBe(true);
  });

  it("fails an imported library that provides a classical primitive, even with no call seen", () => {
    const lib = { type: "library", "bom-ref": "lib/oz/ECDSA", name: "ECDSA", evidence: { occurrences: [{ location: "A.sol", line: 2, symbol: "import" }] } };
    const ecdsa = alg("crypto/algorithm/ecdsa-secp256k1", "ECDSA secp256k1", "signature", "quantum-vulnerable", ["chain"]);
    const g = contractsGate(cbomWith([lib, ecdsa], { dependencies: [{ ref: "lib/oz/ECDSA", provides: ["crypto/algorithm/ecdsa-secp256k1"] }] }));
    expect(g.ok).toBe(false);
    expect(g.violations[0]?.name).toBe("ECDSA (provides ECDSA secp256k1)");
  });

  it("cannot judge a CBOM with no Solidity in it", () => {
    const g = contractsGate(cbomWith([], {}, "0"));
    expect(g.ok).toBe(false);
    expect(g.problems).toHaveLength(1);
  });

  it("refuses anything but CycloneDX 1.6", () => {
    expect(() => parseCbom(JSON.stringify({ bomFormat: "SPDX" }))).toThrow(/CycloneDX/);
    expect(() => parseCbom(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5" }))).toThrow(/1\.6/);
  });
});

describe("drift between scans", () => {
  it("reports a TLS group that moves and a class that changes", () => {
    const tlsAt = (group: string) => ({
      type: "cryptographic-asset",
      name: "TLS 1.3 at web:443",
      evidence: { occurrences: [{ location: "web:443" }] },
      cryptoProperties: { assetType: "protocol" },
      properties: [{ name: "qorescan:source", value: "tls" }, { name: "qorescan:tls:key-exchange-group", value: group }],
    });
    const before = cbomWith([tlsAt("X25519"), alg("x", "X25519", "key-agree", "quantum-vulnerable", ["tls"])]);
    const after = cbomWith([tlsAt("X25519MLKEM768"), alg("h", "X25519MLKEM768", "kem", "hybrid", ["tls"]), alg("x", "X25519", "key-agree", "unknown", ["tls"])]);
    expect(drift(before, after)).toEqual({
      added: ["X25519MLKEM768"],
      removed: [],
      reclassed: ["X25519: quantum-vulnerable -> unknown"],
      tls: ["web:443: X25519 -> X25519MLKEM768"],
    });
  });

});
