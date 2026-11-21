/**
 * qledger-v1 differential fuzzing: case generator (seeded, reproducible).
 *
 * Each case is a short rollup history: a few batches of inbox entries (deposits,
 * transfers, withdrawals), mostly valid, with mutations from known divergence
 * families. The runner (diff.ts) feeds every case to each RDK implementation and
 * compares state roots, withdrawals roots and withdrawals.
 *
 *   tsx gen.ts --seed 1 --count 2000 > cases.jsonl
 *
 * The first case of every file is the qledger batch from qorechain-rdk's own fixture
 * (packages/_fixtures/v328.json), read from RDK_REPO (default: the checkout setup.sh makes).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  QLEDGER_WITHDRAWAL_COUNTER_ID,
  bytesToHex,
  encodeQledgerDeposit,
  encodeQledgerTx,
  qledgerKeypairFromSeed,
  signQledgerTx,
} from "@qorechain/rdk";

const args = process.argv.slice(2);
const opt = (f: string, d: string) => (args.includes(f) ? args[args.indexOf(f) + 1]! : d);
const SEED = Number(opt("--seed", "1"));
const COUNT = Number(opt("--count", "500"));
const CHAIN = "qorechain-diana";
const ROLLUP = "fuzz-rollup";
const U64 = (1n << 64n) - 1n;

// mulberry32
let s = SEED >>> 0;
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n: number) => Math.floor(rnd() * n);
const pick = <T>(a: readonly T[]): T => a[int(a.length)]!;
const chance = (p: number) => rnd() < p;
const randBytes = (n: number) => Uint8Array.from({ length: n }, () => int(256));

const KEYS = Array.from({ length: 4 }, (_, i) => qledgerKeypairFromSeed(createHash("sha256").update(`vigil-fuzz/${i}`).digest()));
const RECIPIENTS = [
  "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s",
  "qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k",
  "qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry",
];

/** Recipient strings around the canonical-address rule, all 1..90 bytes so they can be signed. */
function recipientVariant(): string {
  const r = pick(RECIPIENTS);
  return pick([
    r,
    r.toUpperCase(),
    r[0]!.toUpperCase() + r.slice(1),
    r.slice(0, -1) + (r.endsWith("s") ? "q" : "s"), // bad checksum
    "cosmos" + r.slice(3), // other HRP, bad checksum
    r + " ",
    " " + r,
    r.slice(0, 20),
    "qor1",
    "x",
    r + r.slice(4, 4 + Math.max(1, 90 - r.length)), // up to 90 bytes
    "qor1" + "q".repeat(86),
    "qör1" + r.slice(4), // non-ASCII
    r.replace("qor1", "QOR1"),
  ]);
}

type Entry = { height: number; poster: string; payload: string };
let height = 1000;
const poster = () => pick(["qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry", "qor1u7tkkkd56h27lcl3qgzzcavaukuj74mjvxqf9d"]);

function deposit(account: Uint8Array, amount: bigint, posterOverride?: string): Entry {
  return { height: height++, poster: posterOverride ?? QLEDGER_DEPOSIT_POSTER_PREFIX + poster(), payload: bytesToHex(encodeQledgerDeposit(account, amount)) };
}

function signed(k: (typeof KEYS)[number], nonce: bigint, amount: bigint, target: { to: Uint8Array } | { recipient: string }, chainId = CHAIN, rollupId = ROLLUP): Uint8Array {
  return encodeQledgerTx(signQledgerTx({ chainId, rollupId, secretKey: k.secretKey, publicKey: k.publicKey, nonce, amount, ...target }));
}

/** Byte-level mutations of a posted payload. */
function mutate(p: Uint8Array): { family: string; bytes: Uint8Array } {
  const b = p.slice();
  switch (int(6)) {
    case 0: {
      const i = int(b.length);
      b[i] = b[i]! ^ (1 << int(8));
      return { family: "bitflip", bytes: b };
    }
    case 1:
      return { family: "truncate", bytes: b.slice(0, int(b.length)) };
    case 2:
      return { family: "extend", bytes: Uint8Array.from([...b, ...randBytes(1 + int(8))]) };
    case 3: {
      // flip a bit near the end (signature region)
      const i = b.length - 1 - int(Math.min(64, b.length));
      b[i] = b[i]! ^ 1;
      return { family: "sigflip", bytes: b };
    }
    case 4: {
      // flip a bit in the header / nonce / amount region
      const i = int(Math.min(48, b.length));
      b[i] = b[i]! ^ (1 << int(8));
      return { family: "headflip", bytes: b };
    }
    default:
      return { family: "random", bytes: randBytes(int(200)) };
  }
}

interface Case { id: string; chainId: string; rollupId: string; families: string[]; batches: { entries: Entry[] }[] }

function genCase(n: number): Case {
  const families = new Set<string>();
  const bal = KEYS.map(() => 0n);
  const nonce = KEYS.map(() => 0n);
  const batches: { entries: Entry[] }[] = [];
  const nb = 1 + int(3);
  for (let bi = 0; bi < nb; bi++) {
    const entries: Entry[] = [];
    const ne = 1 + int(8);
    for (let e = 0; e < ne; e++) {
      const k = int(KEYS.length);
      const op = int(100);
      if (op < 25 || bal[k] === 0n) {
        // deposit, sometimes at the edges
        const amount = chance(0.1) ? pick([0n, 1n, U64, U64 - bal[k]!, U64 - bal[k]! + 1n]) : BigInt(1 + int(1_000_000_000));
        let account = KEYS[k]!.accountId;
        if (chance(0.05)) {
          account = QLEDGER_WITHDRAWAL_COUNTER_ID;
          families.add("deposit-to-counter");
        }
        if (chance(0.05)) {
          families.add("deposit-poster-variant");
          entries.push(deposit(account, amount & U64, pick(["deposit:", "Deposit:" + poster(), "deposit: " + poster(), poster()])));
        } else if (chance(0.04)) {
          families.add("deposit-malformed");
          const d = encodeQledgerDeposit(account, amount & U64);
          entries.push({ height: height++, poster: QLEDGER_DEPOSIT_POSTER_PREFIX + poster(), payload: bytesToHex(mutate(d).bytes) });
        } else {
          if (amount > U64 || amount < 0n) continue;
          if (amount === 0n || amount === U64 || bal[k]! + amount > U64) families.add("deposit-edge");
          entries.push(deposit(account, amount));
          if (account === KEYS[k]!.accountId && bal[k]! + amount <= U64) bal[k] = bal[k]! + amount;
        }
        continue;
      }
      const isWithdraw = op >= 70;
      let amount = BigInt(1 + int(Number(bal[k]! > 1_000_000n ? 1_000_000n : bal[k]!)));
      if (chance(0.12)) {
        amount = pick([0n, bal[k]!, bal[k]! + 1n, U64, 1n]);
        families.add("amount-edge");
      }
      let nn = nonce[k]!;
      if (chance(0.08)) {
        nn = pick([nn + 1n, nn > 0n ? nn - 1n : U64, U64]);
        families.add("nonce-edge");
      }
      let target: { to: Uint8Array } | { recipient: string };
      if (isWithdraw) {
        const r = chance(0.3) ? recipientVariant() : pick(RECIPIENTS);
        if (!RECIPIENTS.includes(r)) families.add("recipient-variant");
        target = { recipient: r };
      } else {
        const t = int(10);
        const to = t === 0 ? QLEDGER_WITHDRAWAL_COUNTER_ID : t === 1 ? KEYS[k]!.accountId : t === 2 ? randBytes(32) : KEYS[(k + 1 + int(KEYS.length - 1)) % KEYS.length]!.accountId;
        if (t <= 2) families.add(["to-counter", "self-transfer", "to-unknown"][t]!);
        target = { to };
      }
      let chainId = CHAIN;
      let rollupId = ROLLUP;
      if (chance(0.04)) {
        families.add("wrong-domain");
        if (chance(0.5)) chainId = "qorechain-vladi";
        else rollupId = ROLLUP + "x";
      }
      let payload = signed(KEYS[k]!, nn, amount & U64, target, chainId, rollupId);
      if (chance(0.15)) {
        const m = mutate(payload);
        families.add("mut-" + m.family);
        payload = m.bytes;
      } else if (nn === nonce[k] && chainId === CHAIN && rollupId === ROLLUP && amount > 0n && amount <= bal[k]!) {
        // likely applied: track the model so later txs stay mostly valid
        nonce[k] = nn + 1n;
        bal[k] = bal[k]! - amount;
        if ("to" in target) {
          const j = KEYS.findIndex((x) => bytesToHex(x.accountId) === bytesToHex(target.to));
          if (j >= 0) bal[j] = bal[j]! + amount;
        }
      }
      if (chance(0.03)) families.add("non-deposit-poster-with-deposit-payload");
      entries.push({ height: height++, poster: poster(), payload: bytesToHex(payload) });
    }
    if (chance(0.05)) {
      families.add("empty-or-huge");
      entries.push({ height: height++, poster: poster(), payload: chance(0.5) ? "" : bytesToHex(randBytes(6 * 1024)) });
    }
    batches.push({ entries });
  }
  return { id: `s${SEED}-${n}`, chainId: CHAIN, rollupId: ROLLUP, families: [...families], batches };
}

// Seed corpus: the upstream fixture's real qledger batch.
const fx = (() => {
  try {
    const repo = process.env.RDK_REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), "build/qorechain-rdk");
    return JSON.parse(readFileSync(resolve(repo, "packages/_fixtures/v328.json"), "utf8")).qledger;
  } catch {
    return undefined;
  }
})();
if (fx) {
  process.stdout.write(
    JSON.stringify({
      id: "fixture-v328",
      chainId: fx.chainId,
      rollupId: fx.rollupId,
      families: ["fixture"],
      batches: [{ entries: fx.entries.map((e: { height: number; poster: string; payload: string }) => ({ height: e.height, poster: e.poster, payload: e.payload.replace(/^0x/, "") })) }],
    }) + "\n",
  );
}
for (let i = 0; i < COUNT; i++) process.stdout.write(JSON.stringify(genCase(i)) + "\n");
