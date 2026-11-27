# Stages self-assessment

**27 November 2026 (UTC).** How `vigil-pay-1` measures up against L2BEAT's Stages framework, graded by us. **This is a self-assessment, not an L2BEAT rating, and it claims no stage.** The web app shows the same checklist with the values read live: [vigil-pq.up.railway.app/#/trust](https://vigil-pq.up.railway.app/#/trust).

In short: by our reading every Stage 0 question is answered yes, one with a caveat. Three Stage 1 requirements are not met: the testnet challenge window is 1 hour, and QoreChain governance can change the rollup module's rules, or pause a based rollup, after a 4-hour vote (1 hour if expedited, which leaves users no time to exit). How to leave without us is in [ESCAPE_HATCH.md](ESCAPE_HATCH.md).

## The framework

- **The Stages page**, [ethbeat.org/stages](https://ethbeat.org/stages). The site's footer reads "Copyright 2026 ETHBEAT (formerly L2BEAT)", and `l2beat.com/stages` redirects there. The page gives **no version number**; it says **"Last updated on 23 Jul 2025"**. Read on 27 Nov 2026.
- **The full specification**: [forum.ethbeat.org/t/the-stages-framework/291](https://forum.ethbeat.org/t/the-stages-framework/291).
- **One later change**: ["Stage 1 update: minimum challenge period reduction from 7d to 5d"](https://forum.ethbeat.org/t/stage-1-update-minimum-challenge-period-reduction-from-7d-to-5d/425), posted on **30 Apr 2026**. Stage 1 now asks for at least 5 days; Stage 2 keeps 7.

QoreChain's rollup module is part of the L1. So the "upgrade keys" the framework asks about are, for `vigil-pay-1`, QoreChain's governance. Vigil's own contracts have no owner and no proxy.

## What the chain reported

Read on **27 Nov 2026 at 16:44:53 UTC** (block 10,859,790) over the node's websocket (`wss://rpc-testnet.qore.host/websocket`, REST routes answered by `abci_query`), and from the EVM endpoint by `eth_call` at EVM block 10,859,803. These are the node's answers, not proofs. The page reads the same routes each time it loads, and the same values are a read-only row of [EVIDENCE.md](../EVIDENCE.md) (27 Nov).

| Value | As the node reports | Route |
|---|---|---|
| Challenge window of `vigil-pay-1` | 3,600 s | `GET /qorechain/rdk/v1/rollup/vigil-pay-1` → `challenge_window_sec` |
| The chain's default challenge window | 3,600 s (the same again at 17:33 UTC) | `GET /qorechain/rdk/v1/params` → `default_challenge_window` |
| Sequencing, execution, proofs, status | `based`, `qledger-v1`, `fraud`, `active` | same |
| Bond to submit batches | 1,000 QOR | `GET /qorechain/rdk/v1/params` → `min_submitter_bond` |
| Posted-data retention | 648,000 blocks | same → `posted_data_retention_blocks` |
| Finalized batch record retention | 432,000 blocks | same → `finalized_batch_retention_blocks` |
| Governance voting period | 14,400 s (4 h); 3,600 s (1 h) if expedited | `GET /cosmos/gov/v1/params/voting` |
| Chain upgrade authority | `qor10d07y265gmmuvt4z0w9aw880jnsr700jwfyxr3`, the governance module's account (the first 20 bytes of SHA-256 of "gov") | `GET /cosmos/upgrade/v1beta1/authority` |
| Circuit breaker: switched off | `/cosmwasm.wasm.v1.MsgStoreCode` only; no rollup message | `GET /cosmos/circuit/v1/disable_list` |
| Circuit breaker: who may switch messages off | one account, `qor1hz907zyx2t9ax2fj0y8hhspc5rpnxuegrfzzr9`, for `/qorechain.crossvm.v1.MsgCrossVMCall` only; no one for rollup messages | `GET /cosmos/circuit/v1/accounts` |
| `InstantExitVault` quorum | `0x2684Af6b…28CA` (watchtower-2) and `0x13f665a3…Ba8f` (watchtower-3), threshold 2 | `quorum()`, `threshold()` |
| `InstantExitVault` LP | `0x16B7aB42…f9c7`, the rollup creator | `lp()` |
| `InstantExitVault` free liquidity, fee | 1.001 QOR, 50 basis points; nothing owed. The liquidity changes as exits are fronted and repaid; the Trust page reads it live | `available()`, `feeBps()`, `totalOwed()` |

Re-check from a terminal (the REST API works there; only the web page is limited to the websocket by its CSP):

```bash
curl -s https://api-testnet.qore.host/cosmos/gov/v1/params/voting | jq .params.voting_period
curl -s https://api-testnet.qore.host/cosmos/circuit/v1/disable_list
curl -s https://api-testnet.qore.host/qorechain/rdk/v1/rollup/vigil-pay-1 | jq .rollup.challenge_window_sec
curl -s https://api-testnet.qore.host/qorechain/rdk/v1/params | jq .params.default_challenge_window
cast call 0x3a897802b62b052a102f55e021bc4668539c29b5 "quorum()(address[])" --rpc-url https://evm-testnet.qore.host
cast call 0x3a897802b62b052a102f55e021bc4668539c29b5 "threshold()(uint256)" --rpc-url https://evm-testnet.qore.host
```

**Mainnet was not read.** This check used the testnet endpoints only. Mainnet has not applied chain v3.2.8, and nothing of Vigil's has run there ([THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks)).

## Risk rosette (our grading)

| Slice | Answer | Our grade | Why | Evidence |
|---|---|---|---|---|
| State validation | Fraud proofs, anyone may submit | caution | The chain re-executes a challenged batch and slashes a wrong one's bond; two challenges have been upheld on `vigil-pay-1`. The window is 1 h, short of Stage 1's 5 days | EVIDENCE 24, 44, 55 |
| Data availability | Onchain: the L1 inbox | caution | Every L2 transaction is an L1 transaction. The chain deletes posted-data records after 648,000 blocks (observed); the bytes are then read from L1 transaction history or the public archive in `data/inbox/`, checked against commitments the chain still holds. We extend the archive by hand, so the newest entries may not be in it yet | EVIDENCE 17, 122; [THREAT_MODEL §10, §13](../THREAT_MODEL.md#10-facts-we-measured-and-rely-on) |
| Sequencer failure | Self sequence | low risk | Based: anyone can post, and the order is fixed when L1 includes the post. No Vigil sequencer can drop or reorder an entry; L1 block proposers could delay one, as for any L1 transaction | EVIDENCE 68 |
| Proposer failure | Self propose, with a 1,000 QOR bond | low risk | Any account with the bond may submit batches. With the creator's sequencer stopped, a standby on another key batched a user's withdrawal and it was paid on L1. Its batches carry no anchor | EVIDENCE 65 to 72 |
| Exit window | None if a vote is expedited (1 h); about 3 h otherwise | high risk | Governance can change the rollup module's rules, or pause a based rollup, after a 4 h vote (1 h if expedited). Leaving takes about one challenge window (1 h), which leaves no time if the vote is expedited, and about 3 h otherwise. We grade on the shorter. Stage 1 asks for 7 days | this page's reads; [THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks) |

## Stage 0

| Requirement | Our answer | Evidence |
|---|---|---|
| Does the project call itself a rollup? | Yes: a qledger-v1 optimistic rollup on QoreChain | [README](../README.md) |
| Are L2 state roots posted on L1? | Yes: every batch puts its state root and withdrawals root on L1; the creator's batches also carry an ML-DSA-87 anchor | EVIDENCE 16, 18, 20 |
| Does the project provide data availability on L1? | Yes, with a caveat: the inbox is on L1, but the chain deletes posted-data records after 648,000 blocks, so older entries are read from L1 transaction history or our archive | [THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks) |
| Is software that can reconstruct the state source-available? | Yes: the watchtower and Keel replay the rollup from chain data and check every root (Apache-2.0). `pnpm --filter @vigil/keel balance` reads any balance that way, checked from a fresh clone on 27 Nov | [ESCAPE_HATCH.md](ESCAPE_HATCH.md) |
| Does the project use a proper proof system? | Yes: fraud proofs the chain itself re-executes; two upheld | EVIDENCE 44, 55 |
| Are there at least 5 external actors that can submit a fraud proof? | Yes: anyone can; there is no allowlist, and our upheld challenge posted no bond, only its fee (about 0.18 QOR). Another team's watcher won our first drill | EVIDENCE 24, 44, 55 |

## Stage 1: what blocks it

| Requirement | Our answer |
|---|---|
| A challenge period of at least 5 days (7 before 30 Apr 2026) | **Not met.** 3,600 s, as the node reports. A rollup's creator does not choose it: `MsgCreateRollup` carries no challenge window (`@qorechain/rdk` 0.9.0), and `vigil-pay-1`'s matches the chain's `default_challenge_window` parameter, 3,600 s as the node reports (EVIDENCE 13) |
| Upgrades by anyone outside a Security Council give users at least 7 days to exit | **Not met.** There is no Security Council. Governance can change the rollup module's rules after a 4 h vote (1 h if expedited); less the hour an exit takes, nothing remains if the vote is expedited, and about 3 h otherwise |
| Only compromising at least 75% of a Security Council can block an L2→L1 message indefinitely, or push an invalid one | **Not met.** Governance can pause a based rollup, and funds then wait for governance (QoreChain's v3.2.8 rollup documentation; [THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks)) |

**Not a requirement, but an assumption the framework makes.** The Stages page's Stage 1 section says that if the proposer set is open to anyone with enough resources, it assumes at least one live proposer at any time, and does not assume that proposer is non-censoring. `vigil-pay-1`'s set is open: any account with the 1,000 QOR bond may submit batches, and a standby on another key did so on 20 Nov (EVIDENCE 65 to 72).

Stage 2 for completeness: fraud proofs are permissionless (met); users do not have 30 days to exit an unwanted change (not met); there is no Security Council to restrict (not met).

## What an RDK rollup needs from QoreChain to reach Stage 1

These are the changes that would move the answer, and who would make them. They describe governance powers that QoreChain's documentation sets out, not faults.

- **From QoreChain:** a challenge window of at least 5 days that a rollup can run with: a `default_challenge_window` parameter of at least 5 days, or a window set per rollup at creation. A new rollup could then use it; its L1 withdrawals would wait 5 days, which is what instant exits are for.
- **From QoreChain:** at least 7 days between a governance decision that changes the rollup module's rules for running rollups (a parameter change, a pause or a chain upgrade) and its effect, or a Security Council as the framework defines one, so users can leave first.
- **From QoreChain:** a pause of a based rollup that cannot hold withdrawals from final batches indefinitely: for example one that lets them through, or that ends on its own.
- **From QoreChain:** the same rules on mainnet, where chain v3.2.8 is not yet applied.

## Who can do what

| Action | Who | How we know |
|---|---|---|
| Post a transfer or withdrawal | Anyone with an L1 account and the fee | chain rule; EVIDENCE 68 (posted by a non-operator account) |
| Batch the inbox | The creator's Keel first; any account with the 1,000 QOR bond; our standby after an entry has waited 30 blocks | read live (bond); EVIDENCE 65 to 72 |
| Reject a batch | Anyone with a valid fraud proof, within the challenge window | read live (window); EVIDENCE 44, 55 |
| Finalise a batch | No one acts: a batch is final once its window passes with no upheld challenge | chain rule; EVIDENCE 16 |
| Pay a withdrawal on L1 | Anyone, once its batch is final; the money goes to the recipient the user's ML-DSA-44 signature names | chain rule; EVIDENCE 72, 93 |
| Pay an exit early | Both quorum keys (watchtower-2 and watchtower-3) by ML-DSA-87 signatures; then anyone submits | read live (`quorum()`, `threshold()`); EVIDENCE 83, 91, 104 |
| Take liquidity out of the vault | The LP alone (the rollup creator), by an ML-DSA-87 signature | read live (`lp()`); EVIDENCE 83 |
| Anchor a batch (settlement receipts) | Only the rollup creator's ML-DSA-87 key | chain rule (the creator's address read live); [THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks) |
| Change Vigil's contracts | No one: no owner, no proxy | contract code: [`InstantExitVault.sol`](../contracts/src/InstantExitVault.sol), [`SettlementReceiptVerifier.sol`](../contracts/src/SettlementReceiptVerifier.sol) |
| Change the rollup's rules, or pause it | QoreChain governance, after a 4 h vote (1 h expedited); the creator cannot pause a based rollup | read live (voting period, upgrade authority); [THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks) |
| Switch off rollup messages without a vote | No account, as the node reports on 27 Nov | read live (circuit breaker) |

## Instant exits: the risk card

In the fields L2BEAT uses for bridges.

| Field | Answer |
|---|---|
| Validated by | A 2-of-2 committee of ML-DSA-87 keys, watchtower-2 and watchtower-3, checked by the vault through `pqcVerify`. One operator (our team), one hosting provider, two regions (EVIDENCE 83; [THREAT_MODEL §8](../THREAT_MODEL.md#8-operations-hosted-keys-and-services)) |
| Limits | None in the contract ([`InstantExitVault.sol`](../contracts/src/InstantExitVault.sol)). In practice an exit is capped by the vault's free liquidity, which changes as exits are fronted and repaid: 1.001 QOR at 16:44 UTC on 27 Nov (EVIDENCE, read-only checks, 27 Nov). The Trust page reads it live |
| Fee | 0.5%, kept by the vault for the LP |
| Signer budget | Each watchtower posts at most 12 attestations a day and keeps a 5 QOR challenge reserve. Using the budget up pauses instant exits, not withdrawals ([THREAT_MODEL §12 F6, §13](../THREAT_MODEL.md#12-findings)) |
| Exercised | Two exits fronted before finality and repaid after it, one by hand and one automatic. A small sample (EVIDENCE 91, 95, 104, 108) |

**Funds can be stolen if:**
- both quorum keys sign a false claim: the loss is the LP's liquidity, never a user's withdrawal;
- the LP key, which is the rollup creator's, is stolen: the thief can take the liquidity out;
- the quorum signs a claim for a payout that never withdrew: that payout's exit address then owes the vault, and its later withdrawals through that address repay it first ([THREAT_MODEL §14](../THREAT_MODEL.md#14-instant-exits-23-nov-2026)).

**An exit is slower, not lost, if** the quorum or the relayer is offline or out of budget, or the vault is out of liquidity: the withdrawal is then paid in full at finality, by anyone (EVIDENCE 93). If governance pauses the rollup, funds wait for governance.

## If Vigil disappears

What keeps working, what stops, and the commands to leave on your own are in [ESCAPE_HATCH.md](ESCAPE_HATCH.md).
