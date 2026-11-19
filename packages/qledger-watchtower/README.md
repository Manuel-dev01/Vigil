# qledger-watchtower

This package re-executes every batch of a qledger-v1 rollup from chain data. It also keeps a data-availability archive of the inbox, and in challenge mode it sends `MsgChallengeBatch` against any batch that does not reproduce. Every hash, tree and proof comes from `@qorechain/rdk`. A challenge is sent only if `checkQledgerFraud`, the RDK's copy of the chain's rule, says the chain would uphold it.

```sh
pnpm --filter @vigil/qledger-watchtower watch -- --rollup vigil-pay-1                  # observe
WATCHTOWER_MNEMONIC=… pnpm --filter @vigil/qledger-watchtower watch -- --rollup vigil-pay-1 --mode challenge
```

## Two ways a bad batch is found
- **The fast path:** `--follow ws`, the default for named rollups.
  - The node's websocket (`<rpc>/websocket`) pushes each tx that submits a batch to the rollup as soon as its block commits.
  - The batch is decoded from the tx's own `MsgSubmitBatch` (`src/fast.ts`) and judged at once. If it is wrong, the challenge goes out right away.
  - Inbox posts are pushed too, so their entries are already in the archive when a batch covers them.
- **The full pass,** every `--interval` seconds:
  - It re-reads every live batch from REST, judges it and writes `<rollup>.status.json`.
  - It catches anything the socket missed.
  - It runs every 2 s while the socket is down.

The challenger (`Challenger` in `src/challenger.ts`) gets everything ready before fraud happens:
- the account number and sequence;
- the hybrid sign-bytes form;
- an open RPC connection.

A challenge is then signed locally and sent with one broadcast that returns after CheckTx. It does not wait for the block. A challenge that runs out of gas is retried with double the gas. Each batch gets at most 3 attempts, and a batch is settled for good once the challenge is upheld, or once another challenger's challenge has already been upheld.

## Options (each one can also be set with the environment variable named)
| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--rollup` | `WATCHTOWER_ROLLUP` | `all` | Rollup ids, comma-separated, or `all` (`all` needs `--follow poll`) |
| `--mode` | `WATCHTOWER_MODE` | `observe` | `challenge` sends challenges and needs `WATCHTOWER_MNEMONIC` |
| `--interval` | `WATCHTOWER_INTERVAL` | `10` | Seconds between full passes |
| `--follow` | `WATCHTOWER_FOLLOW` | `ws` | `ws` (push) or `poll` (full passes only) |
| `--gas-price` | `WATCHTOWER_GAS_PRICE` | `0.3` | uqor per unit of gas for challenges |
| `--challenge-delay` | `WATCHTOWER_CHALLENGE_DELAY` | `0` | For a backup watchtower: wait this many seconds, then challenge only if the batch is still open |
| `--data` | `WATCHTOWER_DATA` | `./data/watchtower` | Archive, status files and settled challenges |

## Why it works this way (fraud drill 1, 19 Nov 2026)
In drill 1 the bad batch landed at height 10,370,239. Our hosted watchtower polled every 10 s, so it first saw the batch at 10,370,242. Its challenge reached block 10,370,243, the same block as the winning challenge from another team's watcher, and lost on its position within that block (gas price 0.12 against 0.15). The full timeline is in `EVIDENCE.md` rows 39–45.

Measurements taken while building the fast path:
- **Websocket:** a block arrives about 1.8 s after its header time. Blocks come about every 1.45 s.
- **Re-execution and proof building:** about 1 ms per entry (41 vigil-1 entries took about 40 ms and about 33 ms). Precomputing proofs would save milliseconds; having the entries already downloaded saves much more.
- **Gas:** the upheld drill-1 challenge (149-byte proof) used 343,412 gas. Gas is sized as `500k + 40 × proof bytes + 100k × entries`. In drill 1 we set a 2M limit and paid for all of it.

`test/fast.test.ts` uses the two real batch-6 txs of drill 1 (`test/vectors/drill-1-batch-txs.json`):
- It decodes them.
- It judges the bad one invalid against the recorded rollup.
- It checks that the fraud proof the watchtower builds is **byte for byte the one the chain upheld** (tx `1BF5B717…EBC4`).
