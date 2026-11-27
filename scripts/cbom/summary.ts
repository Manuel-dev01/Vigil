/**
 * A Markdown summary of a QoreScan CBOM, and what changed since another one.
 *
 *   pnpm cbom:summary <cbom.json> [--against cbom/vigil.cdx.json]
 */
import { readFileSync } from "node:fs";
import { parseCbom, summaryMarkdown } from "./lib.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: pnpm cbom:summary <cbom.json> [--against <cbom.json>]");
  process.exit(2);
}
const i = process.argv.indexOf("--against");
const against = i > 0 ? process.argv[i + 1] : undefined;
const load = (p: string) => parseCbom(readFileSync(p, "utf8"));
process.stdout.write(summaryMarkdown(load(file), against ? load(against) : undefined));
