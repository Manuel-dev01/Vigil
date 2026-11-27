# Cryptographic inventory mapped to EU NIS Cooperation Group PQC roadmap

> **Disclaimer.** QoreScan output is an inventory aid. It is not a certification, an audit or a legal opinion, and it does not establish conformity with any regulation or standard. The mapping below shows where the inventory can serve as input; whether an organisation meets a requirement depends on facts outside the scan and is for the organisation and its advisers to assess.

| | |
|---|---|
| CBOM | `urn:uuid:4c6adde5-c80b-5f84-812b-de36dbe97e17` |
| Generated | 2026-11-27T17:15:15Z by qorescan 0.1.0 |
| Chain | `qorechain-diana` |
| Scanned | chain, solidity, tls |

## Framework mapping

| Roadmap item | Expectation (paraphrased) | What this inventory provides | Status |
|---|---|---|---|
| First Steps: cryptographic asset management | Create and maintain inventories of assets that perform or rely on cryptographic operations; a standardised format such as CBOM is recommended. | CBOM with 15 algorithms (8 quantum-vulnerable, 2 post-quantum, 1 hybrid), 4 protocols, 7 certificates, 29 key records, in CycloneDX 1.6. | Input for the scanned scope |
| Milestone 1 (31.12.2026) | Member States: First Steps implemented, national roadmaps in place, transition planning and pilots for high- and medium-risk use cases started. | Nothing: planning measure. | _To be completed._ |
| Milestone 2 (31.12.2030) | Transition of high-risk use cases completed; post-quantum software and firmware upgrades enabled by default. | 8 quantum-vulnerable algorithms listed below with their evidence. | Risk classification per use case _to be completed._ |
| Milestone 3 (31.12.2035) | Transition of medium-risk use cases completed; low-risk use cases as far as feasible. | Same list; NIST IR 8547 disallows the listed families after 2035. | _To be completed._ |
| Cryptographic agility | Support crypto-agility and an upgrade path when products are developed. | Scanned evidence: native-lane hybrid signature mode required; algorithm migration dual-signature period of 1000000 blocks (module parameter). | Evidence listed; assessment _to be completed._ |

## Summary

| Classification | Algorithms |
|---|---|
| post-quantum | 2: ML-DSA-87, ML-KEM-1024 |
| hybrid | 1: X25519MLKEM768 |
| quantum-vulnerable | 8: ECDSA P-256, ECDSA P-384, ECDSA secp256k1, ECDSA with SHA-256, ECDSA with SHA-384, Ed25519, RSA PKCS#1 v1.5 with SHA-256, X25519 |
| symmetric | 4: AES-128-GCM, HKDF-SHA256, Keccak-256, SHA-256 |

NIST IR 8547 deprecates quantum-vulnerable public-key algorithms (RSA, ECDSA, EdDSA, finite-field and elliptic-curve DH) after 2030 and disallows them under NIST standards after 2035; applications may be given earlier dates.

## Algorithms and status

| Algorithm | Primitive | Parameter set | NIST category | FIPS 203/204/205 | NIST IR 8547 | Evidence |
|---|---|---|---|---|---|---|
| ECDSA P-256 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `api-testnet.qore.host:443` (+6 more) |
| ECDSA P-384 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `api-testnet.qore.host:443` (+5 more) |
| ECDSA secp256k1 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `https://api-testnet.qore.host/cosmos/evm/vm/v1/params` (+11 more) |
| ECDSA with SHA-256 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `api-testnet.qore.host:443` (+2 more) |
| ECDSA with SHA-384 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `api-testnet.qore.host:443` (+5 more) |
| Ed25519 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `https://api-testnet.qore.host/cosmos/base/tendermint/v1beta1/validatorsets/latest?pagination.limit=1000` |
| RSA PKCS#1 v1.5 with SHA-256 | signature | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `api-testnet.qore.host:443` (+3 more) |
| X25519 | key-agree | - | 0 | not covered (quantum-vulnerable) | Deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `vigil-pq.up.railway.app:443` |
| X25519MLKEM768 | kem | 768 | 3 | hybrid; PQ part per FIPS 203 | Hybrid: post-quantum component approved; classical component deprecated after 2030, disallowed after 2035 (NIST IR 8547) | `api-testnet.qore.host:443` (+2 more) |
| ML-DSA-87 | signature | 87 | 5 | FIPS 204 | Not scheduled for deprecation by NIST IR 8547 | `InstantExitVault.sol:4` (+20 more) |
| ML-KEM-1024 | kem | 1024 | 5 | FIPS 203 | Not scheduled for deprecation by NIST IR 8547 | `https://api-testnet.qore.host/qorechain/pqc/v1/kem/qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws` |
| AES-128-GCM | ae | 128 | 1 | not applicable (symmetric or hash) | Not scheduled for deprecation by NIST IR 8547 | `api-testnet.qore.host:443` (+3 more) |
| HKDF-SHA256 | kdf | 256 | not defined | not applicable (symmetric or hash) | Not scheduled for deprecation by NIST IR 8547 | `api-testnet.qore.host:443` (+3 more) |
| Keccak-256 | hash | 256 | not defined | not applicable (symmetric or hash) | Not a NIST-standardised algorithm; not scheduled by NIST IR 8547 | `InstantExitVault.sol:101` (+9 more) |
| SHA-256 | hash | 256 | 2 | not applicable (symmetric or hash) | Not scheduled for deprecation by NIST IR 8547 | `api-testnet.qore.host:443` (+3 more) |

## Protocols

| Protocol | Version | Cipher suite | Key exchange | Algorithms |
|---|---|---|---|---|
| TLS 1.3 at api-testnet.qore.host:443 | 1.3 | TLS_AES_128_GCM_SHA256 | X25519MLKEM768 | X25519MLKEM768, AES-128-GCM, HKDF-SHA256, SHA-256, ECDSA P-256 |
| TLS 1.3 at evm-testnet.qore.host:443 | 1.3 | TLS_AES_128_GCM_SHA256 | X25519MLKEM768 | X25519MLKEM768, AES-128-GCM, HKDF-SHA256, SHA-256, ECDSA P-256 |
| TLS 1.3 at rpc-testnet.qore.host:443 | 1.3 | TLS_AES_128_GCM_SHA256 | X25519MLKEM768 | X25519MLKEM768, AES-128-GCM, HKDF-SHA256, SHA-256, ECDSA P-256 |
| TLS 1.3 at vigil-pq.up.railway.app:443 | 1.3 | TLS_AES_128_GCM_SHA256 | X25519 | X25519, AES-128-GCM, HKDF-SHA256, SHA-256, ECDSA P-256 |

## Certificates

| Certificate | Public key | Signature | Valid until | Chain |
|---|---|---|---|---|
| Certificate Root YE | ECDSA P-384 | ECDSA with SHA-384 | 2032-09-02T23:59:59Z | - |
| Certificate WE1 | ECDSA P-256 | ECDSA with SHA-384 | 2029-02-20T14:00:00Z | - |
| Certificate qore.host | ECDSA P-256 | ECDSA with SHA-256 | 2027-01-09T22:24:55Z | verified against the system roots |
| Certificate *.up.railway.app | ECDSA P-256 | ECDSA with SHA-384 | 2027-02-24T03:01:42Z | verified against the system roots |
| Certificate GTS Root R4 | ECDSA P-384 | RSA PKCS#1 v1.5 with SHA-256 | 2028-01-28T00:00:42Z | - |
| Certificate YE2 | ECDSA P-384 | ECDSA with SHA-384 | 2028-09-02T23:59:59Z | - |
| Certificate ISRG Root X2 | ECDSA P-384 | RSA PKCS#1 v1.5 with SHA-256 | 2032-09-02T23:59:59Z | - |

## Keys

QoreScan records public keys and key types only; it never reads private key values.

| Key | Type | Algorithm | Count | Evidence |
|---|---|---|---|---|
| Account classical public key qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l` |
| Account classical public key qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6 | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6` |
| Account classical public key qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft` |
| Account classical public key qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv` |
| Account classical public key qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws` |
| Account classical public key qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m` |
| Account classical public key qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn` |
| Account classical public key qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd` |
| Account classical public key qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33 | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33` |
| Account classical public key qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s | public-key | ECDSA secp256k1 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s` |
| Account KEM public key qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws | public-key | ML-KEM-1024 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/kem/qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws` |
| Account PQC public key qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l` |
| Account PQC public key qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6 | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6` |
| Account PQC public key qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft` |
| Account PQC public key qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv` |
| Account PQC public key qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws` |
| Account PQC public key qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m` |
| Account PQC public key qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn` |
| Account PQC public key qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd` |
| Account PQC public key qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33 | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33` |
| Account PQC public key qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s | public-key | ML-DSA-87 | - | `https://api-testnet.qore.host/qorechain/pqc/v1/account/qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s` |
| Active validator consensus public keys (Ed25519) | public-key | Ed25519 | 4 | `https://api-testnet.qore.host/cosmos/base/tendermint/v1beta1/validatorsets/latest?pagination.limit=1000` |
| Certificate public key (ECDSA P-384) | public-key | ECDSA P-384 | - | `vigil-pq.up.railway.app:443` |
| Certificate public key (ECDSA P-256) | public-key | ECDSA P-256 | - | `api-testnet.qore.host:443` (+2 more) |
| Certificate public key (ECDSA P-384) | public-key | ECDSA P-384 | - | `api-testnet.qore.host:443` (+2 more) |
| Certificate public key (ECDSA P-384) | public-key | ECDSA P-384 | - | `vigil-pq.up.railway.app:443` |
| Certificate public key (ECDSA P-384) | public-key | ECDSA P-384 | - | `vigil-pq.up.railway.app:443` |
| Certificate public key (ECDSA P-256) | public-key | ECDSA P-256 | - | `api-testnet.qore.host:443` (+2 more) |
| Certificate public key (ECDSA P-256) | public-key | ECDSA P-256 | - | `vigil-pq.up.railway.app:443` |

## Libraries

| Library | Provides | Evidence |
|---|---|---|
| qorechain IQorePQC | ML-DSA-87 | `InstantExitVault.sol:4` (+2 more) |

## Scanned facts

| Fact | Value |
|---|---|
| `chain:account-pqc-status` | qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s: hybrid key, dilithium5; qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft: hybrid key, dilithium5; qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd: hybrid key, dilithium5; qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33: hybrid key, dilithium5; qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l: hybrid key, dilithium5; qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6: hybrid key, dilithium5; qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn: hybrid key, dilithium5; qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws: hybrid key, dilithium5; qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv: hybrid key, dilithium5; qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m: hybrid key, dilithium5 |
| `chain:consensus-engine-version` | 0.38.26 |
| `chain:evm:active-precompile` | crossVmBridge (0x0000000000000000000000000000000000000901); rlConsensusParams (0x0000000000000000000000000000000000000C01); pqcVerify (0x0000000000000000000000000000000000000a01); pqcKeyStatus (0x0000000000000000000000000000000000000a02) |
| `chain:id` | qorechain-diana |
| `chain:network` | testnet |
| `chain:pqc:allow-classical-fallback` | false |
| `chain:pqc:default-migration-blocks` | 1000000 |
| `chain:pqc:hybrid-signature-mode` | required |
| `chain:pqc:min-security-level` | 5 |
| `chain:pqc:pqc-primary` | true |
| `chain:protocol-feature` | pqc-sign-bytes-v2; evm-pqc-authorisation-window; pqc-ecdsa-pubkey-validation; pqc-keyed-account-maintenance-hybrid; pqc-registration-integrity; pqc-rotation-replay-guard; pqc-algorithm-governance-guards; pqc-hybrid-single-extension; pqc-keyless-extension-closed; evm-pqc-window-targets; pqc-possession-flag; pqc-kem-registry; pqc-rotate-key-size-check; pqc-verify-once-per-signer; pqc-multisig; pqc-verify-gas-calibrated; pqc-consent-authz-limiter; pqc-consent-outer-signer; pqc-rotation-ends-evm-consent; pqc-degenerate-key-refused; svm-pqc-key-lane-gated; pqc-registration-ends-evm-consent; pqc-consent-own-message; svm-pqc-key-for-wallets; svm-pqc-authorisation-window; qcb-pqc-submitter; pqc-key-change-clears-evm-delegation; pqc-svm-window-key-proof; pqc-registration-ends-svm-window; pqc-hybrid-embedded-key-degenerate; qcb-pqc-submitter-own-message; pqc-key-registration-own-message; pqc-verify-empty-message |
| `chain:protocol-features` | 353 enabled at height 10861027 (33 PQC-related listed) |
| `chain:rest` | https://api-testnet.qore.host |

## Sources

- EU PQC Workstream of the NIS Cooperation Group, "A Coordinated Implementation Roadmap for the Transition to Post-Quantum Cryptography", Part 1, version 1.1, 11 June 2025: <https://digital-strategy.ec.europa.eu/en/library/coordinated-implementation-roadmap-transition-post-quantum-cryptography>
- NIST IR 8547, "Transition to Post-Quantum Cryptography Standards", final, October 2026: <https://doi.org/10.6028/NIST.IR.8547>
- FIPS 203, Module-Lattice-Based Key-Encapsulation Mechanism Standard: <https://csrc.nist.gov/pubs/fips/203/final>
- FIPS 204, Module-Lattice-Based Digital Signature Standard: <https://csrc.nist.gov/pubs/fips/204/final>
- FIPS 205, Stateless Hash-Based Digital Signature Standard: <https://csrc.nist.gov/pubs/fips/205/final>

The framework rows paraphrase the source documents; read the sources for the authoritative wording.
