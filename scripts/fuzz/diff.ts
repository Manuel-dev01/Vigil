/**
 * qledger-v1 differential fuzzing: run every case through each RDK implementation
 * and report where they disagree.
 *
 *   tsx diff.ts cases.jsonl [--out report.json]
 *
 * Build the Go, Rust, Python and Java shims first with setup.sh (FUZZ_BUILD overrides
 * where they live; default scripts/fuzz/build).
 *
 * Compared per batch: state root, withdrawals root, the withdrawals list, and
 * whether execution errored (error texts differ by language, so only presence counts).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const B = process.env.FUZZ_BUILD ?? resolve(here, "build");
const casesPath = process.argv[2];
if (!casesPath) throw new Error("usage: diff.ts cases.jsonl [--out report.json]");
const outPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : `${casesPath}.report.json`;

const IMPLS: Record<string, { cmd: string; args: string[]; cwd?: string }> = {
  ts: { cmd: "npx", args: ["tsx", resolve(here, "ts-shim.ts")], cwd: resolve(here, "..") },
  go: { cmd: `${B}/go/goshim`, args: [] },
  rust: { cmd: `${B}/rust/target/release/rust-shim`, args: [] },
  py: { cmd: `${B}/py/bin/python`, args: [resolve(here, "shims/py/shim.py")] },
  java: { cmd: `${B}/java/run.sh`, args: [] },
};

const input = readFileSync(casesPath, "utf8");
const cases = input.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; families?: string[] });

function runImpl(name: string): Promise<Map<string, unknown>> {
  const { cmd, args, cwd } = IMPLS[name]!;
  return new Promise((resolveP, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      const m = new Map<string, unknown>();
      for (const l of out.split("\n").filter(Boolean)) {
        try {
          const o = JSON.parse(l) as { id: string };
          m.set(o.id, o);
        } catch {
          /* ignore */
        }
      }
      if (m.size !== cases.length) console.error(`${name}: ${m.size}/${cases.length} results (exit ${code}) ${err.slice(0, 300)}`);
      resolveP(m);
    });
    p.stdin.end(input);
  });
}

type B = { stateRoot?: string; withdrawalsRoot?: string; withdrawals?: unknown[]; error?: string };
const norm = (r: unknown): string => {
  const o = r as { batches?: B[]; error?: string } | undefined;
  if (!o) return "MISSING";
  if (o.error) return "CASE-ERROR";
  // Field order differs by language (serde sorts keys), so compare withdrawals as tuples.
  const ws = (b: B) => ((b.withdrawals ?? []) as { index: string; recipient: string; amount: string }[]).map((w) => [w.index, w.recipient, w.amount]);
  return JSON.stringify((o.batches ?? []).map((b) => (b.error ? { error: true } : { s: b.stateRoot, w: b.withdrawalsRoot, ws: ws(b) })));
};

const t0 = Date.now();
const names = Object.keys(IMPLS);
const results = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await runImpl(n)] as const)));
// Positive control: one flipped hex digit in a root, one changed withdrawal amount,
// and an error in place of a result must each change the comparison key.
{
  const sample = [...results.ts!.values()].find((r) => ((r as { batches?: B[] }).batches ?? []).some((b) => (b.withdrawals ?? []).length > 0)) as { batches: B[] } | undefined;
  if (sample) {
    const flip = JSON.parse(JSON.stringify(sample)) as { batches: B[] };
    const b0 = flip.batches[0]!;
    b0.stateRoot = (b0.stateRoot![0] === "0" ? "1" : "0") + b0.stateRoot!.slice(1);
    const amt = JSON.parse(JSON.stringify(sample)) as { batches: B[] };
    const wb = amt.batches.find((b) => (b.withdrawals ?? []).length > 0)!;
    (wb.withdrawals![0] as { amount: string }).amount += "1";
    const err = JSON.parse(JSON.stringify(sample)) as { batches: B[] };
    err.batches[0] = { error: "x", withdrawals: [] };
    if (norm(sample) === norm(flip) || norm(sample) === norm(amt) || norm(sample) === norm(err)) throw new Error("comparator self-check failed");
  }
}
const divergences: { id: string; families: string[]; groups: string[][]; detail: Record<string, unknown> }[] = [];
const byPattern = new Map<string, number>();
for (const c of cases) {
  const keyed = new Map<string, string[]>();
  for (const n of names) {
    const k = norm(results[n]!.get(c.id));
    keyed.set(k, [...(keyed.get(k) ?? []), n]);
  }
  if (keyed.size > 1) {
    const groups = [...keyed.values()].sort((a, b) => b.length - a.length);
    const pattern = groups.map((g) => g.join("+")).join(" | ");
    byPattern.set(pattern, (byPattern.get(pattern) ?? 0) + 1);
    divergences.push({ id: c.id, families: c.families ?? [], groups, detail: Object.fromEntries(names.map((n) => [n, results[n]!.get(c.id)])) });
  }
}
writeFileSync(outPath, JSON.stringify({ cases: cases.length, implementations: names, divergences }, null, 1));
console.log(`${cases.length} cases × ${names.length} implementations in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${divergences.length} divergent`);
for (const [p, n] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n} × ${p}`);
const fam = new Map<string, number>();
for (const d of divergences) for (const f of d.families) fam.set(f, (fam.get(f) ?? 0) + 1);
if (fam.size) console.log(`  families in divergent cases: ${[...fam.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", ")}`);
console.log(`report: ${outPath}`);
