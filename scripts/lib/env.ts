/** Load `.env.<role>` from the repo root without printing it. Values stay in memory only. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function loadRoleEnv(role: string): Record<string, string> {
  const text = readFileSync(resolve(REPO_ROOT, `.env.${role}`), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function requireVar(env: Record<string, string>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing ${key}`);
  return v;
}
