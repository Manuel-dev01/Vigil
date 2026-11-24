# Keel: the vigil-pay-1 sequencer

Keel sequences Vigil's qledger-v1 based rollup. It runs as the rollup's creator, so every batch it submits is anchored in the same transaction by an ML-DSA-87 signature. That anchor is what makes settlement receipts possible.

## What one pass does

1. Brings the local ledger up to the chain's latest batch. Any batch it has not seen is re-executed and checked root by root. On a based rollup any bonded submitter may post, so Keel never assumes the last batch was its own. If a batch does not reproduce, or the rollup was rolled back, see "Fraud and rollback" below.
2. Reads the rollup's inbox. If nothing is waiting, it stops there.
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

## Fraud and rollback

Keel never builds on a batch it cannot reproduce. On a based rollup any bonded submitter can post one, so Keel handles it without stopping:

- **Blocked.** When a batch on chain does not reproduce, Keel stays at the batch before it, submits nothing and logs `awaiting_challenge`. It logs again with each heartbeat until the watchtower's challenge removes the batch. If the batch finalizes instead, Keel logs `fraud_finalized` and stays paused, because the rollup then needs a human.
- **Rollback.** An upheld challenge drops the bad batch and every later unfinalized batch. The inbox rolls back to the end of the last good batch (`rdk_inbox_rolled_back`), and the next batch reuses the dropped index. When the batch Keel's state ended on is gone, rejected or replaced, Keel logs `rollback`, rebuilds its ledger from the chain, and batches the rolled-back entries again.

`test/sync.test.ts` covers these cases on recorded chain data: a batch that does not reproduce, a fraud that finalized, batches dropped by a challenge, an index reused by a different batch, and rejected records left at the top. `send` refuses to post while a batch is blocked, and `claim` never reads withdrawals from a batch that does not reproduce.

## Run

```sh
pnpm --filter @vigil/keel start -- --env <creator .env> [--rollup vigil-pay-1] [--interval 6] [--dry-run] [--once]
```

- Logs are JSON lines, one per event: `start`, `state_ready`, `batch_replayed`, `batch_submitted`, `heartbeat`, `awaiting_challenge`, `unblocked`, `rollback`, `fraud_finalized`, `pass_failed` and `fatal`. Only start-up problems are fatal; a failed pass is retried.
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

## Reading the inbox, and pruning

- **How entries are read.** Keel reads inbox entries through the shared reader in `@vigil/core/inbox`: one entry per sequence, each checked against the chain's accumulator. Posts sent inside another message are read too. There is no limit on how many posts the rollup has had (the RDK's transaction search stops at 5,000).
- **How a batch is planned.** `src/plan.ts` is the RDK's `planQledgerBatch` step for step, with the same admission rules and the same check that the entries hash to the chain's inbox range commitment before anything executes. Only the reader is different.
- **Archives.**
  - Keel and keel-b keep `<KEEL_DATA_DIR>/inbox.jsonl` on their volume. On first start it is seeded from the committed `data/inbox/<rollup>.jsonl`.
  - Archived entries are used only for sequences the chain has pruned, and only after a commitment the chain still holds confirms them.
  - Refresh the committed archive at least every ten days: `pnpm --filter @vigil/scripts exec tsx inbox-archive.ts vigil-pay-1`.
- **Heartbeat.** It is logged every 10 minutes whether passes succeed or not. It carries the last outcome and error, the balance and how many entries are archived, and is logged at `error` with `stuck` after 30 minutes without a good pass.
- **Keep-alive exit codes** (`pulse.ts`): 0 done, 1 failed or refused, 2 skipped (a batch awaits a challenge, or entries are still waiting), 3 posted but not batched in time. A cron run that could not do its job shows red.
- **`claim.ts` and `l2-send.ts`** start from the newest valid snapshot in `--data`, `KEEL_DATA_DIR`, `PULSE_DATA_DIR` or `data/keel/<rollup>`, and otherwise rebuild through the archive.

## Hosting

`packages/keel/Dockerfile` builds Keel from the repo root. We run `vigil-pay-1`'s Keel from it on Railway: one instance, a volume at `/data` for the snapshot, and the creator key set as secret variables (`PRIVATE_KEY` and `QORE_PQC_RECOVERY_CODE`, read from the process environment when `--env` is not given). The image sets `KEEL_LOCK=0`, since a container has no other Keel to race. Only one Keel may hold a key, so the local copy stays stopped while the hosted one runs. `KEEL_DRY_RUN=1` pauses sending without stopping it.

## Tests

`packages/keel/test/snapshot.test.ts` rebuilds `vigil-1`'s state from recorded chain data (29 batches). It checks that the snapshot reloads to the chain's final root and that a tampered snapshot is refused.
