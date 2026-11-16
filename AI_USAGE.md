# AI usage

Vigil is built with an AI coding agent (Claude Code) working with the team. This log records the notable work the agent did and what the humans reviewed or decided. Entries are dated (UTC).

| Date | What the agent did | What humans reviewed or decided |
|---|---|---|
| 2026-11-16 | Scaffolded the pnpm/TypeScript workspace, the licence and the evidence ledger. Re-checked live chain facts before writing code. | Chose the design and the post-quantum rules (no classical-key authority, evidence for every claim). |
| 2026-11-16 | Wrote and ran the qledger replay (Spike A: 12 of 12 live batches reproduced) and the `pqcVerify` convention and gas probe (Spike B). Traced why `qorollup watchtower --canonical` is silent (it skips finalized batches) and showed that its validator rejects every honest qledger batch. Wrote PQGuardVault with 21 tests, the drill-account tooling and threat model v0. Found that this network needs IPv4-first and long TCP connect timeouts for Node `fetch`. | Humans approve every broadcast, the use of a unified eth-native drill account, the drill registration, the GitHub remote and every public statement. The agent does not broadcast, open EVM windows or publish keys. |
