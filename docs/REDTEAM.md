# Attack catalogue

`pnpm redteam` tries to break Vigil's three deployed contracts the way an attacker would, and records what each one answered. Every attack and control is a free `eth_call` to the public EVM endpoint, after a few other read-only requests (the head block, the vault's deploy transaction, and the nonces and messages to sign over): no real key signs anything, no transaction is sent and nothing changes on chain.

**Run of 27 Nov 2026, 17:38 UTC, at EVM block 10,862,041: 23 of 23 attacks refused, 23 of them with the custom error we expected; 3 of 3 honest controls passed.** The answers are the contracts' own, from chain state as evm-testnet.qore.host reports it (32 requests, at least 1.1 s apart). The raw results are in [redteam.json](redteam.json).

## Re-run it

```bash
pnpm install
pnpm redteam           # prints every answer; exits 1 if one differs from the expected one, 2 if a case could not run
pnpm redteam --write   # also rewrites this file and docs/redteam.json, only from a run in which every case ran
```

The attacks that replay the two real exits run at the blocks just before and just after each was paid, when the signatures were still in date. They need an endpoint that still serves state at those blocks. When it no longer does, those rows say "not run" instead of an answer; the rows at the head block still run.

## What it uses

- **The watchtowers' real exit attestations**, read from the rollup's public inbox archive (`data/inbox/vigil-pay-1.jsonl`): entries 18 and 19 for batch 15's exit, 21 and 22 for batch 18's (EVIDENCE 88, 89, 101, 102). Controls C1 and C2 show that these signatures pass.
- **The creator's real anchors** for layer heights 0 to 10, as recorded from the chain in `test/vectors/anchors-vigil-pay-1.json` (EVIDENCE 16, 36, 38, 62 and 63 for the ones used here).
- **Two throwaway keys**, an ML-DSA-87 key and a secp256k1 key, made in memory for the run and never saved. They play an attacker who has keys of their own but not ours. The attacker's address is the secp256k1 key's (this run: `0xBE9f8c7eedCDceB26453DA31d3330f5A37Cf8E92`).
- **The deployed addresses** in `deployments/diana.json`.

## Results

### InstantExitVault `0x3a897802b62b052a102f55e021bc4668539c29b5`

Pays a withdrawal before its batch is final, once both watchtowers have signed it with ML-DSA-87 (THREAT_MODEL §14).

| # | Attempt | What was sent | Call, block | Answer |
|---|---|---|---|---|
| C1 | **Control:** Front batch 15's exit with both real signatures | The exit exactly as both watchtowers signed it, one block before it was really paid (tx 0x9705770b52cdb3448277915a778f1e0e6ba4c8ffddcb2ae4ae6d574416637933).<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `ok` ✓ |
| C2 | **Control:** Front batch 18's exit with both real signatures | The exit exactly as both watchtowers signed it, one block before the relayer paid it (tx 0x6542b5f393cd4b37f349ef3b2e9edfe103d81b2f675d4ee48c0bd2f2de627c8f).<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,686,384 | `ok` ✓ |
| A01 | One bit of a quorum signature changed | watchtower-2's real ML-DSA-87 signature with one bit of byte 100 flipped.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `BadSignature(0)` ✓ |
| A02 | Signed by a key that is not a quorum member | A fresh ML-DSA-87 key, made for this run, signs the exact exit message in watchtower-2's place.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `BadSignature(0)` ✓ |
| A03 | A classical signature instead of ML-DSA-87 | A fresh secp256k1 key signs the exit message with ECDSA (65 bytes) in watchtower-2's place.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `BadSignature(0)` ✓ |
| A04 | Only one member signs | watchtower-2's real signature alone; the vault needs both.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `NotEnoughSigners()` ✓ |
| A05 | One member counted twice | watchtower-2's real signature given twice, as signers 0 and 0.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `SignersNotAscending()` ✓ |
| A06 | Signatures swapped between members | watchtower-3's real signature in watchtower-2's slot, and the other way round.<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,686,384 | `BadSignature(0)` ✓ |
| A07 | Amount raised | Both real signatures, with the amount raised from 0.1 QOR to 100 QOR.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `BadSignature(0)` ✓ |
| A08 | Payout changed to the attacker | Both real signatures, with the attacker's address as the payout.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,907 | `BadSignature(0)` ✓ |
| A09 | Another withdrawal | Both real signatures, claimed for withdrawal 5 instead of 4.<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,686,384 | `BadSignature(0)` ✓ |
| A10 | Another batch | Both real signatures, claimed for batch 19 instead of 18.<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,686,384 | `BadSignature(0)` ✓ |
| A11 | Deadline pushed back | Both real signatures, with the deadline a day later, past the time the batch could be final.<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,686,384 | `BadSignature(0)` ✓ |
| A12 | The same exit fronted again | Both real signatures, one block after batch 15's exit was paid.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19 | `front`, 10,629,909 | `AlreadyFronted()` ✓ |
| A13 | The same exit fronted again | Both real signatures, one block after batch 18's exit was paid.<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,686,386 | `AlreadyFronted()` ✓ |
| A14 | Fronted after its deadline | Both real signatures for batch 18's exit, at the run's head block.<br>EVIDENCE 101, 102, 104; inbox entries 21 and 22 | `front`, 10,862,041 | `Expired()` ✓ |
| A15 | Replayed at another vault | Both real signatures, sent to an exact copy of the vault (its own deploy-tx input: the same chain, rollup, quorum and LP) run in place at another address; nothing is deployed. Only the vault's address differs, and every exit message names it.<br>EVIDENCE 88, 89, 91; inbox entries 18 and 19; deploy tx (EVIDENCE 83) | `front`, 10,629,907 | `BadSignature(0)` ✓ |
| A16 | Take the LP's liquidity without the LP's key | A fresh ML-DSA-87 key signs the vault's exact withdrawal message for 1 QOR to the attacker, at the vault's current nonce.<br>EVIDENCE 83, 85 | `withdrawLiquidity`, 10,862,041 | `BadSignature(max)` ✓ |
| A17 | Call settle as someone other than the payout's exit address | The attacker calls settle for the real payout, sending no value. Only the caller check is exercised: settle lowers a debt only by the value sent, and the payout owed nothing once the vault was repaid (EVIDENCE 108).<br>EVIDENCE 95, 108 | `settle`, 10,862,041 | `NotExitAddress()` ✓ |

### SettlementReceiptVerifier `0xc87c7680b70e21464aac4e2308a9caa5324e4590`

Records a rollup anchor once the creator's ML-DSA-87 signature verifies through `pqcVerify` (THREAT_MODEL §5).

| # | Attempt | What was sent | Call, block | Answer |
|---|---|---|---|---|
| C3 | **Control:** Attest the creator's real anchor at layer height 0 | The anchor as the chain stores it. It is already on the contract's record, so the call succeeds and records nothing new.<br>EVIDENCE 16, 62 | `attest`, 10,862,041 | `ok` ✓ |
| A18 | A state root the creator never signed | The real anchor at layer height 0 with the top bit of its state root flipped.<br>EVIDENCE 16, 62 | `attest`, 10,862,041 | `InvalidAnchor(BadSignature)` ✓ |
| A19 | A signature moved to another layer height | Heights 4 and 5 carry the same state root; height 4's real signature is presented for height 5.<br>EVIDENCE 36, 38, 63 | `attest`, 10,862,041 | `InvalidAnchor(BadSignature)` ✓ |
| A20 | Signed by a key that is not the creator's | A fresh ML-DSA-87 key signs the exact v2 anchor message for layer height 0.<br>EVIDENCE 16, 62 | `attest`, 10,862,041 | `InvalidAnchor(BadSignature)` ✓ |
| A21 | A classical signature instead of ML-DSA-87 | The ECDSA signature from the fresh secp256k1 key (65 bytes) in place of the anchor's signature.<br>EVIDENCE 16, 62 | `attest`, 10,862,041 | `InvalidAnchor(BadSignatureLength)` ✓ |

### PQGuardVault `0x40b6b90d69b4a6e2277583ff7d98912c03255591`

The vault prepared for the Q-Day Drill on a second account (not the registered drill target, THREAT_MODEL §6), funded with 25 QOR (EVIDENCE 8): funds move only with the guardian's ML-DSA-87 signature.

| # | Attempt | What was sent | Call, block | Answer |
|---|---|---|---|---|
| A22 | Release the vault's QOR without the guardian's key | A fresh ML-DSA-87 key signs the vault's exact release message for 25 QOR to the attacker, at the vault's current nonce.<br>EVIDENCE 6, 8 | `release`, 10,862,041 | `BadSignature()` ✓ |
| A23 | A classical signature instead of ML-DSA-87 | The same release with the fresh secp256k1 key's ECDSA signature (65 bytes).<br>EVIDENCE 6, 8 | `release`, 10,862,041 | `BadSignature()` ✓ |

## What this shows, and what it does not

- **Each answer is the deployed contract's own revert, decoded to its named custom error.** `eth_call` runs the same code a transaction would. For the honest inputs the answers match what was mined: C1 passes one block before the same exit was paid by a mined `front` (EVIDENCE 91), C2 likewise (EVIDENCE 104), and `attest` was mined for the anchor in C3 (EVIDENCE 62).
- **The endpoint is trusted, as everywhere else in Vigil.** A dishonest node could answer falsely; the answers are not proven (README, Limitations).
- **It is a small catalogue: the 23 attacks we thought of.** Refusing them is not a proof that no attack works. The Foundry suites in `contracts/test/` check the same properties against mocked precompiles, with fuzzing and invariants (THREAT_MODEL §11), and THREAT_MODEL §12 lists what our reviewers found.
- **Not exercised here:** a PQGuardVault release with a real guardian signature and a changed amount, which needs the guardian's key (`test_RedirectedRecipientOrAmountFails` covers it in Foundry, and THREAT_MODEL §6 records the live check of 17 Nov); a changed rollup id or chain id on its own, because a copy run in place always has another address, and the constructor accepts only `qorechain-diana` on EVM chain 9800 (the rollup id and both chain ids are in every exit message, pinned byte for byte by `test_exitMessageLayout`); and a quorum or LP key that is stolen or colludes, which is a design risk rather than a bug (THREAT_MODEL §13 and §14).

*Generated by `scripts/redteam.ts`; the cases are in `scripts/lib/redteam.ts`.*
