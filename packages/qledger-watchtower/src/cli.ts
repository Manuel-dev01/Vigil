#!/usr/bin/env tsx
/**
 * vigil-watchtower: re-execute every batch of one or all qledger-v1 rollups on
 * QoreChain from chain data, keep a data-availability archive, write a status
 * feed, and (in challenge mode) challenge wrong batches inside their window.
 *
 *   tsx src/cli.ts --rollup vigil-pay-1 --once                 # observe, one pass
 *   tsx src/cli.ts --rollup all --interval 10                   # observe every qledger rollup
 *   tsx src/cli.ts --rollup vigil-pay-1 --mode challenge        # needs WATCHTOWER_MNEMONIC
 *
 * Options: --data <dir> (default ./data/watchtower), --interval <seconds> (default 10).
 * Exit code with --once: 0 all valid, 2 an invalid batch was found.
 * Logs are JSON lines on stdout. Secrets are read from the environment only and never logged.
 */
import "@vigil/core/net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRdkClient } from "@qorechain/rdk";
import { InboxArchive } from "./archive.ts";
import { accountFromMnemonic, sendChallenge } from "./challenger.ts";
import { RollupTracker, chainSource } from "./tracker.ts";

const args = process.argv.slice(2);
const opt = (f: string, d?: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const rollupArg = opt("--rollup", "all")!;
const mode = opt("--mode", "observe")!;
const once = args.includes("--once");
const intervalMs = Number(opt("--interval", "10")) * 1000;
const dataDir = resolve(opt("--data", "./data/watchtower")!);
if (!["observe", "challenge"].includes(mode)) throw new Error(`unknown --mode ${mode}`);
mkdirSync(dataDir, { recursive: true });

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

const rdk = createRdkClient({ network: "testnet" });
const chainId = rdk.network.chainId;
const ep = { chainId, rest: rdk.network.endpoints.rest, rpc: rdk.network.endpoints.rpc };

const account = mode === "challenge"
  ? await accountFromMnemonic(process.env.WATCHTOWER_MNEMONIC ?? (() => { throw new Error("challenge mode needs WATCHTOWER_MNEMONIC"); })())
  : undefined;

const challengedPath = join(dataDir, "challenged.json");
const challenged = new Set<string>(existsSync(challengedPath) ? (JSON.parse(readFileSync(challengedPath, "utf8")) as string[]) : []);

const trackers = new Map<string, RollupTracker>();
async function rollupIds(): Promise<string[]> {
  if (rollupArg !== "all") return rollupArg.split(",");
  return (await rdk.rest.listRollups()).filter((r) => r.executionVm === "qledger-v1" && r.status !== "stopped").map((r) => r.rollupId);
}

let sawInvalid = false;
async function pass(): Promise<void> {
  const tip = await rdk.getChainTip();
  for (const rollupId of await rollupIds()) {
    let t = trackers.get(rollupId);
    if (!t) {
      const env = { chainId, rollupId };
      t = new RollupTracker(env, chainSource(rdk.rest, env, ep.rest), new InboxArchive(env, join(dataDir, `${rollupId}.inbox.jsonl`)));
      trackers.set(rollupId, t);
      log("watch", { rollupId, archived: t.archive.head });
    }
    let tracked;
    try {
      tracked = await t.sync();
    } catch (e) {
      log("error", { rollupId, message: (e as Error).message });
      continue;
    }
    const summary = tracked.map(({ batch, judgement }) => ({ index: batch.batchIndex, status: batch.status, inboxEnd: batch.inboxEnd, verdict: judgement.kind }));
    writeFileSync(join(dataDir, `${rollupId}.status.json`), JSON.stringify({ rollupId, height: tip.height, checkedAt: new Date().toISOString(), archived: t.archive.head, batches: summary }, null, 2) + "\n");
    const bad = tracked.filter(({ judgement }) => judgement.kind === "invalid" || judgement.kind === "descends-from-invalid");
    log("pass", { rollupId, height: tip.height, batches: tracked.length, valid: tracked.length - bad.length, invalid: bad.length, unknown: tracked.filter((x) => x.judgement.kind === "unknown-parent").length });

    for (const { batch, judgement } of bad) {
      sawInvalid = true;
      const id = `${rollupId}:${batch.batchIndex}:${batch.stateRoot}`;
      log("invalid", { rollupId, batch: batch.batchIndex, status: batch.status, judgement });
      if (mode !== "challenge" || judgement.kind !== "invalid" || batch.status !== "submitted" || challenged.has(id)) continue;
      const c = t.challenge(batch);
      if (!c.wins) {
        log("challenge-refused", { rollupId, batch: batch.batchIndex, reason: "checkQledgerFraud says the chain would not uphold it" });
        continue;
      }
      try {
        const res = await sendChallenge(account!, rollupId, c, ep);
        log("challenge-sent", { rollupId, batch: batch.batchIndex, tx: res.transactionHash, height: res.height, code: res.code, proofBytes: c.proof.length });
        if (res.code === 0) {
          challenged.add(id);
          writeFileSync(challengedPath, JSON.stringify([...challenged], null, 2));
        }
      } catch (e) {
        log("challenge-failed", { rollupId, batch: batch.batchIndex, message: (e as Error).message });
      }
    }
  }
}

log("start", { mode, rollup: rollupArg, dataDir, watchtower: account?.cosmos });
for (;;) {
  try {
    await pass();
  } catch (e) {
    log("error", { message: (e as Error).message });
  }
  if (once) process.exit(sawInvalid ? 2 : 0);
  await new Promise((r) => setTimeout(r, intervalMs));
}
