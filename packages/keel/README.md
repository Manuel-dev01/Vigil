# Keel: the vigil-pay-1 sequencer

Keel sequences Vigil's qledger-v1 based rollup. It runs as the rollup's creator, so every batch it submits is anchored in the same transaction by an ML-DSA-87 signature. That anchor is what makes settlement receipts possible.

## What one pass does

1. Reads the rollup's inbox. If nothing is waiting, it stops there.
2. Brings the local ledger up to the chain's latest batch. Any batch it has not seen is re-executed and checked root by root. On a based rollup any bonded submitter may post, so Keel never assumes the last batch was its own.
3. Plans the next batch with `planQledgerBatch` from `@qorechain/rdk`. This applies the chain's admission rules, then fetches, checks and re-executes the entries.
4. Signs the batch's v2 anchor bytes (`anchorSignBytesForBatch`) with the creator's registered ML-DSA-87 key.
5. Simulates the `MsgSubmitBatch`.
6. Sends it hybrid-signed (secp256k1 + ML-DSA-87). The creator account never opens an EVM window.
7. Saves the new ledger to `data/keel/<rollup>/ledger.json`. The `data/` folder is gitignored, and the snapshot is a cache that is re-checked against the chain on every start.

Keel refuses to start in these cases:
- the key is not the rollup's creator;
- the key is not the account's registered ML-DSA-87 key;
- the bond is below the chain minimum;
- an EVM window is open;
- another Keel holds the lock.

It stops, and does not build on top, if a published batch does not reproduce.

## Run

```sh
pnpm --filter @vigil/keel start -- --env <creator .env> [--rollup vigil-pay-1] [--interval 6] [--dry-run] [--once]
```

- Logs are JSON lines, one per event: `start`, `state_ready`, `batch_replayed`, `batch_submitted`, `heartbeat`, `pass_failed` and `fatal`.
- `data/keel/<rollup>/status.json` holds the latest pass.
- `--dry-run` plans and simulates batches but never sends one.

Helpers:

```sh
pnpm --filter @vigil/keel l2-key -- new --out <file>   # a qledger-v1 (ML-DSA-44) account key, written 0600
pnpm --filter @vigil/keel deposit -- --env <depositor .env> --amount 1 --key <file> [--broadcast]
pnpm --filter @vigil/keel send -- --env <poster .env> --key <l2 key> --amount 0.5 (--to-key <l2 key> | --to <account id> | --withdraw-to <qor1…>) [--broadcast]
pnpm --filter @vigil/keel claim -- --env <submitter .env> [--batch N] [--broadcast]
```

- **`send`** signs a qledger transfer or withdrawal with the L2 key and posts it to the inbox.
  - The nonce and balance come from the chain: the state after the latest batch plus every entry not yet batched.
  - It refuses any transaction the rollup would skip, before it costs a post fee.
- **`claim`** executes the withdrawals of finalized batches on L1.
  - It recomputes them by replaying the rollup, with every root checked.
  - Each proof is the qledger sibling path. `test/withdrawal-proof.test.ts` checks these paths against `vigil-1`'s recorded withdrawals.

## Tests

`packages/keel/test/snapshot.test.ts` rebuilds `vigil-1`'s state from recorded chain data (29 batches). It checks that the snapshot reloads to the chain's final root and that a tampered snapshot is refused.
