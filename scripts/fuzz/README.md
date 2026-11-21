# Differential fuzzing of qledger-v1 across the RDK's five languages

Every watchtower and sequencer decides batches by running qledger-v1 execution (`executeQledger`).
QoreChain's RDK ships it in TypeScript, Go, Rust, Python and Java. If two of them disagree on any
input, a watchtower written with one would challenge an honest batch, or miss a fraudulent one,
written with another. This fuzzer feeds the same rollup histories to all five and compares what
each computes.

## Result (21 Nov 2026)

**10,056 generated cases × 5 implementations: 0 divergences** in state roots, withdrawals roots and
withdrawals:
- TypeScript: `@qorechain/rdk` 0.9.0.
- Go, Rust, Python and Java: qorechain-rdk at commit `2c72e47`.

The cases come from seeds 11 to 15 (2,000 each) plus a 50-case smoke run with seed 1. Every file
also includes the upstream fixture's real qledger batch.

The cases exercise real state, not only rejections. In the smoke run, 101 batches reached 94 distinct
state roots and committed 33 withdrawals.

## How it works

- **`gen.ts`** writes cases: short histories of 1 to 3 batches of deposits, transfers and
  withdrawals from four ML-DSA-44 accounts. They are mostly valid, with mutation families mixed in:
  - corrupted, truncated or extended payloads, and flipped signature or header bits;
  - amounts, nonces and deposits at their limits (0, u64 max, overflow);
  - transfers to the withdrawal counter, to oneself or to unknown accounts;
  - deposit-poster variants and malformed deposits;
  - signatures for the wrong chain or rollup;
  - recipient variants (case, checksum, prefix, spacing, lengths up to 90 bytes);
  - empty and 6 KB posts.

  Cases are reproducible from the seed.
- **The shims** (`ts-shim.ts`, `shims/go`, `shims/rust`, `shims/py`, `shims/java`) each read cases as
  JSON lines and print each batch's state root, withdrawals root and withdrawals. The ledger
  persists across a case's batches.
- **`diff.ts`** runs every shim on the same file and groups disagreements by which implementations
  split. Before comparing, it checks itself: a one-digit root change, a changed withdrawal amount,
  or an error must each change the comparison key.

## Run it

```bash
scripts/fuzz/setup.sh                       # clones qorechain-rdk at 2c72e47 and builds the shims
cd scripts
npx tsx fuzz/gen.ts --seed 11 --count 2000 > /tmp/cases.jsonl
npx tsx fuzz/diff.ts /tmp/cases.jsonl       # writes /tmp/cases.jsonl.report.json
```

`setup.sh` needs git, Go, Cargo, uv (Python 3.13 by default; set `FUZZ_PYTHON` to change it), a
JDK (17+), curl and shasum. It checks the two Java jars, BouncyCastle `bcprov-jdk18on` 1.85 and
`qorechain-pqc` 0.2.3, against SHA-1 values pinned in the script (Maven Central's published
values). Pass `RDK_REPO=/path/to/qorechain-rdk` to use an existing checkout.

## How it was built

An AI coding agent wrote the harness. Separately, an AI red-team agent read the five
implementations side by side, looking for inputs on which they could disagree. See
[AI_USAGE.md](../../AI_USAGE.md).
