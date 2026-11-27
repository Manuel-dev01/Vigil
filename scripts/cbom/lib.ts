/**
 * Reading the CycloneDX 1.6 CBOMs that QoreScan (`@qorechain/qorescan`) writes: the contracts gate, and the
 * facts the README and the web page's "What's inside" label quote. QoreScan builds every CBOM; nothing here
 * writes one.
 *
 * The gate's rule: no Vigil contract may verify a classical signature. Over a CBOM, it checks that no
 * component QoreScan found in the Solidity sources is a public-key primitive (signature, encryption, key
 * agreement or KEM) that QoreScan does not class as post-quantum. QoreScan blanks comments and string
 * literals before it matches, so a comment that names ECDSA is not a use of it. QoreScan matches patterns,
 * so precompiles.ts adds a source check for precompile addresses it does not flag.
 */

export interface Property {
  name: string;
  value: string;
}

export interface Occurrence {
  location: string;
  line?: number;
  symbol?: string;
  additionalContext?: string;
}

export interface Component {
  type: string;
  "bom-ref"?: string;
  name: string;
  evidence?: { occurrences?: Occurrence[] };
  cryptoProperties?: {
    assetType?: string;
    algorithmProperties?: { primitive?: string; parameterSetIdentifier?: string; curve?: string };
    protocolProperties?: { type?: string; version?: string };
  };
  properties?: Property[];
  components?: Component[];
}

export interface Dependency {
  ref: string;
  dependsOn?: string[];
  provides?: string[];
}

export interface Cbom {
  bomFormat: string;
  specVersion: string;
  metadata?: {
    timestamp?: string;
    tools?: { components?: { name: string; version?: string }[] };
    properties?: Property[];
  };
  components?: Component[];
  dependencies?: Dependency[];
}

/** QoreScan's classes (internal/catalog): FIPS 203/204/205, hybrid, quantum-vulnerable, symmetric, unknown. */
export type QoreScanClass = "post-quantum" | "hybrid" | "quantum-vulnerable" | "symmetric" | "unknown";

/** CycloneDX primitives that rest on a public-key problem: the ones a quantum computer could break. */
export const PUBLIC_KEY_PRIMITIVES: ReadonlySet<string> = new Set(["signature", "pke", "key-agree", "kem"]);

/** Parse a CBOM and check that it is CycloneDX 1.6. Throws on anything else. */
export function parseCbom(text: string): Cbom {
  const doc = JSON.parse(text) as Partial<Cbom> | null;
  if (!doc || typeof doc !== "object" || doc.bomFormat !== "CycloneDX") throw new Error("not a CycloneDX document");
  if (doc.specVersion !== "1.6") throw new Error(`CycloneDX ${String(doc.specVersion)}, expected 1.6`);
  return doc as Cbom;
}

/** Every component, nested ones included. */
export function allComponents(cbom: Cbom): Component[] {
  const out: Component[] = [];
  const walk = (cs: Component[] | undefined) => {
    for (const c of cs ?? []) {
      out.push(c);
      walk(c.components);
    }
  };
  walk(cbom.components);
  return out;
}

/** All values of a property (QoreScan repeats `qorescan:source` once per scanner that found the asset). */
export function props(x: { properties?: Property[] } | undefined, name: string): string[] {
  return (x?.properties ?? []).filter((p) => p.name === name).map((p) => p.value);
}

export const classOf = (c: Component): QoreScanClass => (props(c, "qorescan:classification")[0] as QoreScanClass | undefined) ?? "unknown";
export const sourcesOf = (c: Component): string[] => props(c, "qorescan:source");
export const primitiveOf = (c: Component): string | undefined => c.cryptoProperties?.algorithmProperties?.primitive;

/** Where a component was seen, as `file:line symbol` (Solidity) or the endpoint. */
export function whereOf(c: Component): string[] {
  return (c.evidence?.occurrences ?? []).map((o) => (o.line !== undefined ? `${o.location}:${o.line}${o.symbol ? ` ${o.symbol}` : ""}` : o.location));
}

/** Solidity occurrences only: they carry a line number, network and TLS findings do not. */
export function solidityWhere(c: Component): string[] {
  return (c.evidence?.occurrences ?? []).filter((o) => o.line !== undefined).map((o) => `${o.location}:${o.line}${o.symbol ? ` ${o.symbol}` : ""}`);
}

export interface Violation {
  name: string;
  classification: QoreScanClass;
  where: string[];
}

export interface GateResult {
  /** True when the CBOM covers Solidity sources and none of them uses a classical public-key primitive. */
  ok: boolean;
  /** Solidity files QoreScan read. */
  files: number;
  /** Public-key primitives in the Solidity sources that QoreScan classes as post-quantum, with where. */
  postQuantum: { name: string; where: string[] }[];
  /** Public-key primitives (or libraries that provide one) in the Solidity sources that are not post-quantum. */
  violations: Violation[];
  /** Reasons the CBOM cannot be judged at all (no Solidity scanned). */
  problems: string[];
}

/** The contracts gate: see the file comment. */
export function contractsGate(cbom: Cbom): GateResult {
  const files = Number(props(cbom.metadata, "qorescan:solidity:files")[0] ?? "0");
  const problems: string[] = [];
  if (!Number.isInteger(files) || files <= 0) problems.push("the CBOM records no Solidity files: run `qorescan solidity <dir>` on the contracts");

  const all = allComponents(cbom);
  const fromSolidity = all.filter((c) => sourcesOf(c).includes("solidity"));
  const byRef = new Map(all.filter((c) => c["bom-ref"]).map((c) => [c["bom-ref"] as string, c]));

  const postQuantum: GateResult["postQuantum"] = [];
  const violations: Violation[] = [];
  const bad = new Set<string>();
  for (const c of fromSolidity) {
    if (c.type !== "cryptographic-asset" || c.cryptoProperties?.assetType !== "algorithm") continue;
    const primitive = primitiveOf(c);
    // An algorithm whose primitive QoreScan could not name is treated as public-key, to fail closed.
    if (primitive !== undefined && !PUBLIC_KEY_PRIMITIVES.has(primitive)) continue;
    const cls = classOf(c);
    if (cls === "post-quantum") postQuantum.push({ name: c.name, where: solidityWhere(c) });
    else {
      violations.push({ name: c.name, classification: cls, where: solidityWhere(c) });
      if (c["bom-ref"]) bad.add(c["bom-ref"]);
    }
  }
  // A library the contracts import that provides a classical primitive (OpenZeppelin ECDSA, say) fails too,
  // even if QoreScan saw no call to it. QoreScan 0.1.0 gives libraries no source property; a Solidity import
  // is recognised by its line number.
  for (const d of cbom.dependencies ?? []) {
    const lib = byRef.get(d.ref);
    if (!lib || lib.type !== "library" || !(sourcesOf(lib).includes("solidity") || solidityWhere(lib).length > 0)) continue;
    for (const p of d.provides ?? []) {
      const alg = byRef.get(p);
      if (!alg || bad.has(p)) continue;
      const primitive = primitiveOf(alg);
      if ((primitive === undefined || PUBLIC_KEY_PRIMITIVES.has(primitive)) && classOf(alg) !== "post-quantum") {
        violations.push({ name: `${lib.name} (provides ${alg.name})`, classification: classOf(alg), where: solidityWhere(lib) });
        bad.add(p);
      }
    }
  }
  return { ok: problems.length === 0 && violations.length === 0, files, postQuantum, violations, problems };
}

/** One algorithm as the CBOM records it, for the README and the web page's label. */
export interface AlgorithmFact {
  name: string;
  classification: QoreScanClass;
  primitive: string | undefined;
  sources: string[];
}

export function algorithms(cbom: Cbom): AlgorithmFact[] {
  return allComponents(cbom)
    .filter((c) => c.type === "cryptographic-asset" && c.cryptoProperties?.assetType === "algorithm")
    .map((c) => ({ name: c.name, classification: classOf(c), primitive: primitiveOf(c), sources: sourcesOf(c) }));
}

/** The key exchange group each TLS endpoint negotiated, from QoreScan's TLS protocol components. */
export function tlsGroups(cbom: Cbom): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of allComponents(cbom)) {
    if (c.cryptoProperties?.assetType !== "protocol" || !sourcesOf(c).includes("tls")) continue;
    const group = props(c, "qorescan:tls:key-exchange-group")[0];
    for (const o of c.evidence?.occurrences ?? []) if (group) out.set(o.location, group);
  }
  return out;
}

/** The scan's date (UTC, YYYY-MM-DD) from the CBOM's timestamp. */
export function scanDate(cbom: Cbom): string {
  const t = cbom.metadata?.timestamp;
  if (!t || !/^\d{4}-\d{2}-\d{2}T/.test(t)) throw new Error("the CBOM has no timestamp");
  return t.slice(0, 10);
}

/** What changed between two scans: algorithms that appeared or went, changed class, and TLS groups that moved. */
export interface Drift {
  added: string[];
  removed: string[];
  reclassed: string[];
  tls: string[];
}

export function drift(before: Cbom, after: Cbom): Drift {
  const a = new Map(algorithms(before).map((x) => [x.name, x.classification]));
  const b = new Map(algorithms(after).map((x) => [x.name, x.classification]));
  const ta = tlsGroups(before);
  const tb = tlsGroups(after);
  const tls: string[] = [];
  for (const host of new Set([...ta.keys(), ...tb.keys()])) {
    if (ta.get(host) !== tb.get(host)) tls.push(`${host}: ${ta.get(host) ?? "not scanned"} -> ${tb.get(host) ?? "not scanned"}`);
  }
  return {
    added: [...b.keys()].filter((n) => !a.has(n)).sort(),
    removed: [...a.keys()].filter((n) => !b.has(n)).sort(),
    reclassed: [...b.entries()].filter(([n, c]) => a.has(n) && a.get(n) !== c).map(([n, c]) => `${n}: ${a.get(n)} -> ${c}`).sort(),
    tls: tls.sort(),
  };
}

/** A short Markdown summary of a scan, for a CI job summary. */
export function summaryMarkdown(cbom: Cbom, against?: Cbom): string {
  const gate = contractsGate(cbom);
  const lines = [
    `### QoreScan CBOM, ${scanDate(cbom)} (UTC)`,
    "",
    "An inventory aid, not a certification. Chain facts are as the node reports them.",
    "",
    `Contracts gate on QoreScan's findings: ${gate.ok ? "pass" : "FAIL"} (${gate.files} Solidity files; classical public-key uses: ${gate.violations.map((v) => v.name).join(", ") || "none"})`,
    "",
    "| Algorithm | QoreScan class | Found by |",
    "|---|---|---|",
    ...algorithms(cbom)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((x) => `| ${x.name} | ${x.classification} | ${x.sources.join(", ")} |`),
  ];
  const tls = [...tlsGroups(cbom).entries()].sort();
  if (tls.length > 0) lines.push("", "| TLS endpoint | Key exchange group |", "|---|---|", ...tls.map(([h, g]) => `| ${h} | ${g} |`));
  if (against) {
    const d = drift(against, cbom);
    const changes = [
      ...d.added.map((x) => `- new: ${x}`),
      ...d.removed.map((x) => `- gone: ${x}`),
      ...d.reclassed.map((x) => `- class changed: ${x}`),
      ...d.tls.map((x) => `- TLS group changed: ${x}`),
    ];
    lines.push("", `Since the committed scan (${scanDate(against)}):`, "", ...(changes.length ? changes : ["- no change in algorithms, classes or TLS groups"]));
  }
  return `${lines.join("\n")}\n`;
}
