# Evidence ledger

Each claim Vigil makes about the chain gets one row here. A claim without a row is not a claim. All dates and times are UTC. Network is `qorechain-diana` (testnet) unless stated.

| # | Date (UTC) | Network | Height | Tx hash | Explorer | What it proves | How to re-verify |
|---|---|---|---|---|---|---|---|

## Read-only checks (no transaction)

These read the chain and send nothing, so they have a height but no tx hash. Anyone can re-run them without a key.

| Date (UTC) | Network | Height | What it shows | How to re-verify |
|---|---|---|---|---|
| 2026-11-16 | testnet | ~10,212,550 | Replaying the inbox of `rdk-v328-e2e-mwd5v89d` (batches 0 to 1) and `wicketgate-pay` (batches 0 to 9) from chain data with `executeQledger` reproduces every published prev/state/withdrawals root, `data_hash` and inbox accumulator: **12 of 12** | `pnpm --filter @vigil/scripts spike:a <rollupId>`; offline: `pnpm test` |
| 2026-11-16 | testnet | ~10,212,600 | RDK 0.9.0's `transitionRootValidator` reports all 12 of those honest qledger batches as invalid | `pnpm --filter @vigil/scripts exec tsx kit-gap-check.ts` |
| 2026-11-16 | testnet (EVM 9800) | see vector | `pqcVerify` (0x…0a01) accepts FIPS 204 pure ML-DSA-87 with an empty context, and rejects a non-empty context, the raw internal form, one flipped message bit, one flipped signature bit and a wrong key. `pqcKeyStatus` returns the RDK creator's 2,592-byte key with `possessionProven = true` | `pnpm --filter @vigil/scripts spike:b`; recorded in `test/vectors/spike-b-pqc-precompiles.json` |
