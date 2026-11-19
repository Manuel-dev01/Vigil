# Sealed data lane

Confidential data inside `vigil-pay-1`, protected with ML-KEM-1024. The first use is **payroll**:
- **The payment is public.** It is an ordinary qledger-v1 transfer that the rollup executes.
- **The payslip that explains it is sealed.** It is readable only by the employee, the auditor and the employer.
- **Both go in the same inbox and settle in the same batches.**

## How it works

- **Envelope.** QoreSeal 0.1.0 in hybrid mode encrypts the payslip once with AES-256-GCM. The content key is encapsulated to each recipient with ML-KEM-1024 and X25519 combined.
  - The key derivation binds the chain id and the purpose `vigil-payroll/v1`.
  - The additional data binds the rollup id, so an envelope copied into another rollup does not open.
  - Envelopes are **anonymous**: the chain shows how many recipients there are, but not who they are.
- **In the rollup.** The employer's L1 account posts the envelope to the rollup inbox with `MsgPostRollupData`, hybrid-signed.
  - qledger-v1 treats any payload that is not a transaction as a no-op. So the envelope changes no balance, but the batch's `data_hash` commits to it.
  - `test/sealed.test.ts` checks this on recorded data: vigil-1's batch 28 with an envelope inserted settles to exactly the published roots.
- **Keys.**
  - Each recipient publishes its ML-KEM-1024 key in the chain's KEM registry (`MsgRegisterKEMKey`, which needs a registered ML-DSA-87 key first).
  - It also publishes a **recipient card** in `cards/<qor1…>.json`. The card carries the X25519 key and the ML-KEM key's SHA3-256, signed by the account's secp256k1 key and its ML-DSA-87 key.
  - Senders check every card against the chain before sealing to it.
- **Payment link.**
  - A payslip names its payment by the SHA-256 of the transfer's inbox post, which is the `data_hash` the chain keeps for that entry.
  - `payslip` refuses to seal unless that post is in the inbox and is a validly signed transfer with the payslip's accounts and amount.
  - The payslip's lines must add up to the amount paid.
- **Data receipt.** It proves that one inbox post sits in a particular batch.
  - It carries the batch's starting inbox accumulator and the sequence, height, poster and payload hash of every post in the batch's range, never the payloads.
  - Re-folding them with the RDK's `inboxAccumulate` and `inboxRangeHash` must give the batch's `data_hash`.
  - With `--live`, the batch on chain must carry that `data_hash` and range and be finalized.
  - **Scope:** the batch's ML-DSA-87 anchor (its settlement receipt) signs the state root, not `data_hash`. So `data_hash` is trusted through chain state; the chain computed it from its own accumulator when it accepted the batch.

## What stays public

Who posted, when, the envelope's size, how many recipients it has, and the payment itself (accounts and amount, as on any qledger transfer). Only the payslip's contents are private.

## Commands

```sh
pnpm --filter @vigil/sealed seal-key -- new --address <qor1…> --out <file>        # seed in a 0600 file; prints public values only
pnpm --filter @vigil/sealed card -- --env <account .env> --key <seal key file>    # writes cards/<qor1…>.json (offline)
pnpm --filter @vigil/sealed kem -- register --env <account .env> --key <seal key file> [--broadcast]
pnpm --filter @vigil/sealed kem -- status --address <qor1…>
pnpm --filter @vigil/sealed payslip -- --env <employer .env> --payslip <json> --to <qor1…>,<qor1…> [--broadcast]
pnpm --filter @vigil/sealed inbox -- --key <seal key file>                        # finds and opens your payslips (read-only)
pnpm --filter @vigil/sealed receipt -- build --sequence <n>                       # writes receipts/<rollup>/data-<n>.json
pnpm --filter @vigil/sealed receipt -- verify --file <receipt.json> [--payload <hex file>] [--live]
```

Every command that sends simulates first, and sends only with `--broadcast`.
