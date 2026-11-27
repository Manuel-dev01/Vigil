# Evidence check

**123 of 123 rows re-verified at height 10,859,709 (27 Nov 2026, 16:42 UTC), as the node reports.** The 6 read-only checks are listed by command below.

`pnpm evidence:check` (`scripts/evidence-check.ts`) read every numbered row of [EVIDENCE.md](https://github.com/Manuel-dev01/Vigil/blob/main/EVIDENCE.md) (sha256 `b16c7e10487bca04…`) back from the chain between 27 Nov 2026, 16:42 UTC and 16:45 UTC: `GET /cosmos/tx/v1beta1/txs/{hash}` on https://api-testnet.qore.host for native transactions and `eth_getTransactionReceipt` on https://evm-testnet.qore.host for EVM ones, one request at a time and at most one a second. No key, no transaction. This report was rebuilt from the answers saved when they were read (`--cache`), with no new reads. Full results: [docs/evidence-check.json](https://github.com/Manuel-dev01/Vigil/blob/main/docs/evidence-check.json).

A row counts as re-verified when the node returns its transaction and:
- its height is the row's, and so is its date (UTC) wherever the answer carries a time (an EVM receipt has one only in its logs, so rows 6, 60 and 83 get no date check);
- it succeeded, or failed with the code the row records;
- the events, logs, gas figures and fees listed for the row in `scripts/evidence/expect.ts` are there with the row's values (716 of 716 checks passed). A claim in a row's text that is not listed there is not checked.

It does not re-read chain state that changes over time (balances, bonds, contract records); each row's "How to re-verify" column has the command for that. It trusts the node to report the chain truthfully.

| Result | Rows |
|---|---|
| verified | 1 to 123 |
| mismatch | none |
| not found | none |
| error | none |

## Read-only checks (by command)

These rows of EVIDENCE.md have no transaction, and this check does not run them or count them as passed. Re-run them yourself; none needs a key except where noted.

| # | Date (UTC) | Height | Command | Not run here because |
|---|---|---|---|---|
| 1 | 2026-11-19 | ~10,362,910 | `cd packages/qledger-watchtower && npx tsx src/cli.ts --rollup all --once` | it replays batches from chain data, which takes far more reads than this check makes at one a second |
| 2 | 2026-11-16 | ~10,212,550 | `pnpm --filter @vigil/scripts spike:a <rollupId>; pnpm test` | it replays batches from chain data, which takes far more reads than this check makes at one a second; its offline part (`pnpm test`) runs in CI |
| 3 | 2026-11-16 | ~10,212,600 | `pnpm --filter @vigil/scripts exec tsx kit-gap-check.ts` | it replays batches from chain data, which takes far more reads than this check makes at one a second |
| 4 | 2026-11-18 | ~10,320,830 | `spike:a vigil-1; tsx scripts/receipts-snapshot.ts vigil-1` | it replays batches from chain data, which takes far more reads than this check makes at one a second |
| 5 | 2026-11-17 | ~10,241,900 | `pnpm --filter @vigil/scripts exec tsx drill/deploy-vault.ts verify` | it signs a test message, so it needs a key this check does not hold |
| 6 | 2026-11-16 | see vector | `pnpm --filter @vigil/scripts spike:b` | it is a separate probe of the PQC precompiles (calls with crafted inputs and throwaway keys), not a read-back of a transaction; left out to keep this check's requests few |
