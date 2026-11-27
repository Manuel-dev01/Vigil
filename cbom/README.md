# Cryptographic inventory (CBOM)

What cryptography Vigil uses and where, as [QoreScan](https://github.com/qorechain/qorescan) 0.1.0 (`@qorechain/qorescan`, a devDependency pinned in the lockfile) recorded it. **An inventory aid, not a certification.** QoreScan's classes are its own: "post-quantum" means FIPS 203, 204 or 205; "quantum-vulnerable" means public-key cryptography that a quantum computer breaks; hashes and ciphers are "symmetric".

| File | What it is |
|---|---|
| [`vigil.cdx.json`](vigil.cdx.json) | The CycloneDX 1.6 CBOM, as QoreScan wrote it |
| [`vigil.nis.md`](vigil.nis.md) | QoreScan's report mapping the CBOM to the EU NIS Cooperation Group PQC roadmap |
| [`agility-statement.md`](agility-statement.md) | QoreScan's crypto-agility template, pre-filled from the scan. Its "To be completed" items are left as QoreScan wrote them |
| [`scan.json`](scan.json) | The run itself: date, height, QoreScan's binary SHA-256, targets, and how the reads were paced |

None of these files is edited by hand.

## The scan: 27 Nov 2026, 17:15 UTC, testnet height ~10,861,021

One local run of `pnpm cbom:scan` ([`scripts/cbom/scan.ts`](../scripts/cbom/scan.ts)) over:
- **the contracts**, `contracts/src` (5 files: the three contracts in the README, their `IQorePQC` interface and the `BlockhashProbe` spike);
- **the chain**, `qorechain-diana` through `https://api-testnet.qore.host`, and the registered keys of the **10 L1 accounts** in the [README's address table](../README.md#testnet-addresses). The three EVM contracts in that table are covered by the contracts scan;
- **TLS**: one handshake each with the web app's host and the three endpoints of the node (websocket, EVM, REST).

It only reads. One read took the latest height; after a pause, QoreScan's 25 REST reads went through a local proxy ([`scripts/cbom/throttle.ts`](../scripts/cbom/throttle.ts)) that holds each write until 1.1 s after the last, so they reached the node at under one a second (37 paced writes in 64 s); the public endpoints share a rate limit with our hosted services. The TLS scans send no request.

## What it found

Chain facts are as the node reports them; they come without proofs.

- **Contracts.** All three verify signatures through the `pqcVerify` precompile and read keys through `pqcKeyStatus` (ML-DSA-87), and hash with Keccak-256. There is no `ecrecover`, no ECDSA, P-256 or RSA verification, and no import of a library that provides one. `PQGuardVault.sol` names ECDSA in a doc comment (line 12); QoreScan blanks comments and strings before it matches, so that is not a use.
- **Accounts.** Each of the 10 accounts holds a hybrid key: its secp256k1 key plus a registered ML-DSA-87 key (`dilithium5` in the chain's naming). employer-1's ML-KEM-1024 key is in the chain's KEM registry.
- **Chain.** Hybrid signatures are `required`, with classical fallback off and a minimum security level of 5. The `pqcVerify` and `pqcKeyStatus` precompiles are active. The 4 active validators have Ed25519 consensus keys: classical, below Vigil (see [THREAT_MODEL §9](../THREAT_MODEL.md#9-quantum-notes)). The EVM lane signs transactions with ECDSA secp256k1, as every EVM does; ours run only inside windows that an ML-DSA-87 key opens.
- **TLS.** `rpc-testnet.qore.host`, `evm-testnet.qore.host` and `api-testnet.qore.host` negotiated **X25519MLKEM768**, a hybrid group (ML-KEM-768 is post-quantum, X25519 is classical). The web app's host, `vigil-pq.up.railway.app`, negotiated **X25519**, which is classical. Every certificate in these chains is signed with ECDSA or RSA. One handshake shows what a server picks for a modern client, not everything it accepts.

## What it does not see

QoreScan reads Solidity, chain state over REST, TLS endpoints and node home directories (we run no node). It does not read TypeScript, so these are outside the CBOM and come from the code instead:
- ML-DSA-44 signatures on L2 transactions (qledger-v1, `@qorechain/rdk`);
- QoreSeal sealing: ML-KEM-1024 with X25519, then AES-256-GCM (`packages/sealed`);
- SHA-256 in qledger-v1's state and withdrawals trees (`@qorechain/rdk`) and the key pins in the web app;
- ML-DSA-87 signing of anchors and exit attestations, and hybrid signing of our L1 transactions.

The web app's footer has a one-screen label, "What's inside", that lists each of these with where it is used and what the scan saw. [`apps/web/test/inside.test.ts`](../apps/web/test/inside.test.ts) checks every scanned fact on it against `vigil.cdx.json`.

## The gate in CI

On every push and pull request, the `CBOM gate` job in [`ci.yml`](../.github/workflows/ci.yml) scans `contracts/src` with QoreScan and runs [`scripts/cbom/gate.ts`](../scripts/cbom/gate.ts), which fails if any Solidity source uses a public-key primitive that QoreScan does not class as post-quantum, or imports a library that provides one. The job then checks the gate itself on two canaries in [`test/vectors/cbom/`](../test/vectors/cbom): one contract that calls `ecrecover` must fail, and one that names ECDSA and `ecrecover` only in comments and strings must pass. Only this Solidity scan can fail CI. The network scans run weekly in [`cbom-network.yml`](../.github/workflows/cbom-network.yml), never block, and report what changed since this scan.

## Re-run it

```bash
pnpm install
pnpm cbom:gate cbom/vigil.cdx.json        # the gate on the committed CBOM (no network)
pnpm cbom:scan --offline                  # a fresh contracts scan into a temporary directory (downloads QoreScan once)
pnpm cbom:scan                            # the full scan into cbom/ (reads the testnet, paced; about a minute)
pnpm cbom:summary cbom/vigil.cdx.json     # a Markdown summary
```

On first use, the QoreScan launcher downloads the release binary for your platform and runs it only if its SHA-256 matches the digest shipped in the package (`d5e489ec…f4ce0e` for macOS arm64, recorded in `scan.json`).
