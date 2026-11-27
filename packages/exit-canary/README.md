# exit-canary

One small instant exit a day, of its own money, from its own key, so the whole exit path is exercised every day and not only when we run a demo: both watchtowers' ML-DSA-87 attestations, the relayer's `front()`, and after finality the execution on L1 and the `sweep()` that repays the vault. Each run lands in the vault's public history, so it shows up on the [Exits page](https://vigil-pq.up.railway.app/#/exits) ledger and in `docs/exits-metrics.json`.

**Status: not yet exercised.** This package is code only. No canary key exists and no canary exit has been posted. It sends nothing until the team creates its keys, funds them and runs it with `--broadcast` (below).

## What one run does

1. Reads the `InstantExitVault` (quorum, LP, fee, free liquidity) and the rollup, from the chain.
2. Loads the canary's key file and refuses any key that is not its own: every team address in the README's testnet table (the creator, keel-b, the watchtowers, the keep-alive, the relayer, both deployers, employer-1), the rollup's creator and the vault's quorum and LP as the chain reports them, and the team's two demo L2 accounts (EVIDENCE 86 and 99) as its L2 key.
3. Replays the rollup for its L2 nonce and balance, with Keel's sync and the shared inbox reader (`@vigil/keel/sync`, `@vigil/core/inbox`).
4. Refuses to post when a batch awaits a challenge, entries are waiting for the sequencer, the canary already posted twice in the last 24 hours (read from its own inbox posts, every entry up to the head; a run that cannot read them fails), or the vault cannot front the amount. It reads the chain one request at a time.
5. Builds one hybrid-signed transaction with two inbox posts:
   - a **payout notice** for its own L1 address (`encodePayoutNotice` from `@vigil/qledger-watchtower`), so the relayer knows whose exit address it is;
   - an **L2 withdrawal** of 0.01 to 0.05 QOR (default 0.02) to `exitAddressOf(its own L1 address)`, signed with ML-DSA-44 (`signQledgerTx`).

   Both are executed first on a copy of the ledger: the withdrawal must apply and pay exactly that amount to that address.
6. Checks that its ML-DSA-87 key is the registered one and that it has no EVM window, and simulates the transaction (`HybridSender` from `@vigil/keel/chain`). **A dry run stops here.**
7. With `--key` and `--broadcast`: sends it, then watches the vault's `Fronted` log for its payout for up to `--wait` seconds (read-only).

The rest is the existing machinery, unchanged: the watchtowers attest the batch's withdrawal, the relayer fronts it, and after finality executes it and sweeps the exit address back to the vault. The money returns to the canary's L1 account, less the vault's 0.5% fee. The sentinel warns if it is not fronted within 5 minutes of its batch.

There is deliberately no public "try an exit" button: anyone could use up the watchtowers' daily attestation budget with it.

```sh
pnpm --filter @vigil/exit-canary start                                         # dry run, no key: reads the vault
pnpm --filter @vigil/exit-canary start -- --key <canary key file>              # dry run: plans and simulates
pnpm --filter @vigil/exit-canary start -- --key <canary key file> --broadcast  # one exit
```

Options: `--amount <QOR>` (or `EXIT_CANARY_AMOUNT`; 0.01 to 0.05, default 0.02), `--wait <s>` (60 to 3,600, default 900), `--data <dir>` (a ledger snapshot to start the replay from).

Exit status: 0 done (a dry run planned, or posted and fronted); 1 failed or refused; 2 skipped (daily budget, a batch awaiting a challenge, the sequencer not batching); 3 posted but not fronted within `--wait`. A scheduler then shows a run that did not do its job.

## Its keys

The key file is the canary's own, written 0600 and never committed. It holds:

| Variable | Key | Made with |
|---|---|---|
| `EXIT_CANARY_MNEMONIC` (and optionally `EXIT_CANARY_QOR_ADDRESS`) | its L1 account: a unified hybrid account that posts and is the payout. Its ML-DSA-87 key must be registered | `scripts/drill/new-account.ts --role exit-canary`, then `scripts/drill/register-pqc.ts` |
| `QLEDGER_SEED_HEX` | its L2 (ML-DSA-44) account, which withdraws | `pnpm --filter @vigil/keel l2-key -- new --out <file>`, then a deposit with `pnpm --filter @vigil/keel deposit` |

One file can hold both: the `.env.exit-canary` that `new-account.ts` writes, with the `QLEDGER_SEED_HEX` line from the L2 key file added.

## Budget

- **At most 2 runs in any 24 hours, 0.05 QOR each.** Each run costs each watchtower one attestation post, within their own limits (12 posts a day, 4 claims a batch, never below their 5 QOR challenge reserve; `packages/qledger-watchtower/src/cli.ts`).
- **Fees, estimated, not yet measured for the canary:** its own post of about 3.9 KB (a withdrawal of 3,794 bytes, like inbox entries 17 and 20, plus a 68-byte notice) should cost about 0.075 QOR; a keep-alive transfer post of about 3.8 KB cost 73,480 uqor (EVIDENCE 118). The relayer pays its windows, `front()`, execution and `sweep()` (about 0.13 QOR an exit, `packages/exit-relayer/src/main.ts`).
- **Funding:** about 1 QOR on the L1 account covers two weeks of daily posts; the L2 account needs the sum of its withdrawals (0.02 QOR a day by default). Withdrawn money comes back to the L1 account.

## Hosting

`railway.json` builds `packages/exit-canary/Dockerfile` as a cron job (11:20 UTC daily, no restarts). Its start command is the dry run, so deploying it as committed sends nothing.

To make it live, once the team has approved the key and the spend, give the job its key file and both flags. Railway has no secret files, so one way is to keep the file's contents in one secret variable and write it at start:

```sh
sh -c 'umask 077 && printf "%s\n" "$EXIT_CANARY_KEY_FILE" > /tmp/canary.env && exec node --import tsx packages/exit-canary/src/main.ts --key /tmp/canary.env --broadcast'
```

Then add the canary's L1 address to the README's testnet addresses and to the sentinel's `src/accounts.ts` (no EVM window, a balance floor).
