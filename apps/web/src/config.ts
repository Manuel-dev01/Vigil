/**
 * What the page is pointed at, the accounts it names and the keys it pins, plus small formatters.
 * No dependencies, so the app shell loads without the chain libraries.
 */

export const CHAIN_ID = "qorechain-diana";
export const ROLLUP = "vigil-pay-1";
/** The one public node the page reads (CometBFT websocket), and the same operator's EVM JSON-RPC endpoint. */
export const NODE_HOST = "rpc-testnet.qore.host";
export const WS_URL = `wss://${NODE_HOST}/websocket`;
export const EVM_HOST = "evm-testnet.qore.host";
export const EVM_RPC = `https://${EVM_HOST}`;
export const EXPLORER = "https://explore.qore.network";
export const REPO = "https://github.com/Manuel-dev01/Vigil";

/** Accounts the page names instead of showing a bare address. All are public in the repo's README and EVIDENCE. */
export const KNOWN: Record<string, string> = {
  qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s: "Vigil creator and sequencer (Keel)",
  qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd: "Vigil watchtower-2 (US West)",
  qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33: "Vigil watchtower-3 (EU West)",
  qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft: "Vigil standby sequencer (keel-b)",
  qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6: "Vigil EVM deployer",
  qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn: "Vigil exit relayer",
  qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l: "Vigil keep-alive pulse",
  qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws: "employer-1 (sealed payroll demo)",
  qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry: "employee-1 (sealed payroll demo)",
  qor1u7tkkkd56h27lcl3qgzzcavaukuj74mjvxqf9d: "auditor-1 (sealed payroll demo)",
  qor1fvrd7gscnq6xkmrcrdm4gzzwnv4f3lfk0ummn2: "evil submitter, fraud drill 2",
  qor1kgvdpmv87386eyp7k577r55ttx9tf5m77jwygk: "evil submitter, fraud drill 1",
  qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5: "another team's watcher",
  qor182yhsq4k9vzj5yp02hszr0zxdpfec2d4nhyfj6: "Vigil InstantExitVault",
  qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k: "team payout A",
  qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy: "exit address of team payout A",
};

/**
 * SHA-256 of the ML-DSA-87 public keys (2,592 bytes each) that sign for Vigil, pinned in the page so
 * a node that reports another key is caught. Read from /qorechain/pqc/v1/account/<qor1> on
 * 24 Nov 2026 (each registered at the height noted, possession proven).
 */
export const PINNED_KEYS: Record<string, string> = {
  // creator and sequencer, the anchor signer and the vault's LP (registered at 10,266,300)
  qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s: "d5f87e8c177c7af01905bd5500a4c6c00f9fa1c80937c66ad3a02b29b33d49f9",
  // watchtower-2 (registered at 10,364,019)
  qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd: "41ee3425efc2021fe70fe621f5b7677bfc607fd6eca70a921cd88d323b1bfe7a",
  // watchtower-3 (registered at 10,372,838)
  qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33: "f2ca62830747775b3a2dd2c3147f194c2153fa7f6d2b7f84c320899aaaaf16c7",
};

/**
 * Where the page fetches a demo reader's seal key (same origin), for the "Open as the demo reader" button.
 * The key would be published on purpose: a testnet key that opens only envelopes sealed to demo-reader
 * and cannot sign or spend. None is published yet: while this is null, the button is not shown.
 */
export const DEMO_READER_KEY_URL: string | null = null;

export const qor = (uqor: string | number | bigint): string => {
  const n = BigInt(String(uqor).replace(/uqor$/, "") || "0");
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""} QOR`;
};

export const short = (h: string | undefined, n = 8): string => {
  const s = typeof h === "string" ? h : "";
  return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
};
export const shortAddr = (a: string): string => (a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);

/** Explorer pages for L1 (Cosmos) transactions, blocks and qor1 accounts. EVM 0x hashes do not resolve there. */
export const txUrl = (hash: string): string => `${EXPLORER}/tx/${hash}`;
export const blockUrl = (height: number): string => `${EXPLORER}/block/${height}`;
export const accountUrl = (qor1: string): string => `${EXPLORER}/address/${qor1}`;

// ---- times: always UTC, always labelled

const utcStampFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const utcTimeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const utcFullFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "full", timeStyle: "long" });

/** Milliseconds as "23 Nov, 21:05:37 UTC". */
export const utcStamp = (ms: number): string => `${utcStampFmt.format(ms)} UTC`;
/** Milliseconds as "21:05:37 UTC". */
export const utcTime = (ms: number): string => `${utcTimeFmt.format(ms)} UTC`;
/** Milliseconds as a full UTC date, for tooltips. */
export const utcFull = (ms: number): string => utcFullFmt.format(ms);
/** Unix seconds as "23 Nov, 21:05:37 UTC". */
export const stamp = (unix: number): string => utcStamp(unix * 1000);

/** A span of seconds in words: "47 s", "3 min 6 s", "57 min", "1 h 10 min", "3 days". */
export function dur(sec: number): string {
  const s = Math.abs(Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

export const errText = (e: unknown): string => String(e instanceof Error ? e.message : e);

/** The RDK's REST errors carry the HTTP status (checked by shape, so a second copy of the RDK cannot break it). */
export const isNotFound = (e: unknown): boolean => (e as { status?: unknown } | undefined)?.status === 404;
