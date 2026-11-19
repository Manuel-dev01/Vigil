/**
 * Package the built app for a static host: deploy/out/{Dockerfile, Caddyfile, site/}.
 *
 *   pnpm --filter @vigil/web build && node apps/web/deploy/package-site.mjs
 *   railway up apps/web/deploy/out --path-as-root --service <web>
 *
 * site/version.json records the commit, the build time, the descriptor
 * snapshot's hash and the SHA-256 of every served file, so anyone can check
 * that the live site is this repository at that commit. Source maps are left out.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(web, "..", "..");
const out = join(here, "out");
const site = join(out, "site");

const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo, encoding: "utf8" }).trim();
if (dirty) throw new Error(`refusing to package a build from a modified tree:\n${dirty}`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

rmSync(out, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(join(web, "dist"), site, { recursive: true, filter: (p) => !p.endsWith(".map") });
for (const f of ["Dockerfile", "Caddyfile"]) copyFileSync(join(here, f), join(out, f));

const files = {};
const walk = (d) => {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(site, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
};
walk(site);
const descriptors = JSON.parse(readFileSync(join(repo, "packages", "chain-ws", "descriptors", "qorechain-diana.json"), "utf8"));
writeFileSync(
  join(site, "version.json"),
  JSON.stringify(
    {
      repo: "https://github.com/Manuel-dev01/Vigil",
      commit,
      builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      build: "pnpm --filter @vigil/web build && node apps/web/deploy/package-site.mjs",
      descriptors: { sha256: descriptors.sha256, height: descriptors.height },
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(`packaged ${Object.keys(files).length} files from ${commit.slice(0, 7)} into ${relative(repo, out)}`);
