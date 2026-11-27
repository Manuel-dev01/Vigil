/**
 * Vigil's cryptographic inventory: one QoreScan run over the contracts, the testnet as the node reports it,
 * our accounts' registered keys and the TLS endpoints the web app and our services use.
 *
 *   pnpm cbom:scan                      # writes cbom/vigil.cdx.json, cbom/vigil.nis.md, cbom/agility-statement.md, cbom/scan.json
 *   pnpm cbom:scan --out-dir /tmp/cbom  # somewhere else (the scheduled workflow does this)
 *   pnpm cbom:scan --offline            # contracts only, no network at all; writes to a temporary directory
 *
 * Read-only. Every REST read goes through a local proxy that spaces requests about a second apart (see
 * throttle.ts); the TLS scans are one handshake per endpoint with no request. QoreScan is the pinned
 * devDependency `@qorechain/qorescan`, whose launcher runs a release binary only if its SHA-256 matches the
 * digest shipped in the package.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { contractsGate, parseCbom, scanDate } from "./lib.ts";
import { ACCOUNTS, CONTRACTS, REST_HOST, TLS_ENDPOINTS } from "./targets.ts";
import { startThrottleProxy } from "./throttle.ts";

const REPO = resolve(import.meta.dirname, "../..");
const GAP_MS = 1_100;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function qorescanBinary(): Promise<string> {
  const require = createRequire(import.meta.url);
  const launcher = require("@qorechain/qorescan/lib/install.js") as { ensureBinary(): Promise<string> };
  return launcher.ensureBinary();
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(bin, args, { cwd: REPO, env, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", fail);
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`qorescan ${args[0]} exited with ${code}`))));
  });
}

async function latestHeight(): Promise<string> {
  const r = await fetch(`https://${REST_HOST}/cosmos/base/tendermint/v1beta1/blocks/latest`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`latest block: HTTP ${r.status}`);
  const j = (await r.json()) as { block?: { header?: { height?: string } }; sdk_block?: { header?: { height?: string } } };
  const h = j.sdk_block?.header?.height ?? j.block?.header?.height;
  if (!h) throw new Error("latest block: no height");
  return h;
}

async function main() {
  const offline = process.argv.includes("--offline");
  // The committed cbom/ holds the full scan; a contracts-only scan goes elsewhere unless told otherwise.
  const outDir = resolve(REPO, arg("--out-dir") ?? (offline ? join(tmpdir(), "vigil-cbom-offline") : "cbom"));
  mkdirSync(outDir, { recursive: true });
  const cbomPath = join(outDir, "vigil.cdx.json");
  const bin = await qorescanBinary();
  const binSha = createHash("sha256").update(readFileSync(bin)).digest("hex");

  const started = Date.now();
  let height: string | undefined;
  let pacing: { gapMs: number; writes: number; tunnels: number; seconds: number } | undefined;

  if (offline) {
    await run(bin, ["scan", "--name", "Vigil contracts", "--solidity", CONTRACTS, "--out", cbomPath]);
  } else {
    // One read for the height this scan is pinned to, then a pause, so the scanner's first request is paced too.
    height = await latestHeight();
    await new Promise((r) => setTimeout(r, GAP_MS));
    const proxy = await startThrottleProxy({ allow: [`${REST_HOST}:443`], gapMs: GAP_MS });
    try {
      const env = { ...process.env, HTTPS_PROXY: proxy.url, https_proxy: proxy.url, NO_PROXY: "", no_proxy: "" };
      const args = ["scan", "--name", "Vigil (vigil-pay-1 on qorechain-diana)", "--solidity", CONTRACTS, "--network", "testnet", "--timeout", "90s"];
      for (const a of ACCOUNTS) args.push("--address", a);
      for (const t of TLS_ENDPOINTS) args.push("--tls", t);
      await run(bin, [...args, "--out", cbomPath], env);
      if (proxy.writes() === 0) throw new Error("the scanner sent nothing through the pacing proxy, so its reads were not paced: check HTTPS_PROXY handling");
      pacing = { gapMs: GAP_MS, writes: proxy.writes(), tunnels: proxy.tunnels(), seconds: Math.round((Date.now() - started) / 1000) };
    } finally {
      await proxy.close();
    }
  }

  const rel = (p: string) => (p.startsWith(REPO) ? relative(REPO, p) : p);
  await run(bin, ["report", "--framework", "nis", "--cbom", cbomPath, "--out", join(outDir, "vigil.nis.md")]);
  await run(bin, ["template", "agility", "--cbom", cbomPath, "--out", join(outDir, "agility-statement.md")]);

  const cbom = parseCbom(readFileSync(cbomPath, "utf8"));
  const gate = contractsGate(cbom);
  const record = {
    date: scanDate(cbom),
    timestamp: cbom.metadata?.timestamp,
    network: offline ? undefined : "qorechain-diana (testnet), as https://api-testnet.qore.host reports it",
    height: height === undefined ? undefined : `~${Number(height).toLocaleString("en-GB")}`,
    qorescan: { package: "@qorechain/qorescan@0.1.0", binarySha256: binSha },
    contracts: CONTRACTS,
    accounts: offline ? [] : [...ACCOUNTS],
    tls: offline ? [] : [...TLS_ENDPOINTS],
    pacing,
    contractsGate: { ok: gate.ok, files: gate.files, violations: gate.violations.length },
  };
  writeFileSync(join(outDir, "scan.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote vigil.cdx.json, vigil.nis.md, agility-statement.md and scan.json in ${rel(outDir)}`);
  if (pacing) console.log(`paced: ${pacing.writes} writes through ${pacing.tunnels} tunnel(s) in ${pacing.seconds} s`);
  console.log(`contracts gate: ${gate.ok ? "pass" : "FAIL"} (${gate.files} Solidity files, ${gate.violations.length} classical signature uses)`);
  if (!gate.ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
