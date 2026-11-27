/**
 * The contracts gate. Over a QoreScan CBOM, it fails if any Solidity source uses a public-key primitive that
 * QoreScan does not class as post-quantum (ecrecover, ECDSA or P-256 verification, RSA, or a library that
 * provides one). With --sources, it also reads the Solidity itself and fails if a contract names the address
 * of a classical public-key precompile in a form QoreScan 0.1.0 does not catch (precompiles.ts). Both are
 * pattern checks on the source, not a proof.
 *
 *   pnpm exec qorescan solidity contracts/src --out contracts.cdx.json
 *   pnpm cbom:gate contracts.cdx.json --sources contracts/src
 *
 * Exit 0: pass. Exit 1: a contract uses a classical public-key primitive. Exit 2: nothing can be judged
 * (not a CycloneDX 1.6 CBOM, no Solidity scanned, or no Solidity under --sources). CI tells 1 from 2, so a
 * broken scan never passes for a caught one.
 */
import { readFileSync } from "node:fs";
import { contractsGate, parseCbom } from "./lib.ts";
import { checkSources, type PrecompileUse } from "./precompiles.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--sources");
const sources = at >= 0 ? args[at + 1] : undefined;
const file = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
if (!file || (at >= 0 && !sources)) {
  console.error("usage: pnpm cbom:gate <cbom.json> [--sources <dir of .sol files>]");
  process.exit(2);
}

let result: ReturnType<typeof contractsGate>;
try {
  result = contractsGate(parseCbom(readFileSync(file, "utf8")));
} catch (e) {
  console.error(`contracts gate: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

let uses: PrecompileUse[] = [];
let sourceFiles = 0;
if (sources) {
  try {
    ({ files: sourceFiles, uses } = checkSources(sources));
  } catch (e) {
    console.error(`contracts gate: cannot read ${sources}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (sourceFiles === 0) result.problems.push(`no Solidity files under ${sources}`);
}

if (result.problems.length > 0) {
  for (const p of result.problems) console.error(`contracts gate: ${p}`);
  process.exit(2);
}
console.log(`contracts gate: ${result.files} Solidity file(s) scanned by QoreScan`);
for (const p of result.postQuantum) console.log(`  post-quantum  ${p.name}: ${p.where.length} occurrence(s), e.g. ${p.where.slice(0, 3).join(", ")}`);
if (sources) console.log(`  source check: ${sourceFiles} Solidity file(s) under ${sources}, comments and strings blanked`);
if (result.violations.length === 0 && uses.length === 0) {
  console.log(`  classical signature verification: none found${sources ? "; classical public-key precompile addresses: none" : ""}`);
  process.exit(0);
}
const fail = (msg: string) => {
  console.error(`  CLASSICAL  ${msg}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::error::A contract uses a classical public-key primitive: ${msg}`);
};
for (const v of result.violations) fail(`${v.name} (${v.classification}) at ${v.where.join(", ") || "an unknown place"}`);
for (const u of uses) fail(`precompile ${u.address}, ${u.what}, at ${u.where}: ${u.text}`);
console.error("contracts gate: FAIL. Vigil's contracts must verify signatures only through pqcVerify (ML-DSA-87).");
process.exit(1);
