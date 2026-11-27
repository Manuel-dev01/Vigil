/**
 * The contracts gate over a QoreScan CBOM: fails if any Solidity source uses a public-key primitive that
 * QoreScan does not class as post-quantum (ecrecover, ECDSA or P-256 verification, RSA, or a library that
 * provides one).
 *
 *   pnpm exec qorescan solidity contracts/src --out contracts.cdx.json
 *   pnpm cbom:gate contracts.cdx.json
 *
 * Exit 0: pass. Exit 1: a contract uses a classical public-key primitive. Exit 2: the file cannot be judged
 * (not a CycloneDX 1.6 CBOM, or no Solidity was scanned). CI tells 1 from 2, so a broken scan never passes
 * for a caught one.
 */
import { readFileSync } from "node:fs";
import { contractsGate, parseCbom } from "./lib.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm cbom:gate <cbom.json>");
  process.exit(2);
}

let result: ReturnType<typeof contractsGate>;
try {
  result = contractsGate(parseCbom(readFileSync(file, "utf8")));
} catch (e) {
  console.error(`contracts gate: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

if (result.problems.length > 0) {
  for (const p of result.problems) console.error(`contracts gate: ${p}`);
  process.exit(2);
}
console.log(`contracts gate: ${result.files} Solidity file(s) scanned by QoreScan`);
for (const p of result.postQuantum) console.log(`  post-quantum  ${p.name}: ${p.where.length} occurrence(s), e.g. ${p.where.slice(0, 3).join(", ")}`);
if (result.violations.length === 0) {
  console.log("  classical signature verification: none");
  process.exit(0);
}
for (const v of result.violations) {
  const msg = `${v.name} (${v.classification}) at ${v.where.join(", ") || "an unknown place"}`;
  console.error(`  CLASSICAL  ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::A contract uses a classical public-key primitive: ${msg}`);
}
console.error("contracts gate: FAIL. Vigil's contracts must verify signatures only through pqcVerify (ML-DSA-87).");
process.exit(1);
