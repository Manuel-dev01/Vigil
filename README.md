# Vigil

**A payments rollup built to survive Q-Day.** Vigil is a qledger-v1 based optimistic rollup on the QoreChain testnet (`qorechain-diana`). Every batch is anchored with an ML-DSA-87 signature. Watchtowers re-execute every batch and sign post-quantum checkpoints. Confidential payment data travels as ML-KEM-1024 envelopes inside the same inbox the rollup commits to.

> Built for **Build Before Q-Day**, the QoreChain Developer Fest (category: Protocol Builders). **Testnet only.** Work in progress: nothing below is claimed as live until it has a row in [EVIDENCE.md](EVIDENCE.md).

## Status

| Piece | State |
|---|---|
| Inbox replay matches on-chain roots (watchtower seed) | **12 of 12** live batches on two rollups reproduced (read-only: `scripts/spike-a-replay.ts`, offline test in `scripts/test/`) |
| `pqcVerify` / `pqcKeyStatus` probed via `eth_call` | Done (read-only): FIPS 204 pure ML-DSA-87, empty context; ~312k gas per direct call (`scripts/spike-b-pqcverify.ts`) |
| Q-Day Drill vault (`PQGuardVault`) | Deployed at `0x40b6b90d69b4a6e2277583ff7d98912c03255591`, 25 QOR, accepts a real ML-DSA-87 signature via `pqcVerify` (EVIDENCE rows 1 to 8); 21 Foundry tests |
| Our rollup `vigil-pay-1` (qledger-v1, based, optimistic) | Created and bonded 19 Nov (EVIDENCE 13 and 14). Our sequencer Keel (`packages/keel`) has batched a deposit, a transfer and a withdrawal (batches 0 to 2, all finalized; EVIDENCE 15 to 20). Keel now runs hosted, always on, and submitted batch 3 unattended (EVIDENCE 22 and 23) |
| Anchored batches and settlement receipts | `vigil-pay-1` batches 0 to 3: each anchored in its submission tx by ML-DSA-87; replay matches; settlement receipts valid with a live client (EVIDENCE 16, 18, 20, 23; `receipts/vigil-pay-1/`) |
| Withdrawals | One L2 withdrawal (0.25 QOR) committed in batch 2 and executed on L1 with its qledger proof once final; a second claim is refused (EVIDENCE 19 to 21) |
| qledger-v1 watchtower, fraud challenge | Watchtower (`packages/qledger-watchtower`) runs in challenge mode on `vigil-pay-1` from two keys in two Railway regions, watchtower-2 (US West, primary) and watchtower-3 (EU West, 3 s backup), each following new batches over the chain websocket (EVIDENCE 24 to 27, 46 to 47). Its first live pass found 44 of 44 batches valid on four rollups (read-only check). Fraud drill 1 was upheld on chain and the bond slashed, but another team's watcher won the race; ours challenged 4 blocks later (EVIDENCE 39 to 45), which led to the fast path |
| ML-KEM-1024 sealed data lane | First sealed payslip posted into `vigil-pay-1` (`packages/sealed`): QoreSeal hybrid envelope, recipients' ML-DSA-87 and ML-KEM-1024 keys registered on chain, opened by its three recipients and by no one else, and covered by a data receipt against batch 5 (EVIDENCE 28 to 38) |
| Threat model | [v0](THREAT_MODEL.md) |

## Layout

```
packages/core                shared config, accounts, chain clients, evidence logger
packages/qledger-watchtower  replay, validator, fraud proofs, challenger, DA archive
packages/keel                sequencer
packages/relay               gasless poster and withdrawal claimer
packages/attest              pq-light-client checkpoints
packages/sealed              QoreSeal envelopes, KEM registration, data receipts
packages/receipts            settlement and data receipts (CLI and library)
contracts/                   Foundry contracts and tests
apps/web                     wallet, explorer, receipt verifier, payroll
scripts/                     spikes, end-to-end and drill scripts
test/vectors/                recorded chain data and shared vectors
```

## Develop

Requires Node 20+ and pnpm. Foundry for `contracts/`.

```bash
pnpm install
pnpm test
```

## Built with

QoreChain kits (credited as they land in the code):
- [`@qorechain/rdk`](https://www.npmjs.com/package/@qorechain/rdk): Rollup Development Kit
- QoreSeal: ML-KEM-1024 envelopes and the KEM registry
- qorechain-pqc: post-quantum primitives
- [`@qorechain/sdk`](https://www.npmjs.com/package/@qorechain/sdk): chain SDK
- QoreSign: hybrid signing
- `@qorechain/pq-light-client`: ML-DSA-87 checkpoint format and verifier

## Licence

Apache-2.0. See [LICENSE](LICENSE).
