# Vigil

[![CI](https://github.com/Manuel-dev01/Vigil/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Manuel-dev01/Vigil/actions/workflows/ci.yml)

![Vigil: a payments rollup built to survive Q-Day](docs/cover.png)

**A payments rollup built to survive Q-Day, and proven on chain.** Vigil runs `vigil-pay-1`, a qledger-v1 optimistic rollup on the QoreChain testnet (`qorechain-diana`):
- Users sign with ML-DSA-44.
- Every batch from the sequencer is anchored with an ML-DSA-87 signature.
- Two watchtowers re-execute every batch and challenge fraud on chain.
- Payslips travel sealed with ML-KEM-1024.

Anyone can check a settlement receipt in their browser or in Solidity, against the chain rather than against our word.

> **Build Before Q-Day**, QoreChain Developer Fest, category **Protocol Builders**. Testnet only. Every claim below links to a row in [EVIDENCE.md](EVIDENCE.md): a transaction hash, an explorer link and a way to re-check it yourself.

**Web app: https://vigil-pq.up.railway.app** (its landing page follows one batch from signature to final, in 3D) · [Evidence ledger](EVIDENCE.md) · [Threat model](THREAT_MODEL.md) · [AI usage](AI_USAGE.md) · [Project page](https://build.qorechain.io/p/vigil)

## Try it in a minute

1. **[Rollup](https://vigil-pq.up.railway.app/#/rollup).** `vigil-pay-1` live: its batches and their ML-DSA-87 anchors, its inbox, its bond, and the fraud caught on it. New posts and batches appear as the chain makes them.
2. **[Verify a receipt](https://vigil-pq.up.railway.app/#/verify?batch=0).**
   - Your browser rebuilds batch 0's settlement receipt from chain state and runs nine checks. These include the ML-DSA-87 signature, checked against the creator's key as the node reports it from the chain's PQ registry and against the key's hash pinned in the page, and whether the batch is final.
   - Our Solidity contract then checks the same anchor through the `pqcVerify` precompile.
   - Press **"Forge it"** to change one digit and watch it fail.
3. **[Instant exits](https://vigil-pq.up.railway.app/#/exits).** A 0.1 QOR withdrawal paid 57 minutes before its batch could be final, step by step: the L2 withdrawal, both watchtowers' ML-DSA-87 signatures (verified in your browser, and again by the chain's `pqcVerify` precompile), the payment, and the vault repaid after finality. Enter any address to get its exit address, computed in your browser and cross-checked with the vault.
4. **[Open a payslip](https://vigil-pq.up.railway.app/#/payslip).** Payslips sealed to three recipients sit in the rollup's public inbox (November's, and a fresh December one). Anyone can see that each was posted and settled; only its recipients can read it.

There is no server of ours in between: the page talks straight to a public QoreChain node over its websocket, and its files reproduce byte for byte from the commit named in `/version.json`. It does trust that node to report chain state truthfully (see [Limitations](#limitations)).

## What is proven on chain

| Claim | Evidence | Check it yourself |
|---|---|---|
| **A post-quantum rollup, running continuously on testnet since 19 Nov.** `vigil-pay-1` has over 20 batches. Each batch from the creator's sequencer is anchored in its own submission transaction by an ML-DSA-87 signature | [EVIDENCE](EVIDENCE.md) 13 to 23, 71, 76, 78 | `curl -s https://api-testnet.qore.host/qorechain/multilayer/v1/anchors/vigil-pay-1` |
| **Fraud caught by our watchtower.** In our fraud drill 2, a separate bonded key submitted a wrong batch. Watchtower-2's challenge was upheld in the very next block; the 1,000 QOR bond was slashed and 500 QOR paid to our watchtower | 51 to 56 | the web app's "Fraud caught on chain" panel |
| **Kill the sequencer.** We stopped the creator's sequencer. A bonded standby on another key, in another region, batched a user's withdrawal; both watchtowers judged it valid, and it was paid on L1 with no help from the creator | 65 to 72 | [THREAT_MODEL §7](THREAT_MODEL.md) |
| **Receipts checked in Solidity.** [`SettlementReceiptVerifier`](contracts/src/SettlementReceiptVerifier.sol) at `0xc87c7680b70e21464aac4e2308a9caa5324e4590` (no owner) rebuilds the anchor message and verifies the ML-DSA-87 signature through `pqcKeyStatus` and `pqcVerify`, at about 230k to 280k gas. It has recorded 19 of `vigil-pay-1`'s anchors, every one through layer height 19; anyone can add newer ones with `attest` | 57 to 64, 79 to 81, 110 to 113 | `cast call 0xc87c7680b70e21464aac4e2308a9caa5324e4590 "isAttested(uint64,bytes32)(bool)" 0 0x27cc24911b144e354f0154d22fbf5a9a2143655cc9763e90614b2aba6761959e --rpc-url https://evm-testnet.qore.host` |
| **Sealed payslips.** A payslip sealed with QoreSeal (ML-KEM-1024 with X25519) was posted into the rollup's inbox, opened by its three recipients and no one else, and covered by a data receipt. A second one was posted on 24 Nov so a fresh payslip is on chain after the chain prunes older posted data, and its data receipt verifies against the final batch 21 | 28 to 38, 114, 115, 117 | the web app's payslip page |
| **Instant exits.** A user's 0.1 QOR withdrawal was paid to their wallet 68 blocks after its batch, about an hour before L1 could pay it. Both watchtowers re-executed the batch and signed for the withdrawal with ML-DSA-87; [`InstantExitVault`](contracts/src/InstantExitVault.sol) checked the signatures through `pqcVerify` and fronted the money from LP liquidity. Since 24 Nov a hosted relayer does this with nobody in the loop: its first exit was paid 11 blocks after the batch, and the vault was repaid automatically after finality. Without the quorum the user still gets everything at finality; the LP, not the user, carries the quorum risk | 82 to 109 | [THREAT_MODEL §14](THREAT_MODEL.md) |
| **Withdrawals to L1.** An L2 withdrawal was committed in a batch and paid on L1 with its qledger proof once final; a second claim was refused | 19 to 21, 72 | `GET /qorechain/rdk/v1/batch/vigil-pay-1/2` |
| **Q-Day Drill.** The fest accepted our drill-day proof from the registered account, which has never opened an EVM window. The PQ-guarded vault design is in rows 1 to 8 | 12 | [THREAT_MODEL §6](THREAT_MODEL.md) |
| **Receipts outlive the chain's retention windows.** The chain's parameters allow it to delete finalized batch records after 432,000 blocks; as of 24 Nov we have not seen that happen (records 750,000 blocks old are still served). It does delete posted data after 648,000 blocks, which we have observed. A keep-alive job keeps fresh anchored batches coming, and the web app verifies a receipt whose batch record is gone against its surviving anchor | 73 to 78 | `GET /qorechain/rdk/v1/params` |
| **Five RDK languages agree.** We ran 10,056 generated rollup histories (mostly valid transactions, recipients of 1 to 90 bytes) through the TypeScript, Go, Rust, Python and Java implementations of qledger-v1. All five gave the same state roots, withdrawals roots and withdrawals | read-only | [`scripts/fuzz/`](scripts/fuzz) |
| **Upstream contribution.** A qledger-v1 batch validator for watchtowers, so they judge batches by re-execution, in all five RDK languages. Open, and green on each language's CI in our fork | [qorechain/qorechain-rdk#1](https://github.com/qorechain/qorechain-rdk/pull/1) | the PR's tests |
| **Attacked by us.** On 24 Nov six reviewers tried to break every part of Vigil. The findings that put money or fraud detection at risk were fixed, tested and deployed the same night | [THREAT_MODEL §12](THREAT_MODEL.md#12-findings) | the tests named there |

## How it works

```mermaid
flowchart LR
  U["Users<br/>ML-DSA-44 L2 transactions"] -->|post, hybrid-signed| C
  E["Employer<br/>sealed payslips<br/>ML-KEM-1024 + X25519"] -->|post| C
  P["Keep-alive<br/>every two days"] -->|0.01 QOR pulse| C
  C[("QoreChain rollup module<br/>inbox, batches, anchors,<br/>challenge window, escrow")]
  C --> K["Keel, the creator's sequencer<br/>batches and anchors<br/>with ML-DSA-87"]
  C --> KB["Standby Keel, bonded<br/>batches anything left<br/>waiting 30 blocks"]
  K -->|batch + anchor| C
  KB -->|batch, unanchored| C
  C --> W["Two watchtowers<br/>re-execute every batch"]
  W -->|fraud proof| C
  C --> R["Settlement receipts<br/>checked in the browser<br/>and in Solidity"]
```

**Post-quantum at every layer**

| Where | Primitive | Code |
|---|---|---|
| L2 transactions | ML-DSA-44 (qledger-v1) | `@qorechain/rdk`, `packages/keel` |
| Batch anchors and settlement receipts | ML-DSA-87, signed by the rollup creator, key read from the chain's PQ registry | `packages/keel`, `apps/web` |
| Every operator transaction on L1 (sequencers, watchtowers, keep-alive, exit relayer) | Hybrid secp256k1 + ML-DSA-87. None of the sequencer, watchtower or keep-alive keys has ever opened an EVM window. Three single-purpose keys have, briefly, each closing it after use: the first deployer (PQGuardVault, 17 Nov), the EVM deployer, and the exit relayer, whose windows admit only its calls to the vault | `packages/keel/src/chain.ts`, `packages/qledger-watchtower/src/challenger.ts`, `packages/exit-relayer` |
| Receipts inside the EVM | `pqcKeyStatus` and `pqcVerify` precompiles | `contracts/src/SettlementReceiptVerifier.sol` |
| Instant exits | Two watchtowers' ML-DSA-87 signatures, checked by the vault through `pqcVerify` | `contracts/src/InstantExitVault.sol`, `packages/qledger-watchtower/src/exits.ts`, `packages/exit-relayer` |
| Confidential payroll data | ML-KEM-1024 with X25519 (QoreSeal) | `packages/sealed` |

What this does and does not protect against, and what each hosted key could do if stolen, is in the [threat model](THREAT_MODEL.md).

## What is new here

- **Settlement receipts checked in Solidity, with an on-chain record.** A contract with no owner rebuilds the rollup's anchor message byte for byte and verifies the creator's ML-DSA-87 signature through the chain's precompiles, so EVM code can rely on rollup state without a classical signature anywhere.
- **Confidential data inside the rollup itself.** Sealed payslips travel in the same inbox and settle in the same batches as the payments they explain, with data receipts that prove a ciphertext is in a settled batch.
- **Liveness without trusting the creator.** A second, bonded sequencer on another key in another region took over when we stopped the first, and the withdrawal it batched was paid on L1.
- **Instant exits whose only authority is ML-DSA-87.** Watchtowers sign exits from their own re-execution, the vault checks the signatures on chain, and the relayer that pays them can reach the EVM only through windows its post-quantum key opens for exactly its calls.
- **Upstream work.** The qledger-v1 validator the RDK's watchtower lacked, in all five RDK languages, and a differential fuzzer across them.

## For jurors: where the post-quantum checks are

| Check | Code | On chain |
|---|---|---|
| `pqcKeyStatus` (registered ML-DSA-87 key, proof of possession) | `contracts/src/SettlementReceiptVerifier.sol:129`, `contracts/src/InstantExitVault.sol:192`, `contracts/src/PQGuardVault.sol:69` | EVIDENCE 62, 63, 80, 91, 104, 112 |
| `pqcVerify` (ML-DSA-87, FIPS 204 pure, empty context) | `contracts/src/SettlementReceiptVerifier.sol:143`, `contracts/src/InstantExitVault.sol:285`, `contracts/src/PQGuardVault.sol:127` | EVIDENCE 62, 63, 80, 91, 104, 112; PQGuardVault's live check is the 17 Nov row under the numbered ones |
| Hybrid secp256k1 + ML-DSA-87 transactions | `packages/keel/src/chain.ts`, `packages/qledger-watchtower/src/challenger.ts` | `pqc_hybrid_verify` `verified` on every operator tx, e.g. EVIDENCE 97, 106 |
| PQ key registration with proof of possession | `scripts/drill/register-pqc.ts` | EVIDENCE 58, 74, 98 |
| Scoped EVM windows | `packages/exit-relayer/src/relayer.ts` (`openWindow`), `scripts/evm/receipt-verifier.ts` | EVIDENCE 79, 103, 107, 111 |
| ML-KEM-1024 sealing and the KEM registry | `packages/sealed` | EVIDENCE 28 to 38, 115 |

## Limitations

- **Testnet only**, and nearly all traffic on `vigil-pay-1` is ours.
- **The web app trusts the node it reads.** Reads come from one public QoreChain node and its EVM endpoint, without proofs. A dishonest node could show a false chain state, including a false key and anchors. Signatures marked "in your browser" are verified locally, but against what the node says.
- **The instant-exit quorum is two keys run by one team on one host.** Stealing both, or the LP key (the rollup creator's), could drain the vault's liquidity, never a user's withdrawal. The relayer serves only payouts it is told about (configured, or announced with a payout notice).
- **The Solidity verifier proves a signature, not finality.** It shows that the creator signed a state root. Whether that batch is final is chain state, which the browser check covers.
- **Classical dependencies remain below us:** QoreChain's consensus keys (Ed25519), TLS to the node, and the first, classical-signed PQ key registration of each account. The full list is in the [threat model](THREAT_MODEL.md).

## Run it yourself

Requires Node 20+, pnpm, and Foundry for `contracts/`.

```bash
pnpm install
pnpm test                      # 247 TypeScript tests (7 more need a live chain and are skipped)
(cd contracts && forge test)   # 110 Foundry tests, including invariant fuzzing of the vault
pnpm --filter @vigil/web dev   # the web app, reading the live chain
```

- Replay `vigil-pay-1` from chain data and compare the state roots: `packages/qledger-watchtower`.
- Re-run the differential fuzzer: [`scripts/fuzz/README.md`](scripts/fuzz/README.md).
- Check the Solidity verifier without spending anything: `pnpm --filter @vigil/scripts evm:verifier status`.

## Testnet addresses

| Role | Address |
|---|---|
| Rollup creator and sequencer (Keel); registered Q-Day Drill account | `qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s` |
| Standby sequencer (keel-b) | `qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft` |
| Watchtower-2 (US West) | `qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd` |
| Watchtower-3 (EU West) | `qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33` |
| Keep-alive poster | `qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l` |
| EVM deployer | `qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6` |
| Exit relayer | `qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn` |
| Sealed payroll demo: employer-1 | `qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws` |
| First deployer (PQGuardVault, 17 Nov) | `qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv` |
| Watchtower-1 (19 Nov, a laptop; retired) | `qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m` |
| `SettlementReceiptVerifier` (EVM, chain id 9800) | `0xc87c7680b70e21464aac4e2308a9caa5324e4590` |
| `InstantExitVault` (EVM, chain id 9800) | `0x3a897802b62b052a102f55e021bc4668539c29b5` |
| `PQGuardVault` (EVM, chain id 9800) | `0x40b6b90d69b4a6e2277583ff7d98912c03255591` |

## Full status

| Piece | State |
|---|---|
| Inbox replay matches on-chain roots (watchtower seed) | **12 of 12** live batches on two rollups reproduced (read-only: `scripts/spike-a-replay.ts`, offline test in `scripts/test/`) |
| `pqcVerify` / `pqcKeyStatus` probed via `eth_call` | Done (read-only): FIPS 204 pure ML-DSA-87, empty context; ~312k gas per direct call (`scripts/spike-b-pqcverify.ts`) |
| Q-Day Drill vault (`PQGuardVault`) | Deployed at `0x40b6b90d69b4a6e2277583ff7d98912c03255591`, 25 QOR, accepts a real ML-DSA-87 signature via `pqcVerify` (EVIDENCE rows 1 to 8); 21 Foundry tests |
| Our rollup `vigil-pay-1` (qledger-v1, based, optimistic) | Created and bonded 19 Nov (EVIDENCE 13 and 14). Our sequencer Keel (`packages/keel`) has batched a deposit, a transfer and a withdrawal (batches 0 to 2, all finalized; EVIDENCE 15 to 20). Keel now runs hosted, always on, and submitted batch 3 unattended (EVIDENCE 22 and 23) |
| Sequencer failover ("kill the sequencer") | Two sequencers on two bonded keys in two regions: Keel, run by the creator, and a standby Keel (`KEEL_STANDBY_BLOCKS=30`). On 20 Nov the creator's Keel was stopped. The standby batched a user's L2 withdrawal (unanchored, since only the creator can anchor), both watchtowers judged it valid, and the withdrawal was paid on L1 once final. The creator's Keel then came back and anchored again (EVIDENCE 65 to 72; [THREAT_MODEL §7](THREAT_MODEL.md)) |
| qledger-v1 across the RDK's five languages | Differential fuzzer ([`scripts/fuzz/`](scripts/fuzz)): the same generated rollup histories run through TypeScript, Go, Rust, Python and Java. 10,056 cases, 0 divergences in state roots, withdrawals roots and withdrawals |
| Anchored batches and settlement receipts | `vigil-pay-1` batches 0 to 3: each anchored in its submission tx by ML-DSA-87; replay matches; settlement receipts valid with a live client (EVIDENCE 16, 18, 20, 23; `receipts/vigil-pay-1/`) |
| Withdrawals | One L2 withdrawal (0.25 QOR) committed in batch 2 and executed on L1 with its qledger proof once final; a second claim is refused (EVIDENCE 19 to 21) |
| Settlement receipts in the browser and in Solidity | The [web app](apps/web) (https://vigil-pq.up.railway.app) builds and checks a receipt for any batch against the live chain, in the browser, with no server of ours, and requires the batch to be final. [`SettlementReceiptVerifier`](contracts/src/SettlementReceiptVerifier.sol) at `0xc87c7680b70e21464aac4e2308a9caa5324e4590` (no owner) checks anchors inside the EVM through `pqcKeyStatus` and `pqcVerify`. It has verified and recorded 19 `vigil-pay-1` anchors on chain, every one through layer height 19: 11 on 19 Nov, 3 on 23 Nov and 5 on 24 Nov, each later round through a window scoped to the contract (EVIDENCE 57 to 64, 79 to 81, 110 to 113). Newer anchors (the keep-alive adds one every two days) can be recorded by anyone. What it does and does not prove is in [THREAT_MODEL §13](THREAT_MODEL.md#13-residual-risks); 19 Foundry tests |
| Receipts that outlive the chain's retention windows | The chain's parameters allow it to delete a finalized batch's record after 432,000 blocks (about 7 days on testnet); as of 24 Nov that has not been observed. Anchors stay either way. Posted data is deleted after 648,000 blocks, and that is observed. A keep-alive job (`packages/keel/src/pulse.ts`, a Railway cron every two days) posts a 0.01 QOR L2 transfer from its own hybrid-signed key so the rollup keeps producing anchored batches, and keeps a ledger snapshot on a volume so it never has to replay pruned batches. First runs: batches 13 and 14, both anchored (EVIDENCE 73 to 78) |
| Instant exits | `InstantExitVault` (no owner) pays a withdrawal before its batch is final when watchtower-2 and watchtower-3 have both re-executed the batch and signed the exit with ML-DSA-87. The watchtowers attest automatically (`WATCHTOWER_EXIT_VAULT`) by posting signatures into the inbox. First exit: 0.0995 QOR paid 68 blocks after its batch, relayed by hand (EVIDENCE 82 to 96). Since 24 Nov the relayer is automatic (`packages/exit-relayer`, its own key, EVIDENCE 97 and 98). Its first exit was paid **11 blocks after its batch with nobody in the loop**, through a window open for 5 blocks that admitted only that one call; after finality it executed the withdrawal 5 blocks later and repaid the vault the same way (EVIDENCE 99 to 109). It fronts each attested exit, and after finality executes the withdrawal and sweeps the exit address back to the vault. It opens an EVM window only when it has calls to make, scoped to the vault and capped at those calls' fees, and closes it after. Bounded so that nobody can make it, or the watchtowers' attesting, spend more than a small budget ([THREAT_MODEL §14](THREAT_MODEL.md)) |
| qledger-v1 watchtower, fraud challenge | Watchtower (`packages/qledger-watchtower`) runs in challenge mode on `vigil-pay-1` from two keys in two Railway regions, watchtower-2 (US West, primary) and watchtower-3 (EU West, 3 s backup), each following new batches over the chain websocket (EVIDENCE 24 to 27, 46 to 47). Its first live pass found 44 of 44 batches valid on four rollups (read-only check). Fraud drill 1 was upheld on chain and the bond slashed, but another team's watcher won the race: watchtower-2's challenge reached the same block and lost on its position within it (EVIDENCE 116), and watchtower-1's came 4 blocks later (EVIDENCE 39 to 45). That led to the fast path. **Fraud drill 2: our watchtower-2 won**, upheld in the block right after the wrong batch; the 1,000 QOR bond was slashed and 500 QOR paid to our watchtower (EVIDENCE 51 to 56) |
| ML-KEM-1024 sealed data lane | First sealed payslip posted into `vigil-pay-1` (`packages/sealed`): QoreSeal hybrid envelope, recipients' ML-DSA-87 and ML-KEM-1024 keys registered on chain, opened by its three recipients and by no one else, and covered by a data receipt against batch 5 (EVIDENCE 28 to 38). A December payslip followed on 24 Nov (EVIDENCE 114 and 115), and a January payslip on 26 Nov (EVIDENCE 121 to 123) |
| Reading the inbox, and pruning | One shared reader (`packages/core/src/inbox`) fetches each inbox entry by sequence and checks it against the chain's accumulator; Keel, the keep-alive, the relayer and the payslip tools use it. A public archive of every entry (`data/inbox/vigil-pay-1.jsonl`, refreshed by `scripts/inbox-archive.ts`) is used only for entries the chain has pruned, and only after a commitment the chain still holds confirms them. Keel logs a heartbeat every 10 minutes whether its passes succeed or not, and the keep-alive's exit code says whether it did its job |
| Monitoring | A keyless sentinel (`packages/sentinel`) reads the chain every minute and alerts the team on Telegram: an EVM window on a key that must never open one, low balances, a stuck sequencer, disputes, an unrepaid vault, the web app down |
| Web app hardening (24 Nov) | Watchtower attestations are accepted only from the member's own account and only after their ML-DSA-87 signature verifies in the browser against pinned key hashes; `pqcVerify` is a second, labelled check. Exit addresses are computed in the browser from the pinned ExitAddress code. Pages survive posted-data pruning, show live-feed health truthfully, and say which checks ran where. First load is about 80 KB gzipped |
| Continuous integration | GitHub Actions run the typecheck, the TypeScript tests and the Foundry tests on every push and pull request |
| Threat model | [v1.6](THREAT_MODEL.md) (24 Nov): adversaries and trust assumptions, both fraud drills, how the hosted operator keys are held and what a theft of each would cost, measured challenge and rollback behaviour, instant exits, the 24 Nov adversarial study, findings and residual risks |

## Layout

```
packages/core                shared config and chain helpers
packages/chain-ws            the chain over its websocket: RPC, REST over abci_query, chain descriptors
packages/keel                sequencer (with standby mode) and the keep-alive pulse
packages/qledger-watchtower  replay, validator, fraud proofs, challenger, exit attestations
packages/exit-relayer        pays instant exits automatically: fronts, executes, sweeps
packages/sentinel            keyless monitoring with Telegram alerts
packages/sealed              QoreSeal envelopes, KEM registration, payslips, data receipts
contracts/                   Foundry contracts and tests
apps/web                     rollup explorer, receipt verifier, instant exits, payslip opener
scripts/                     spikes, rollup, EVM, drill and fuzzing scripts
receipts/                    saved settlement and data receipts
test/vectors/                recorded chain data and shared vectors
```

## Built with

QoreChain kits:
- [`@qorechain/rdk`](https://www.npmjs.com/package/@qorechain/rdk) 0.9.0: qledger-v1 execution, batch planning, fraud proofs, receipts. The fuzzer also runs the RDK's Go, Rust, Python and Java implementations.
- [`@qorechain/sdk`](https://www.npmjs.com/package/@qorechain/sdk): accounts, hybrid signing, PQ key registry.
- `@qorechain/qoreseal`: ML-KEM-1024 envelopes and the KEM registry.
- QoreChain EVM precompiles `pqcVerify` and `pqcKeyStatus`.

## Team

- OoJae ([@OoJae](https://github.com/OoJae))
- Olamiye Emmanuel ([@Manuel-dev01](https://github.com/Manuel-dev01))

An AI coding agent wrote much of the code with us. [AI_USAGE.md](AI_USAGE.md) records what it did and what we reviewed or decided.

## Licence and credits

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Vigil builds on open-source software, listed with its licences in [CREDITS.md](CREDITS.md).
