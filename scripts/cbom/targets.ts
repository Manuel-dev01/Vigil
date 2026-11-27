/** What `pnpm cbom:scan` points QoreScan at. */

/** The node's REST endpoint, read through the pacing proxy. */
export const REST_HOST = "api-testnet.qore.host";

/** The Solidity sources of the deployed contracts (forge-std and the tests are not Vigil contracts). */
export const CONTRACTS = "contracts/src";

/** The ten L1 accounts in the README's address table. The three EVM contracts are covered by the Solidity scan. */
export const ACCOUNTS = [
  "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s", // rollup creator and sequencer (Keel); registered drill account
  "qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft", // standby sequencer (keel-b)
  "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd", // watchtower-2
  "qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33", // watchtower-3
  "qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l", // keep-alive poster
  "qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6", // EVM deployer
  "qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn", // exit relayer
  "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws", // employer-1 (sealed payroll demo)
  "qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv", // first deployer (PQGuardVault, 17 Nov)
  "qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m", // watchtower-1 (retired)
] as const;

/** The web app's host, the node's websocket and EVM endpoints the page reads, and the REST endpoint our services read. */
export const TLS_ENDPOINTS = ["vigil-pq.up.railway.app:443", "rpc-testnet.qore.host:443", "evm-testnet.qore.host:443", `${REST_HOST}:443`] as const;
