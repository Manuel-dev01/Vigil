#!/usr/bin/env tsx
/**
 * vigil-sentinel: watches Vigil from the outside and tells a human on Telegram when something needs
 * attention. It holds no key and sends no transaction: every check is a read of the chain (see
 * rules.ts for what it alerts on). A condition is announced once when it starts and once when it
 * clears; a summary goes out once a day at 08:00 UTC.
 *
 *   tsx src/main.ts --once          # one check, printed (no Telegram unless configured)
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN    the bot's token (secret). Without it, alerts go to the log only.
 *   TELEGRAM_CHAT_ID      optional; otherwise the chat of whoever last pressed Start on the bot
 *   SENTINEL_INTERVAL     seconds between checks (default 60)
 *   EXIT_PAYOUTS          optional: the payouts the exit relayer is configured with (comma list, qor1… or
 *                         0x…), so their exits are watched too; announced ones are found in the inbox
 */
import "@vigil/core/net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bech32ToHex } from "@qorechain/rdk";
import { getAddress, type Hex } from "viem";
import { observer, type Memory } from "./observe.ts";
import { ACCOUNTS } from "./accounts.ts";
import { DEFAULT_THRESHOLDS, diff, evaluate, formatAlert, formatCleared, repeats, unseen, type Condition } from "./rules.ts";
import { telegram } from "./telegram.ts";

const args = process.argv.slice(2);
const once = args.includes("--once");
const intervalSec = Number(process.env["SENTINEL_INTERVAL"] ?? "60");
if (!Number.isInteger(intervalSec) || intervalSec < 15) throw new Error(`SENTINEL_INTERVAL must be a whole number >= 15, not ${process.env["SENTINEL_INTERVAL"]}`);
const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

function vaultAddress(): Hex {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, "../../../deployments/diana.json"), resolve(process.cwd(), "deployments/diana.json")]) {
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, "utf8")) as { InstantExitVault?: { address: Hex } };
      if (d.InstantExitVault) return d.InstantExitVault.address;
    }
  }
  throw new Error("no InstantExitVault in deployments/diana.json");
}

const payouts = (process.env["EXIT_PAYOUTS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((a) => (a.startsWith("qor1") ? getAddress(bech32ToHex(a)) : getAddress(a)).toLowerCase());
const observe = observer({ rollupId: "vigil-pay-1", vault: vaultAddress(), webUrl: "https://vigil-pq.up.railway.app", accounts: ACCOUNTS, payouts, log });
const notify = await telegram(process.env["TELEGRAM_BOT_TOKEN"], process.env["TELEGRAM_CHAT_ID"], log);
const say = async (text: string) => {
  log("message", { text });
  await notify.send(text).catch((e) => log("telegram-failed", { message: (e as Error).message }));
};

const mem: Memory = { windowSince: new Map() };
const active = new Map<string, Condition>();
/** When each active condition was last said (unix seconds), for the ones that repeat. */
const lastSaid = new Map<string, number>();
let lastSummaryDay = "";
let failures = 0;

function summary(o: Awaited<ReturnType<typeof observe>>): string {
  const q = (u: bigint | undefined) => (u === undefined ? "?" : `${(Number(u) / 1e6).toFixed(2)}`);
  const lines = ACCOUNTS.map((a) => `• ${a.name}: ${q(o.balances[a.qor1])} QOR${o.windows[a.qor1]?.found ? " (window open)" : ""}`);
  return [
    `🛰 Vigil daily summary (${new Date(o.now * 1000).toISOString().slice(0, 16)} UTC)`,
    `vigil-pay-1: inbox ${o.rollup.inboxHead}, batched through ${o.rollup.batchedThrough}; newest batch ${Math.round((o.now - o.rollup.newestBatchAt) / 3600)} h ago`,
    `InstantExitVault: ${(Number(o.vault.liquidityWei) / 1e18).toFixed(4)} QOR liquidity, ${(Number(o.vault.totalOwedWei) / 1e18).toFixed(4)} owed`,
    `Web app: ${o.web.ok ? "up" : "DOWN"} (${o.web.detail})`,
    o.judged
      ? `Re-executed ${o.judged.length} live batches with the watchtower's core: ${o.judged.filter((v) => v.kind === "valid").length} valid, ${o.judged.filter((v) => v.kind === "invalid").length} bad, ${o.judged.filter((v) => v.kind === "unjudged").length} not judged`
      : `Batches not re-executed this check${o.judgeFailures ? ` (${o.judgeFailures.error.slice(0, 80)})` : ""}`,
    `Instant exits waiting for finality: ${(o.exits ?? []).length}, fronted ${(o.exits ?? []).filter((x) => x.fronted).length}`,
    ...lines,
    active.size ? `Open problems: ${active.size}` : "No open problems.",
  ].join("\n");
}

log("start", { accounts: ACCOUNTS.length, intervalSec, telegram: notify.enabled });
if (notify.enabled && !once) await say(`🛰 Vigil sentinel started: watching ${ACCOUNTS.length} accounts, the vigil-pay-1 sequencer (re-executing every batch), the instant-exit vault and its exits, and the web app. You will hear from me when something needs attention, and every day at 08:00 UTC.`);

for (;;) {
  try {
    const o = await observe(mem);
    failures = 0;
    const now = evaluate(o, ACCOUNTS, DEFAULT_THRESHOLDS);
    // A check that could not re-execute the batches or read an exit does not resolve their alerts.
    const { started, cleared } = diff(active, now, unseen(o));
    for (const c of started) {
      active.set(c.id, c);
      lastSaid.set(c.id, o.now);
      await say(formatAlert(c));
    }
    for (const c of cleared) {
      active.delete(c.id);
      lastSaid.delete(c.id);
      await say(formatCleared(c));
    }
    // Loud ones (an unchallenged bad batch) are said again, with fresh numbers, until they clear. One this
    // check could not see is said again as last read, and marked so.
    const fresh = new Map(now.map((c) => [c.id, c]));
    for (const c of repeats(active.values(), lastSaid, o.now)) {
      lastSaid.set(c.id, o.now);
      await say(formatAlert(fresh.get(c.id) ?? { ...c, text: `${c.text} (As last read: this check could not re-read it.)` }));
    }
    const today = new Date().toISOString().slice(0, 10);
    if (once) console.log(summary(o));
    else if (new Date().getUTCHours() >= 8 && lastSummaryDay !== today) {
      lastSummaryDay = today;
      await say(summary(o));
    }
  } catch (e) {
    failures++;
    log("check-failed", { failures, message: (e as Error).message.slice(0, 200) });
    // The chain's API itself being unreachable for 10 minutes is worth knowing about.
    if (failures === 10) await say(`⚠️ Warning: the sentinel has not been able to read the chain for ${Math.round((10 * intervalSec) / 60)} minutes (${(e as Error).message.slice(0, 120)}).`);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
