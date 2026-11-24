# Vigil threat model

**Version 1.4, 23 November 2026 (UTC).** Testnet only (`qorechain-diana`, chain v3.2.8). v0 (16 Nov) was written before Vigil had a rollup. v1 adds what has run since: our rollup `vigil-pay-1`, two fraud drills, a sealed data lane, hosted keys and their operating rules.

This document separates what is **exercised** (backed by a test or a row in [EVIDENCE.md](EVIDENCE.md)) from what is **designed but not yet exercised**. Nothing here claims that Vigil is "quantum-proof". The claim is narrower: no step that moves value depends on a classical signature or a pairing-based proof, and each remaining classical dependency is named below.

## 1. System in one paragraph

Vigil is a qledger-v1 **based optimistic rollup** on QoreChain.
- **Ordering:** users' ML-DSA-44-signed L2 transactions are posted to the chain's rollup inbox (`MsgPostRollupData`), so the order is fixed when L1 includes each post.
- **Settlement:** a sequencer settles inbox ranges in batches that carry the creator's ML-DSA-87 anchor signature. The chain re-executes a batch when it is challenged (`MsgChallengeBatch`) and pays withdrawals from its deposit pool, but only from finalized batches.
- **Watchtowers:** they re-execute every batch from chain data and challenge wrong ones. They will also sign ML-DSA-87 checkpoints that EVM contracts verify through the `pqcVerify` precompile; that part is designed but not built.
- **Confidential data:** it travels as ML-KEM-1024 envelopes inside the same inbox.

**Live on testnet today:**
- **Rollup:** `vigil-pay-1`, created and bonded 19 Nov (EVIDENCE 13–14).
- **Sequencers:** Keel, run by the creator, hosted and always on (EVIDENCE 15–23), and a standby Keel with its own bonded key in another region. With the creator's Keel stopped, the standby batched a user's withdrawal; the creator's Keel then resumed and anchored again (EVIDENCE 65–72; §7).
- **Watchtowers:** two keys in two hosting regions, both in challenge mode (EVIDENCE 24–27, 46–47).
- **Sealed payroll lane:** live (EVIDENCE 28–38).
- **Fraud drills:** two, both upheld on chain (EVIDENCE 39–45, 48–56; §7).
- **Receipts in three places:** the CLI (`scripts/receipts-snapshot.ts`), the browser (`apps/web`, which reads the chain over the node's websocket with no server of ours), and Solidity: `SettlementReceiptVerifier` has verified and recorded all 11 `vigil-pay-1` anchors on chain (EVIDENCE 57–64; §5, §13).

## 2. Assets

| Asset | Where it lives | What loss looks like |
|---|---|---|
| Deposit pool | x/rdk, per rollup (`vigil-pay-1` escrow) | A withdrawal paid that the honest ledger does not owe |
| L2 balances | qledger state (SHA-256 sparse Merkle tree) | A transfer or withdrawal without the account's ML-DSA-44 signature |
| Submitter bonds | x/rdk (the creator's 1,000 QOR bond) | Slashed when the submitter was honest, or kept when it was not |
| Sealed payment data | ML-KEM-1024 envelopes in the inbox | Plaintext readable by anyone other than the named recipients, now or later |
| Receipt integrity | x/multilayer anchors, settlement and data receipts | A receipt that verifies for a state the chain never settled |
| Vault liquidity | `PQGuardVault`, later `InstantExitVault` | Funds moved without the required ML-DSA-87 signature(s) |
| Operator keys | the creator's and the watchtowers' hybrid keys (§8) | Our own funds spent, our bond slashed, or our watchtowers silenced |
| Liveness | sequencer, watchtowers | Users unable to exit, or fraud left unchallenged within the window |

## 3. Adversaries

1. **Classical-key thief / Q-Day attacker.** Holds or can derive any secp256k1 private key (theft today; Shor's algorithm later). It can also break pairing-based proofs (Groth16, BLS12-381) and ECDSA signatures.
2. **Harvest-now-decrypt-later (HNDL) collector.** Records every post today and decrypts later with a quantum computer, or with any future break of the classical half of a hybrid scheme.
3. **Malicious submitter.** A bonded account (the sequencer, or anyone who bonds) that publishes a wrong state root or withdrawals root, censors, or stops. *Exercised twice (§7).*
4. **Malicious watchtowers.** A minority that lies or stays silent; or, for instant exits only, a colluding quorum.
5. **Chain-level adversaries.** A censoring proposer; a governance pause of a based rollup; a network attacker between users and endpoints.
6. **Operator compromise.** Someone who takes over the hosting account or a machine that holds an operator key (§8).
7. **Griefer.** Spends its own fees to make our accounts or services do useless work.

## 4. Trust assumptions

- QoreChain re-executes qledger-v1 batches correctly when challenged, and enforces its own ante rules: the hybrid signature requirement, EVM windows, and the first-registration exemption only for key-less accounts.
- **ML-DSA-44 and ML-DSA-87 are EUF-CMA secure. ML-KEM-1024 is IND-CCA2 secure.** These are NIST FIPS 204 and FIPS 203.
- **SHA-256 and SHAKE-256 are collision-resistant and preimage-resistant.** Grover's algorithm roughly halves preimage security, leaving about 128 bits.
- **At least one honest, online watchtower per challenge window** (3,600 s on testnet).
  - Ours are two keys in two regions.
  - The rollup is based, so anyone can challenge, and another team's watcher did challenge on `vigil-pay-1` in drill 1 (§7).
- L1 liveness: posts and challenges are included within the window.
- The `pqcVerify` and `pqcKeyStatus` precompiles behave as observed (§10).
- Our hosting provider keeps secret variables secret and runs the images we deploy. This protects **our** funds and liveness, not users' safety (§8).

## 5. Why each design choice resists the adversaries above

| Choice | Against | Note |
|---|---|---|
| **No classical-key authority anywhere.** Contracts have no owner and never check `msg.sender` for authority. Every authorisation is an ML-DSA-87 signature checked with `pqcVerify` against a key read from `pqcKeyStatus` with `possessionProven == true` | 1 | A stolen secp256k1 key can still *call* our contracts, but it cannot authorise anything. Exercised in tests (§11). |
| **L2 accounts are ML-DSA-44 only** (fixed by qledger-v1) | 1 | No classical key exists at L2. ML-DSA-44 is NIST category 2, a property of qledger-v1 that we cannot change. |
| **Optimistic re-execution, no SNARK** | 1, 3 | Fraud proofs rest on hashes and re-execution only: no pairings, no trusted setup. We reject Groth16 for anything that moves value, because its soundness falls to Shor. |
| **Based sequencing** | 3, 5 | Anyone can post, and any bonded account can submit batches, so a dead sequencer cannot freeze funds. Ordering is fixed at L1 inclusion, so the honest result is computable by anyone right away. *Exercised 20 Nov: with the creator's Keel stopped, our standby keel-b batched a user's withdrawal 7 blocks after it was posted, and the withdrawal was paid on L1 once final (EVIDENCE 65–72).* |
| **Watchtower re-execution from chain data** | 3 | We replay the inbox with the RDK's `executeQledger` and judge each batch against the honest state its `prevStateRoot` names, keyed by state root rather than batch index (§12, F3). RDK 0.9.0's built-in `transitionRootValidator` is not used (§12, F1). |
| **Two watchtowers, two keys, two regions** | 3, 4, 6 | A primary (no delay) and a backup (3 s delay). The backup sends only if the batch is still live after its delay, so one fraud costs one fee, not two. *Exercised in drill 2: the backup skipped correctly.* |
| **Fast challenge path** | 3 | Follow new batches over the chain websocket, prefetch inbox entries as they are posted, judge in milliseconds, and send with a pre-built signer at gas price 0.3. This changed drill 2's outcome (§7). |
| **Hybrid L1 accounts plus closed EVM windows** | 1 | A Native-lane transaction needs the account's ML-DSA-87 signature as well as the classical one. An EVM transaction (signed classically only) is admitted only inside a window that was opened by a hybrid-signed message. With no window open, the classical key alone moves nothing on either lane. |
| **Domain-separated signed messages** | 1, 7 | `pqcVerify` accepts only FIPS 204 pure ML-DSA-87 with an *empty* context (measured, §10), so every Vigil message carries its own tag in the message bytes (e.g. `vigil/pqguard/v1`), plus the chain id, the contract address and a nonce. |
| **Receipts checked in Solidity with no relayer** (`SettlementReceiptVerifier`) | 1, 3, 7 | The contract rebuilds the chain's v2 anchor message itself, reads the creator's key through `pqcKeyStatus` (possession proven), and verifies the ML-DSA-87 signature with `pqcVerify`. No owner; the rollup, layer and creator are fixed at deployment. Anyone can attest, so no relayer is trusted, and a forged or replayed anchor reverts. It records the first valid root per layer height. If the creator's key ever signed two roots for one height, the height is marked conflicted for good and never reported as attested. What it does not prove is in §13. *Exercised: EVIDENCE 60–63.* |
| **ML-KEM-1024 + X25519 envelopes (QoreSeal)** | 2 | Confidentiality holds if *either* ML-KEM-1024 or X25519 holds. Post-quantum confidentiality rests on ML-KEM-1024. *Exercised: a sealed payslip opened by its three recipients and by no one else (EVIDENCE 28–38).* |

## 6. The Q-Day Drill (18 Nov 2026)

**Registered drill account (18 Nov 2026).** The account Vigil registered with the fest is `qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s` / `0x16B7aB42fD64282931B1589f3e15720B7340f9c7`.
- It registered its ML-DSA-87 key with proof of possession at height 10,266,300.
- It has never opened an EVM window.
- It held 99.8 QOR plus fest tokens on drill day.
- Its drill-day proof (a hybrid-signed self-send at height 10,320,624, tx `A49757DE…A0C3`) was accepted by the fest.

**Since the drill:**
- On 19 Nov this same account created `vigil-pay-1` and became its creator and sequencer key (EVIDENCE 13–14).
- On 19 Nov 2026 it still had no EVM window (`/qorechain/pqc/v1/evm_window/…` → `found: false`). It holds about 768 QOR plus its 1,000 QOR bond.
- If the fest publishes its classical key, the account becomes the "Glass Key" of §8: safe while no window is ever opened and its ML-DSA-87 secret stays private.
- *Drill results: to be added when the fest publishes the attack log.*

The PQGuardVault setup below was prepared on a second account and is kept as evidence of the vault design. It was **not** the registered drill target.

**Setup.** *Exercised on 17 Nov 2026: EVIDENCE.md rows 1 to 8.* The drill account is `qor1naj0qh80tjhfufdvpmg5szd7dmnsg5j88tagaq` / `0x9f64F05CEF5cAE9e25AC0eD14809be6eE7045247`. PQGuardVault is at `0x40b6b90d69b4a6e2277583ff7d98912c03255591` and holds 25 QOR. The drill account holds ~73.8 QOR, 500 fUSD, 0.5 fETH and 0.02 fBTC as bank coins. Neither account has a window. The deployed vault accepted a real ML-DSA-87 signature from the drill key in an `eth_call` and rejected a tampered one. (v0 planned to make this account the rollup creator. In the end the registered drill account above became the creator.)
- **Drill account.** A fresh **unified eth-native** account: one secp256k1 key whose 20 address bytes are the same account on the Native and EVM lanes, so the key handed to the attacker really is the account on both lanes. Its ML-DSA-87 key (the SDK's canonical, address-bound derivation) is registered with a proof of possession as its first transaction. **It never opens an EVM window or an EIP-7702 consent.**
- **PQGuardVault.** It holds QOR and fUSD. `guardian` is the drill account. A release needs the guardian's ML-DSA-87 signature over `vigil/pqguard/v1 | chainid | vault | nonce | token | recipient | amount | deadline`.
- **Deployment.** A *separate* deployer account deploys the vault inside a short **unscoped** window (1 tx, 120 blocks, 0.25 QOR cap). The window must be unscoped because the chain refuses contract creation under `allowed_targets`. The deployer closes it immediately, and funding goes over the Native lane, so no window is needed.

**What the attacker can try with the classical key, and what we expect:**

| Attack | Expected result | Why |
|---|---|---|
| Native transfer from the drill account | Refused at ante | No ML-DSA-87 signature on the tx |
| Open an EVM window for the drill account | Refused at ante | `MsgOpenEVMWindow` must be hybrid-signed |
| EVM transfer, approval or call *from* the drill account | Refused | No live window, and no way to open one |
| Re-register or rotate the drill account's PQ key | Refused | Once a key exists, every key message must be hybrid-signed; the classical exemption covers only key-less accounts |
| `PQGuardVault.release` from *any* account (an attacker-funded one with its own window) | Reverts `BadSignature` | Needs an ML-DSA-87 signature from the guardian's registered key |
| Replay a past release signature | Reverts `BadSignature` | Nonce |
| Use a release signature from another vault or chain | Reverts `BadSignature` | Message binds `chainid` and `address(this)` |

**Our own transaction during the drill:** done. It was one Native-lane, hybrid-signed self-send at height 10,320,624 (tx `A49757DE…A0C3`), which the fest accepted.

**Residual drill risks we accept:**
- **Fee griefing.** Whether a refused transaction costs the drill account a fee depends on where the chain refuses it. A refused second registration "still takes the fee" according to the key-binding docs. The value at risk is small fees, not the balance. *To be measured from the attack log.*
- **After the drill** the classical key is published. The account stays safe only while no window is ever opened and its ML-DSA-87 secret stays private.

## 7. Fraud drills on `vigil-pay-1` (19 Nov 2026)

In each drill a separately funded "evil" account registers its ML-DSA-87 key, bonds 1,000 QOR as a submitter, posts a no-op entry, and submits a batch whose state root has one hex digit flipped. Before submitting, the script builds our own fraud proof and checks it with `checkQledgerFraud`, so the chain is certain to uphold a challenge (`scripts/drill/fraud-drill.ts`).

| | Drill 1 (11:03 UTC) | Drill 2 (16:33 UTC) |
|---|---|---|
| Evidence | EVIDENCE 39–45 | EVIDENCE 48–56 |
| Wrong batch | batch 6, height 10,370,239 | batch 8, height 10,382,606 |
| Our detection | 10 s REST poll: seen at height 10,370,242 | websocket: seen ~1.6 s after the block's timestamp, judged in 10 ms |
| Upheld challenge | height 10,370,243, from **another team's watcher** (`qor1ua2d…dj5`, gas price 0.15) | height 10,382,607, the **next block**, from **our watchtower-2** (gas price 0.3, sent 254 ms after detection) |
| Our challenges | watchtower-2 in the same block, second in order: refused "batch is rejected" (fee 0.24 QOR). watchtower-1 four blocks later: refused | watchtower-2 upheld. watchtower-3 (backup) skipped after its 3 s delay |
| Slash | 1,000 QOR: 500 burned, 500 to the other team's watcher | 1,000 QOR: 500 burned, 500 to watchtower-2 |
| Recovery | Keel re-batched the entry at the reused index 6 (10,370,263), and our watchtowers judged it valid | Keel re-batched at the reused index 8 (10,382,647), and both watchtowers judged it valid in 7 ms |

**What the drills show:**
- **Safety did not depend on us winning.** In drill 1 another team's watcher won and the fraud was still slashed within one block of our own detection, because the rollup is based and anyone can challenge.
- **Detection speed decides who is paid, not whether the fraud is caught.** Drill 1 was lost on detection (a 10 s poll) and on the order within the block. Drill 2, on the websocket path, landed in the next block.
- **What drill 2 does not prove:** no other watcher's challenge landed on chain in drill 2, so "faster than other watchers in the same block" is not shown; "challenged first, in the next block" is.
- **Rollback was exercised live, twice.** The chain removed the wrong batch, rolled the inbox back (`rdk_inbox_rolled_back`), and the next honest batch reused its index.
- **Keel's other recovery paths were not exercised live.** Its blocked path and its own-batch rollback path stay covered by tests only (`packages/keel/test/sync.test.ts`).

**Cost:** each drill costs the team about 500 QOR net (the bond minus the reward, which in drill 1 went to another team), plus fees under 0.5 QOR.

### Kill the sequencer (20 Nov 2026)

The question: if the creator's sequencer dies, do users' withdrawals still go through? vigil-pay-1 is a based rollup, so any account that bonds `min_submitter_bond` (1,000 QOR) may submit batches.
- **Setup:** a second Keel, keel-b, with its own key and bond (EVIDENCE 65–67), hosted in EU West while the creator's Keel runs in US West. It runs as a **standby**: it batches only an inbox entry that has waited 30 blocks.
- **Kill:** the creator's Keel was set to dry run (it simulates and submits nothing). A user's 0.1 QOR L2 withdrawal was then posted by a non-operator account (EVIDENCE 68).
- **Takeover:** keel-b batched it as batch 11 (EVIDENCE 69), unanchored, because only the creator's key can anchor. Both watchtowers judged it valid. After the 3,600 s challenge window keel-b executed the withdrawal on L1 (EVIDENCE 72).
- **Recovery:** the creator's Keel came back, replayed keel-b's batch and batched the next entry within 5 blocks, anchored at layer height 12 (EVIDENCE 71). The chain accepts the gap at height 11. keel-b stayed in standby and did not race.
- **What went wrong:** keel-b took over after 7 blocks, not 30. The chain numbers posted data from 1, and the standby measured the wait from the last entry already batched, which was posted the day before. With the creator's Keel alive, that would have made the two sequencers race on every entry, costing the loser a fee each time. Fixed and tested before the recovery step (PR #29; §12, F5).

## 8. Operations: hosted keys and services

So that the sequencer and the watchtowers run unattended, their keys are held as secret variables by our hosting provider (Railway). Keys are set through stdin and are never printed or committed. Every key is a unified hybrid account (secp256k1 plus a registered ML-DSA-87 key) with no EVM window.

| Key | Holds | If it is stolen |
|---|---|---|
| **Creator / sequencer** (the registered drill account) | ~768 QOR liquid; 1,000 QOR bond | The thief can spend the liquid QOR and submit wrong batches. Any watchtower then challenges, so the bond is lost, which hurts us, not users. With both halves of the key it could also open an EVM window. **Users' L2 funds stay protected** while one honest watchtower is live: the pool pays only from finalized batches. |
| **watchtower-2** (primary, US West) | 15 QOR, kept low on purpose | Up to 15 QOR lost. The thief can also use up the key's sequence so its challenges fail; watchtower-3 and other teams' watchers remain. |
| **watchtower-3** (backup, EU West) | ~9.9 QOR | Up to ~9.9 QOR lost; watchtower-2 and other watchers remain. |
| **keel-b** (standby sequencer, EU West) | ~9.8 QOR liquid; 1,000 QOR bond | The thief can spend the liquid QOR and submit wrong batches; the watchtowers challenge them and the bond is lost. It cannot anchor, and users' funds stay protected while one honest watchtower is live. |

**Operating rules (each learned on testnet):**
- **Keep watchtower balances small.** About 15 QOR pays for roughly 80 challenges at about 0.18 QOR each. Rewards are swept to the creator: drill 2's 499.45 QOR went back in tx `5028C03C…9AFD`.
- **After any manual transaction from a watchtower's key, restart that watchtower.** The challenger caches its account sequence at start-up so it can sign without a round trip, and it refreshes only after a sequence-mismatch refusal. One outside transaction would otherwise cost its next challenge a refusal and a retry.
- **One running process per key.** Two sequencers, or two watchtowers, on one key clash on the account sequence. Two sequencers on *two* keys are fine: the standby waits 30 blocks before it acts. Keel resumes from chain state plus its own volume, never from memory.
- **Restarts are covered.** Railway stops the old container before starting the new one, so no key ever runs twice. During a watchtower restart (~10 s) the other watchtower keeps watching, and the challenge window is 3,600 s.

**Correlated failure.** Both watchtowers and both sequencers run on the same provider in one account (in two regions). If that account is compromised, all four keys go at once. If the provider is down, all four stop. What remains then:
- the challenge window (3,600 s);
- other teams' watchers (seen in drill 1);
- the based-rollup property, under which any bonded account may submit batches.

Moving one watchtower to a second provider is open work.
## 9. Quantum notes

- **Why no Groth16.** Groth16 (and every pairing-based SNARK) is broken by a quantum adversary: discrete logs in the pairing groups let it forge proofs. QoreChain's private-rollup path (`defi` profile, `--privacy encapsulated`) uses Groth16 over BLS12-381, so Vigil does not use it for anything that moves value.
- **Why ML-DSA-87 on L1.** Anchors, quorum checkpoints and vault authority use NIST category 5. L2 accounts are ML-DSA-44 (category 2), as qledger-v1 fixes.
- **The chain's consensus is classical.** QoreChain's validators sign blocks with classical keys: all 6 testnet validators have `/cosmos.crypto.ed25519.PubKey` consensus keys (read from `/cosmos/staking/v1beta1/validators` on 16 Nov 2026). A quantum adversary that breaks validator keys can attack L1 consensus itself, and nothing at L2 fixes that. Our post-quantum claims hold *given an honest L1*.
- **HNDL.** Payroll and identity data stay sensitive for years, which is why sealed data uses ML-KEM-1024 (live since 19 Nov, EVIDENCE 28–38). Metadata stays public (§13).

## 10. Facts we measured (and rely on)

| Fact | Measured | Where |
|---|---|---|
| `pqcVerify` (0x…0a01) accepts FIPS 204 pure ML-DSA-87 with an **empty** context; a non-empty context and the raw "internal" form both return false; one flipped bit in the message or signature, or a wrong key, returns false | 16 Nov 2026 | `scripts/spike-b-pqcverify.ts`, `test/vectors/spike-b-pqc-precompiles.json` |
| A direct `pqcVerify` call costs ~312k gas (32 B msg) to ~475k (4 KiB) by `eth_estimateGas`; calldata dominates | 16 Nov 2026 | same |
| `pqcKeyStatus` returns `(true, 1, 2592-byte key, possessionProven = true)` for a registered account and `(false, 0, 0x, false)` for an unknown one | 16 Nov 2026 | same |
| qledger-v1 replay from chain data reproduces **12 of 12** live batches on two rollups (state, withdrawals, data_hash, accumulator) | 16 Nov 2026 | `scripts/spike-a-replay.ts`, `scripts/test/replay.test.ts` |
| An inactive precompile answers with success and empty data | from QoreChain docs; our contracts revert on it (tested with an empty account) | `contracts/test/PQGuardVault.t.sol` |
| On an upheld challenge the chain emits `rdk_fraud_upheld`, slashes the bond (50% burned, 50% to the challenger), removes the rejected batch and every later unfinalized one from the batch list, and rolls the inbox back (`rdk_inbox_rolled_back`). The next batch reuses the index | 19 Nov 2026, drills 1 and 2, and earlier on `wicketgate-pay` batch 2 and `rdk-v328-e2e-mwd5v89d` batch 4 | EVIDENCE 44, 55; `packages/keel/src/sync.ts` |
| A one-entry challenge with a 149-byte proof used 343,412 gas (drill 1) and 345,265 gas (drill 2); at gas price 0.3 the fee is about 0.18 QOR | 19 Nov 2026 | EVIDENCE 44, 55; `Challenger.gasFor` |
| A challenge that loses the race fails in delivery, not at CheckTx, so it still pays its fee (0.24 QOR in drill 1) | 19 Nov 2026 | EVIDENCE 45; kit drill-1 write-up |
| Inside a contract, checking one anchor (rebuild the 144-byte message, `pqcKeyStatus`, `pqcVerify` on a 4,627-byte signature) and recording it costs **279,928 gas** (0.0315 QOR at 0.1125 uqor/gas); ten in one transaction cost 2,305,444 gas | 19 Nov 2026 | EVIDENCE 62–63 |
| `BLOCKHASH` returns zero inside a **mined** transaction too, for depths 1 to 257, and the EIP-2935 history address returns empty data (spike S3b; S3 had shown the same under `eth_call`). A contract therefore cannot authenticate a block header, so EVM code cannot prove rollup state such as a batch's status | 19 Nov 2026 | EVIDENCE 61; `contracts/src/spikes/BlockhashProbe.sol` |
| The chain numbers posted data from 1: `posted_data/{rollup}/{n}` is the n-th entry, and `consumed_sequence` is the sequence of the last batched entry, so the oldest waiting entry is `consumed_sequence + 1` | 20 Nov 2026 | `packages/keel/test/standby.test.ts` (the drill's real heights) |
| A batch from a bonded account other than the creator is accepted without an anchor (no `state_anchored`); the creator anchors again afterwards, leaving a gap in the layer heights (0–10, 12) | 20 Nov 2026 | EVIDENCE 69, 71 |
| qledger-v1 execution gives identical state roots, withdrawals roots and withdrawals in all five RDK languages: TypeScript (`@qorechain/rdk` 0.9.0), and Go, Rust, Python and Java at qorechain-rdk `2c72e47`. Measured on 10,056 generated cases, mostly valid histories mixed with mutation and edge-case families | 21 Nov 2026 | `scripts/fuzz/` (differential fuzzer) |
| Websocket detection of a new batch takes ~1.6–1.7 s after the block's timestamp; judging a prefetched batch takes 7–20 ms | 19 Nov 2026, both watchtowers | EVIDENCE 50, 55 |

## 11. Exercised so far

**Tests (20 Nov 2026):** 134 TypeScript tests (vitest) and 40 Foundry tests, all passing. 6 more vitest tests run against the live chain only when `VIGIL_LIVE=1`.

| Suite | Tests | What it pins down |
|---|---|---|
| `contracts/test/PQGuardVault.t.sol` | 21 | The guardian's ECDSA key alone cannot release, and an ECDSA signature in place of the ML-DSA-87 one fails. Fuzzing: no call from the guardian's key moves funds, and any caller with a garbage signature fails (256 runs each). Replay, redirection (recipient, amount, token, deadline), other-vault and other-chain signatures fail. Expiry; key without proof of possession; unregistered, wrong-algorithm or wrong-length keys; rotated keys invalidate old signatures. An inactive `pqcVerify` or `pqcKeyStatus` is never read as success |
| `contracts/test/SettlementReceiptVerifier.t.sol` | 19 | Run on `vigil-pay-1`'s 11 real anchors (`test/vectors/anchors-vigil-pay-1.json`). The contract's message equals the RDK's v2 anchor message byte for byte for every anchor, and every signed field, the chain id and the layer change it. A forged root, a signature replayed at another height with the same root, and another account's key all fail. The key must be registered ML-DSA-87 with possession proven and the right length. Inactive precompiles are never read as an answer. Recording: every real anchor recorded once; shared roots across heights are not conflicts; a second signed root marks the height conflicted for good; an unsigned root cannot. The chain id must match the EVM chain |
| `scripts/test/replay.test.ts` | 58 | Offline replay of recorded chain data; tampering with a state root or an inbox payload is detected |
| `packages/qledger-watchtower/test/watchtower.test.ts` | 20 | Every recorded live batch is judged valid, and no challenge against an honest batch wins. Wrong state or withdrawals roots are flagged with proofs that win. A batch built on a fraudulent root is invalid too. A rejected batch is ignored and the honest resubmission at the same index is judged on its own. A corrupted inbox archive is refused |
| `packages/qledger-watchtower/test/fast.test.ts` | 11 | Batches decoded from their submitting tx (drill 1 recording); post sequences read from events; the drill batch judged invalid on arrival with a winning proof; local signing with the cached account; one retry on a sequence mismatch; refusing a challenge the chain would not uphold; gas scaling and cap; the websocket follower. *The backup's delay and skip are exercised live only (§7)* |
| `packages/keel/test/*.test.ts` | 28 | Standby: it leaves fresh entries to the primary, takes over once the oldest waiting entry has waited the full margin, and measures that wait from the next entry, not the last batched one (the drill's real heights). Replay from empty and from a saved state; stopping before a batch that does not reproduce, and never building on it; rolling back when a challenge drops the batches Keel followed, including at a reused index; withdrawal proofs folding to the published root; snapshots that refuse tampering or another rollup |
| `packages/chain-ws/test/routes.test.ts` | 5 | The chain's protobuf descriptor snapshot matches its recorded hash. The RDK's REST routes map to the right gRPC queries, with path and query parameters encoded into the request. gRPC NotFound becomes HTTP 404; writes and unknown routes are refused |
| `packages/sealed/test/sealed.test.ts` | 12 | Envelopes open for every named recipient and nobody else, and not on another rollup or chain. An envelope inside a batch leaves its roots unchanged. Data receipts fail if any post, the accumulator or the payload changes. Recipient cards bind all three keys |

**Differential fuzzing** (`scripts/fuzz/`, not part of `pnpm test`): the same generated rollup histories run through qledger-v1 execution in all five RDK languages. The result is 10,056 cases with 0 divergences (§10). The comparator checks itself before each run.

The precompiles are mocked in Foundry. Their real behaviour is measured on testnet (§10). The deployed vault accepted a real ML-DSA-87 signature through `eth_call` (EVIDENCE 1–8). The deployed receipt verifier checked all 11 real anchors on chain (EVIDENCE 62–63), and `pnpm --filter @vigil/scripts evm:verifier status` re-checks them for free.

**Live on testnet:**
- the Q-Day Drill account (§6);
- `vigil-pay-1` deposits, transfers, a withdrawal executed on L1, and a refused second claim (EVIDENCE 15–21);
- the hosted sequencer (EVIDENCE 22–23);
- the sealed payslip (EVIDENCE 28–38);
- two fraud drills (§7);
- settlement receipts checked in the browser against the live chain (`apps/web`), and in Solidity by `SettlementReceiptVerifier` (EVIDENCE 60–63);
- a standby sequencer with its own bond taking over from the stopped creator's Keel, with the withdrawal it batched paid on L1 (EVIDENCE 65–72; §7).

**Not yet exercised:**
- quorum checkpoints;
- instant exits.

## 12. Findings

- **F1: RDK 0.9.0's watchtower validator is wrong for qledger-v1.**
  - `transitionRootValidator` (used by `watchBatches` and `qorollup watchtower --canonical`) reports **12 of 12 honest qledger batches as invalid**.
  - The CLI stays silent today only because `watchBatches` validates pending batches only, and every batch on chain is finalized.
  - On a pending honest batch it would report "a challenge would win", and `fraudProofForBatch` would build an old-rule proof that the chain rejects (error 51).
  - Reproduce: `scripts/kit-gap-check.ts`. Planned as an upstream PR (a qledger validator for `watchBatches`).
- **F2: fest ERC-20 tokens are two different balances.**
  - fUSD is an `OWNER_EXTERNAL` token pair: the faucet pays bank coins (`erc20:0x9714…`), while `fUSD.balanceOf` is the ERC-20 side (0 for every account we checked).
  - A bank send to a contract leaves bank coins that the contract's ERC-20 logic cannot move, so they are stranded.
  - Converting with `MsgConvertCoin` failed inside x/erc20 (EVIDENCE row 9). Vigil contracts therefore hold value in native QOR only until token conversion works.
- **F3: a batch index is not an identity.**
  - After an upheld challenge, the rejected batch and every later unfinalized one disappear from the batch list, and the next submission reuses the index (§10).
  - A watcher that caches judgements by index will reuse a stale verdict for a different batch.
  - A drill script that waits for a `rejected` status waits forever. Ours did, until 19 Nov; `fraud-drill.ts watch` now stops when the evil bond is slashed.
  - Vigil's tracker keys batches by `(index, state root, inbox end)` and judges them against their `prevStateRoot`.
- **F4: in a race, losing challengers pay and only the first is rewarded.**
  - The second challenge in the same block was refused in delivery and still paid 0.24 QOR (§7, drill 1).
  - The order within that block matched the gas price (0.15 ahead of 0.12). That is one sample; we have not shown that the chain orders by fee.
  - Our challenger now pays 0.3, and the backup waits 3 s and skips if the batch is already rejected, so our two watchtowers never race each other.
- **F5: posted data is numbered from 1.**
  - `posted_data/{rollup}/{n}` is the n-th entry, and `consumed_sequence` equals the sequence of the last batched entry.
  - In the 20 Nov drill our standby read `posted_data/{consumed_sequence}`, so it measured its wait from an entry batched the day before and took over after 7 blocks instead of 30 (§7).
  - Fixed in PR #29: the oldest waiting entry is `consumed_sequence + 1`. A test pins the drill's real heights.

## 13. Residual risks

- **Governance can pause a based rollup.** Its creator cannot stop it, but governance can. Funds then wait for governance.
- **Metadata is public.** QoreSeal hides content, not sizes, timing, recipient count or the poster's address.
- **Removed group members keep the keys of their old epochs.** Epoch keys protect only future messages.
- **Data availability depends on node indexing.**
  - `fetchQledgerEntries` reads post bytes back from transaction history, which nodes may prune (posted data is retained 648,000 blocks).
  - Vigil's watchtowers keep their own archive, checked against the chain's SHA-256 commitments.
- **Unanchored batches have no receipt.** When the standby sequencer batches, safety and withdrawals are unaffected (exercised: EVIDENCE 69, 72), but its batches carry no x/multilayer anchor, because only the creator's key can anchor. Batch 11 of `vigil-pay-1` is such a batch: the browser verifier and `SettlementReceiptVerifier` have no anchor to check for it.
- **Two sequencers can still race.** If the creator's Keel is slow by more than 30 blocks but not dead, both may submit the same batch index. The chain accepts the first and the loser pays a fee; no state is at risk.
- **The Solidity verifier sees signatures, not chain state.**
  - What it proves: the rollup creator's chain-registered ML-DSA-87 key signed this state root for this chain, layer and layer height.
  - What it does not prove: that the chain accepted the anchor, or that the batch is final. A creator could sign a root and never submit it, and a batch removed by a fraud proof leaves its signature valid.
  - EVM code cannot read the rollup module: the cross-VM precompile reaches only allowlisted CosmWasm contracts, and `BLOCKHASH` is zero even in a mined transaction (§10), so no header proof is possible today.
  - The conflict mark catches a creator that signs two roots for one height, but only once someone submits the second.
  - So a contract that relies on the record should wait at least the rollup's challenge window. Where settlement must be certain, check the receipt against the chain itself, as the web app does: it reads the batch record and requires the batch to be final.
- **Hosted keys (§8).**
  - Our operator keys sit with one hosting provider.
  - If that account is compromised, the attacker gets our liquid QOR and our bond, and can silence our watchtowers. Users' L2 funds stay safe only while some other watcher stays honest and online.
  - We keep watchtower balances small and sweep rewards. A second provider is open work.
- **Winning the reward is not guaranteed.** Another team's watcher won drill 1. Losing a race costs a fee, not safety.
- **Instant exits trust the quorum, not the chain.** *Not yet built.* A colluding quorum can make LPs pay an exit the chain later does not honour. Users are never at risk from this; LPs are.
- **Testnet only.** Mainnet has not applied v3.2.8, and nothing here has run on mainnet.

## 14. Instant exits (23 Nov 2026)

*Exercised on 23 Nov 2026: EVIDENCE.md rows 82 to 96. Contract: `contracts/src/InstantExitVault.sol`. Attester: `packages/qledger-watchtower/src/exits.ts`.*

A qledger-v1 withdrawal is paid on L1 only once its batch is final. `InstantExitVault` pays it early, from an LP's liquidity, once both of our watchtowers have re-executed the batch and signed for the withdrawal with ML-DSA-87.

**Flow:**
1. The user withdraws on L2 to `exitAddressOf(payout)`.
2. Each watchtower signs one claim per withdrawal of a valid, unfinalized batch and posts it into the rollup's inbox.
3. Anyone calls `front()`. The vault checks the signatures with `pqcVerify`, against keys read from `pqcKeyStatus`, and pays the payout the amount less 0.5%.
4. After finality, anyone executes the withdrawal on L1 to the exit address. `sweep()` repays the vault first and forwards the rest to the payout.

**Who trusts what:**

| Party | Trusts | Can lose |
|---|---|---|
| User | Nothing beyond the rollup. The exit address is a CREATE2 address derived from the payout; the L2 signature covers it, and it can pay only the vault (up to what was fronted) and the payout. If no one fronts (quorum offline, no liquidity, deadline passed), steps 1 and 4 alone pay the user everything after finality | The 0.5% fee, and only if the exit is fronted |
| LP | The quorum: that the batch re-executes correctly from an honest parent (so no challenge can remove it), that the claim names the withdrawal the batch really contains, and that the deadline falls before the batch can be final | At most its liquidity, if both quorum keys sign a false claim |
| Quorum members | Nothing. They sign what they re-executed | Nothing |

**Why the authorisation is sound:**
- **What a claim binds:** the evm chain id, the vault, the chain and rollup ids, the batch index and state root, the withdrawal index, the amount, the recipient and a deadline. A signature cannot be moved to another vault, chain, rollup, batch, root (a reused index after a rollback is a different exit), withdrawal, amount or payout. `simulate` and the Foundry tests check each field.
- **No double payment:** the vault fronts an exit at most once, and only before the signed deadline. The watchtower sets the deadline 10 minutes before the batch could be final, and the chain pays a withdrawal on L1 only once final, so a withdrawal already paid on L1 cannot also be fronted.
- **Keys:** watchtower keys sign in their own process and post into the inbox with their existing hybrid-signed transactions. They never open an EVM window. A relayer submits `front()` from a window scoped to the vault alone (EVIDENCE 90).
- **Ancestors:** the watchtower attests only a batch whose parent an honest replay reaches. Every unfinalized ancestor is therefore honest too, and no upheld challenge on an earlier batch can roll the fronted withdrawal back.

**Residual risks:**
- **Same operator.** The quorum is two hot keys run by one team on Railway (§8). Stealing both lets a thief drain the LP's liquidity with false claims, but no user's funds. A production LP should choose quorum members run by different operators.
- **Bad claim, user debt.** If the quorum signs a claim for a payout that never withdrew, that payout's exit address owes the vault, and its later withdrawals repay that first. The payout did receive the money, so it loses at most the fee, but a compromised quorum can push money onto an address and later take it back.
- **The deadline depends on clocks and the signed window.** The vault compares the deadline with `block.timestamp`. A quorum that signs a deadline after finality removes the double-payment protection. Again this risks the LP's liquidity only.
- **Relaying is manual** in this demo (EVIDENCE 91: 68 blocks after the batch). Automating the relayer is straightforward and changes no trust.

## 15. Change log

| Version | Date | Change |
|---|---|---|
| v0 | 2026-11-16 | First version: assets, adversaries, assumptions, drill design, measured precompile facts, the RDK validator finding |
| v1.4 | 2026-11-23 | Instant exits (§14): the vault, the attesting watchtowers, who trusts what, and the residual risks. Exercised end to end on vigil-pay-1 (EVIDENCE 82 to 96) |
| v1.3 | 2026-11-21 | Differential fuzzing of qledger-v1 across the RDK's five languages: 10,056 cases, 0 divergences (§10, §11) |
| v1.2 | 2026-11-20 | Kill-the-sequencer drill (§7): standby sequencer keel-b, takeover, recovery with a gap in anchor heights, and our off-by-one (F5). keel-b in the key table (§8). Two chain facts (§10). Keel tests (§11). Unanchored batches and sequencer races (§13) |
| v1.1 | 2026-11-19 | Receipts verified in Solidity: `SettlementReceiptVerifier` (§1, §5), its measured cost and spike S3b (`BLOCKHASH` zero in mined transactions, §10), 19 new Foundry tests and the chain-ws suite (§11), receipt checks in the browser and in Solidity moved to "exercised", and what the contract does not prove (§13) |
| v1 | 2026-11-19 | Adds the live rollup, the two fraud drills (§7), hosted keys and operating rules (§8), new measured facts on challenges and rollback, the test inventory, findings F3–F4, and residual risks for hosted keys and challenge races. The Q-Day Drill section now records that the registered drill account became the rollup creator and has never opened a window |
