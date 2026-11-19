# Vigil

**A payments rollup built to survive Q-Day.** Vigil is a qledger-v1 based optimistic rollup on the QoreChain testnet (`qorechain-diana`). Every batch is anchored with an ML-DSA-87 signature. Watchtowers re-execute every batch and sign post-quantum checkpoints. Confidential payment data travels as ML-KEM-1024 envelopes inside the same inbox the rollup commits to.

> Built for **Build Before Q-Day**, the QoreChain Developer Fest (category: Protocol Builders). **Testnet only.** Work in progress: nothing below is claimed as live until it has a row in [EVIDENCE.md](EVIDENCE.md).

## Status

| Piece | State |
|---|---|
| Inbox replay matches on-chain roots (watchtower seed) | **12 of 12** live batches on two rollups reproduced (read-only: `scripts/spike-a-replay.ts`, offline test in `scripts/test/`) |
| `pqcVerify` / `pqcKeyStatus` probed via `eth_call` | Done (read-only): FIPS 204 pure ML-DSA-87, empty context; ~312k gas per direct call (`scripts/spike-b-pqcverify.ts`) |
| Q-Day Drill vault (`PQGuardVault`) | Deployed at `0x40b6b90d69b4a6e2277583ff7d98912c03255591`, 25 QOR, accepts a real ML-DSA-87 signature via `pqcVerify` (EVIDENCE rows 1 to 8); 21 Foundry tests |
| Our rollup `vigil-pay-1` (qledger-v1, based, optimistic) | Created and bonded 19 Nov (EVIDENCE 13 and 14). Our sequencer Keel (`packages/keel`) submitted batch 0 from the first deposit (EVIDENCE 15 and 16) |
| Anchored batches and settlement receipts | `vigil-pay-1` batch 0: anchored in its submission tx by ML-DSA-87; replay matches; settlement receipt valid with a live client (EVIDENCE 16, `receipts/vigil-pay-1/`) |
| Withdrawals | not yet exercised |
| qledger-v1 watchtower, fraud challenge | not yet exercised |
| ML-KEM-1024 sealed data lane | not yet exercised |
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
