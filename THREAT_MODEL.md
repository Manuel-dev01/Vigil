# Vigil threat model

**Version 0, 16 November 2026 (UTC).** Testnet only (`qorechain-diana`, chain v3.2.8). This document separates what is **exercised** (backed by a test or a row in [EVIDENCE.md](EVIDENCE.md)) from what is **designed but not yet exercised**. Nothing here claims that Vigil is "quantum-proof". The claim is narrower: no step that moves value depends on a classical signature or a pairing-based proof, and each remaining classical dependency is named below.

## 1. System in one paragraph

Vigil is a qledger-v1 **based optimistic rollup** on QoreChain.
- **Ordering:** users' ML-DSA-44-signed L2 transactions are posted to the chain's rollup inbox (`MsgPostRollupData`), so the order is fixed when L1 includes each post.
- **Settlement:** a sequencer settles inbox ranges in batches that carry the creator's ML-DSA-87 anchor signature. The chain re-executes a batch when it is challenged (`MsgChallengeBatch`) and pays withdrawals from its deposit pool, but only from finalized batches.
- **Watchtowers:** they re-execute every batch from chain data and challenge wrong ones. They also sign ML-DSA-87 checkpoints that EVM contracts verify through the `pqcVerify` precompile.
- **Confidential data:** it travels as ML-KEM-1024 envelopes inside the same inbox.

## 2. Assets

| Asset | Where it lives | What loss looks like |
|---|---|---|
| Deposit pool | x/rdk, per rollup | A withdrawal paid that the honest ledger does not owe |
| L2 balances | qledger state (SHA-256 sparse Merkle tree) | A transfer or withdrawal without the account's ML-DSA-44 signature |
| Submitter bonds | x/rdk | Slashed when the submitter was honest, or kept when it was not |
| Sealed payment data | ML-KEM-1024 envelopes in the inbox | Plaintext readable by anyone other than the named recipients, now or later |
| Receipt integrity | x/multilayer anchors, settlement receipts | A receipt that verifies for a state the chain never settled |
| Vault liquidity | `PQGuardVault`, later `InstantExitVault` | Funds moved without the required ML-DSA-87 signature(s) |
| Liveness | sequencer, watchtowers, relay | Users unable to exit, or fraud left unchallenged within the window |

## 3. Adversaries

1. **Classical-key thief / Q-Day attacker.** Holds or can derive any secp256k1 private key (theft today; Shor's algorithm later). It can also break pairing-based proofs (Groth16, BLS12-381) and ECDSA signatures.
2. **Harvest-now-decrypt-later (HNDL) collector.** Records every post today and decrypts later with a quantum computer, or with any future break of the classical half of a hybrid scheme.
3. **Malicious sequencer.** Publishes a wrong state root or withdrawals root, censors, or stops.
4. **Malicious watchtowers.** A minority that lies or stays silent; or, for instant exits only, a colluding quorum.
5. **Chain-level adversaries.** A censoring proposer; a governance pause of a based rollup; a network attacker between users and endpoints.
6. **Griefer.** Spends its own fees to make our accounts or services do useless work.

## 4. Trust assumptions

- QoreChain re-executes qledger-v1 batches correctly when challenged, and enforces its own ante rules: the hybrid signature requirement, EVM windows, and the first-registration exemption only for key-less accounts.
- **ML-DSA-44 and ML-DSA-87 are EUF-CMA secure. ML-KEM-1024 is IND-CCA2 secure.** These are NIST FIPS 204 and FIPS 203.
- **SHA-256 and SHAKE-256 are collision-resistant and preimage-resistant.** Grover's algorithm roughly halves preimage security, leaving about 128 bits.
- At least one honest, online watchtower per challenge window (3,600 s on testnet).
- L1 liveness: posts and challenges are included within the window.
- The `pqcVerify` and `pqcKeyStatus` precompiles behave as observed (§8).

## 5. Why each design choice resists the adversaries above

| Choice | Against | Note |
|---|---|---|
| **No classical-key authority anywhere.** Contracts have no owner and never check `msg.sender` for authority. Every authorisation is an ML-DSA-87 signature checked with `pqcVerify` against a key read from `pqcKeyStatus` with `possessionProven == true` | 1 | A stolen secp256k1 key can still *call* our contracts, but it cannot authorise anything. Exercised in tests (§9). |
| **L2 accounts are ML-DSA-44 only** (fixed by qledger-v1) | 1 | No classical key exists at L2. ML-DSA-44 is NIST category 2, a property of qledger-v1 that we cannot change. |
| **Optimistic re-execution, no SNARK** | 1, 3 | Fraud proofs rest on hashes and re-execution only: no pairings, no trusted setup. We reject Groth16 for anything that moves value, because its soundness falls to Shor. |
| **Based sequencing** | 3, 5 | Anyone can post, and any bonded account can submit batches, so a dead sequencer cannot freeze funds. Ordering is fixed at L1 inclusion, so the honest result is computable by anyone right away. |
| **Watchtower re-execution from chain data** | 3 | We replay the inbox with the RDK's `executeQledger`. RDK 0.9.0's built-in `transitionRootValidator` applies the old transition-root rule and calls every honest qledger batch invalid (§10), so it is not used. |
| **Hybrid L1 accounts plus closed EVM windows** | 1 | A Native-lane transaction needs the account's ML-DSA-87 signature as well as the classical one. An EVM transaction (signed classically only) is admitted only inside a window that was opened by a hybrid-signed message. With no window open, the classical key alone moves nothing on either lane. |
| **Domain-separated signed messages** | 1, 6 | `pqcVerify` accepts only FIPS 204 pure ML-DSA-87 with an *empty* context (measured, §8), so every Vigil message carries its own tag in the message bytes (e.g. `vigil/pqguard/v1`), plus the chain id, the contract address and a nonce. |
| **ML-KEM-1024 + X25519 envelopes (QoreSeal)** | 2 | Confidentiality holds if *either* ML-KEM-1024 or X25519 holds. Post-quantum confidentiality rests on ML-KEM-1024. |

## 6. The Q-Day Drill (18 Nov 2026)

**Setup.** *Designed; not yet exercised on chain. Rows are added as each step lands.*
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

**Our own transaction during the drill:** one Native-lane, hybrid-signed transaction from the drill account (for example a small `MsgPostRollupData` post). Its hash goes in EVIDENCE.md and on the project page.

**Residual drill risks we accept:**
- **Fee griefing.** Whether a refused transaction costs the drill account a fee depends on where the chain refuses it. A refused second registration "still takes the fee" according to the key-binding docs. The value at risk is small fees, not the balance. *To be measured from the attack log.*
- **After the drill** the classical key is published. The account stays safe only while no window is ever opened and its ML-DSA-87 secret stays private.

## 7. Quantum notes

- **Why no Groth16.** Groth16 (and every pairing-based SNARK) is broken by a quantum adversary: discrete logs in the pairing groups let it forge proofs. QoreChain's private-rollup path (`defi` profile, `--privacy encapsulated`) uses Groth16 over BLS12-381, so Vigil does not use it for anything that moves value.
- **Why ML-DSA-87 on L1.** Anchors, quorum checkpoints and vault authority use NIST category 5. L2 accounts are ML-DSA-44 (category 2), as qledger-v1 fixes.
- **The chain's consensus is classical.** QoreChain's validators sign blocks with classical keys: all 6 testnet validators have `/cosmos.crypto.ed25519.PubKey` consensus keys (read from `/cosmos/staking/v1beta1/validators` on 16 Nov 2026). A quantum adversary that breaks validator keys can attack L1 consensus itself, and nothing at L2 fixes that. Our post-quantum claims hold *given an honest L1*.
- **HNDL.** Payroll and identity data stay sensitive for years, which is why sealed data uses ML-KEM-1024. Metadata stays public (§11).

## 8. Facts we measured (and rely on)

| Fact | Measured | Where |
|---|---|---|
| `pqcVerify` (0x…0a01) accepts FIPS 204 pure ML-DSA-87 with an **empty** context; a non-empty context and the raw "internal" form both return false; one flipped bit in the message or signature, or a wrong key, returns false | 16 Nov 2026 | `scripts/spike-b-pqcverify.ts`, `test/vectors/spike-b-pqc-precompiles.json` |
| A direct `pqcVerify` call costs ~312k gas (32 B msg) to ~475k (4 KiB) by `eth_estimateGas`; calldata dominates | 16 Nov 2026 | same |
| `pqcKeyStatus` returns `(true, 1, 2592-byte key, possessionProven = true)` for a registered account and `(false, 0, 0x, false)` for an unknown one | 16 Nov 2026 | same |
| qledger-v1 replay from chain data reproduces **12 of 12** live batches on two rollups (state, withdrawals, data_hash, accumulator) | 16 Nov 2026 | `scripts/spike-a-replay.ts`, `scripts/test/replay.test.ts` |
| An inactive precompile answers with success and empty data | from QoreChain docs; our contracts revert on it (tested with an empty account) | `contracts/test/PQGuardVault.t.sol` |

## 9. Exercised so far (tests)

- `contracts/test/PQGuardVault.t.sol`: 21 tests, all passing.
  - The guardian's ECDSA key alone cannot release. An ECDSA signature in place of the ML-DSA-87 one fails.
  - Fuzzing: no call from the guardian's key moves funds (256 runs), and any caller with a garbage signature fails (256 runs).
  - Replay, redirection (recipient, amount, token, deadline), other-vault and other-chain signatures fail.
  - Expiry; key without proof of possession; unregistered, wrong-algorithm or wrong-length keys; rotated keys invalidate old signatures.
  - An inactive `pqcVerify` or `pqcKeyStatus` is never read as success.
  - The precompiles are mocked locally. The real behaviour is measured on testnet (§8), and the deployed vault will be checked with a real ML-DSA-87 signature through `eth_call` (`scripts/drill/deploy-vault.ts verify`).
- `scripts/test/replay.test.ts`: offline replay of recorded chain data, plus tamper detection for a state root and for an inbox payload.

## 10. Findings

- **RDK 0.9.0's watchtower validator is wrong for qledger-v1.** `transitionRootValidator` (used by `watchBatches` and `qorollup watchtower --canonical`) reports **12 of 12 honest qledger batches as invalid**. The CLI stays silent today only because `watchBatches` validates pending batches only, and every batch on chain is finalized. On a pending honest batch it would report "a challenge would win", and `fraudProofForBatch` would build an old-rule proof that the chain rejects (error 51). Reproduce: `scripts/kit-gap-check.ts`. To be reported upstream.

## 11. Residual risks

- **Governance can pause a based rollup.** Its creator cannot stop it, but governance can. Funds then wait for governance.
- **Metadata is public.** QoreSeal hides content, not sizes, timing, recipient count or the poster's address.
- **Removed group members keep the keys of their old epochs.** Epoch keys protect only future messages.
- **Data availability depends on node indexing.** `fetchQledgerEntries` reads post bytes back from transaction history, which nodes may prune (posted data is retained 648,000 blocks). Vigil's watchtowers keep their own archive, checked against the chain's SHA-256 commitments.
- **Unanchored batches have no receipt.** If the creator's sequencer dies and a bonded watchtower takes over, safety and withdrawals are unaffected, but those batches carry no x/multilayer anchor, because only the creator's batches are anchored.
- **Instant exits trust the quorum, not the chain.** *Not yet built.* A colluding quorum can make LPs pay an exit the chain later does not honour. Users are never at risk from this; LPs are.
- **Testnet only.** Mainnet has not applied v3.2.8, and nothing here has run on mainnet.

## 12. Change log

| Version | Date | Change |
|---|---|---|
| v0 | 2026-11-16 | First version: assets, adversaries, assumptions, drill design, measured precompile facts, the RDK validator finding |
