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

A challenge is then signed locally and sent with one broadcast that returns after CheckTx. It does not wait for the block. A broadcast that hangs is abandoned after 30 s, so it cannot block the sends queued behind it.

**When a batch is given up.** Only on what the chain shows:
- the challenge was upheld;
- the batch is no longer `submitted` (rejected, finalized, or replaced by another batch at the same index);
- `checkQledgerFraud` says the chain would refuse the proof.

Everything else is transient and is retried with backoff (2 s doubling to 60 s) for as long as the batch can still be challenged:
- network errors;
- CheckTx refusals such as insufficient funds (a top-up lets the next attempt through);
- a send that is not confirmed.

A challenge that runs out of gas is simulated with the node's simulate endpoint to learn the gas it really needs, and is sent again with that, because a failed delivery still pays its whole fee.

**What a verdict belongs to.** Every field a batch publishes: index, previous root, inbox range, state root, withdrawals root and data hash. An index is reused after an upheld challenge, and a batch can repeat an honest state root with a forged withdrawals root, so neither may inherit an earlier verdict.

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
| `--attest-exits` | `WATCHTOWER_EXIT_VAULT` | off | Sign instant exits for this `InstantExitVault` (needs `challenge` mode) |
| `--exit-max-claims` | `WATCHTOWER_EXIT_MAX_CLAIMS` | `4` | A batch with more exit-eligible withdrawals is not attested; its exits are paid at finality |
| `--exit-posts-per-day` | `WATCHTOWER_EXIT_POSTS_PER_DAY` | `12` | Attestation posts in any 24 h |
| `--exit-reserve` | `WATCHTOWER_EXIT_RESERVE` | `5000000` | Never attest below this balance (uqor), so attesting never spends the challenge budget |

**Instant exits.** The watchtower attests a batch only when it and every unfinalized batch before it are valid. A valid child of a batch that is wrong only in its withdrawals root is not enough: when the parent's challenge is upheld, the chain removes the child too, and the same withdrawal would return under a new batch as a "new" exit. Each claim is its own inbox post, because the chain refuses qledger posts over 6,144 bytes after taking the fee.

**The archive.** If a kill or a full disk tears the last line, it is dropped on load and that entry is fetched again. Damage anywhere else is refused.

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
