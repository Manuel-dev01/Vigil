/** List every withdrawal a recorded qledger rollup committed (from test/vectors/replay-<id>.json). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./lib/env.ts";
import { withdrawalsByBatch } from "./lib/withdrawals.ts";
import type { ReplayVector } from "./lib/replay.ts";

const id = process.argv[2] ?? "vigil-1";
const v = JSON.parse(readFileSync(resolve(REPO_ROOT, "test/vectors", `replay-${id}.json`), "utf8")) as ReplayVector;
for (const b of withdrawalsByBatch(v)) for (const w of b.withdrawals) console.log(`batch ${b.batchIndex} index ${w.index} ${w.recipient} ${Number(w.amount) / 1e6} QOR`);
