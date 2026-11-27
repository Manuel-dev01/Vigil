# Vigil in numbers

Read from `qorechain-diana` at block 10,860,329 (27 Nov 2026, 16:57 UTC) by [`scripts/metrics.ts`](../scripts/metrics.ts), with 28 read-only requests, about one a second. It reads the chain over its public REST and EVM endpoints and the committed inbox archive, [`data/inbox/vigil-pay-1.jsonl`](../data/inbox/vigil-pay-1.jsonl). The numbers are what the node reports; nothing here is signed by us. Re-run it with:

```bash
pnpm --filter @vigil/scripts metrics           # rewrites this file, docs/metrics.json and the README's numbers
pnpm --filter @vigil/scripts metrics --dry-run # prints the numbers and writes nothing
```

## The rollup

| | |
|---|---|
| Live | 8 days: `vigil-pay-1` was created at block 10,351,825, 19 Nov 2026, 02:53 UTC (EVIDENCE 13) |
| Batches the chain lists | 26 (indices 0 to 25): 26 final, 0 inside their challenge window, 0 rejected and still listed |
| Batches carrying their own ML-DSA-87 anchor | 25 of 26 |
| Final batches with no anchor | batch 11: anchoring needs the creator's key, so a batch from the bonded standby has no anchor (EVIDENCE 69) |
| Inbox entries in the committed archive | 27 (to entry 27); its last accumulator matches the chain's commitment for that entry |

## Settlement receipts

| | |
|---|---|
| Anchors on chain | 25 |
| Anchors whose ML-DSA-87 signature verifies | 25 of 25. Checked here with the RDK's `verifySettlementReceipt` (signature-only mode), against the creator's key as the node reports it |
| Final batches whose own anchor verifies and carries the batch's state root | 25 |
| Anchors verified and recorded in Solidity | 25, through layer height 25, 0 conflicts (`SettlementReceiptVerifier`, `pqcVerify`; EVIDENCE 62, 63, 80, 112). Anyone can record newer ones with `attest` |

## Fraud caught

| Forged batch | Challenge upheld | Blocks after the batch | Challenger | Evidence |
|---|---|---|---|---|
| 6 ([`E3E71FB6…`](https://explore.qore.network/tx/E3E71FB6BFE0A2102C9490A11F18205913926513DA524E225B59CB931DF7D11E), block 10,370,239) | [`1BF5B717…`](https://explore.qore.network/tx/1BF5B717F658DCD923D9860322DA21C901C608C2F6E7FA359A6439BBA114EBC4), block 10,370,243 | 4 | another team's watcher `qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5` | 43, 44 |
| 8 ([`6802887D…`](https://explore.qore.network/tx/6802887DBC277445377D70C1D2474AEC30ED3C00059F08943DF16DFB8E1D1A9A), block 10,382,606) | [`4963FCFD…`](https://explore.qore.network/tx/4963FCFD2D33188456572D27C16D96DD2CB03604767DCBEEF0EDFB54E0F5B915), block 10,382,607 | 1 | our watchtower `qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd` | 54, 55 |

In fraud drill 2, watchtower-2's logs show it saw the forged batch about 1.6 s after the block's timestamp, judged it in 10 ms and broadcast its challenge 254 ms later (EVIDENCE 55). Those times come from our logs, not from the chain; the block heights above do.

## Standby takeover

| Batch | Entry it starts with | Posted at block | Batched at block | Blocks after the post |
|---|---|---|---|---|
| 11 | 13 | 10,433,589 | 10,433,596 | 7 |

The standby waits 30 blocks before it batches. Batch 11 came sooner because of an off-by-one in that wait, fixed in PR #29 (EVIDENCE 69), so the number above is not the designed margin.

## Instant exits

2 exits so far, **a small sample**. Found by searching each withdrawal batch's challenge window for the vault's `Fronted` events (batches 15, 18); times are block timestamps.

| Batch | Paid | Payment | Blocks after the batch | Posted to paid | Before the batch could be final |
|---|---|---|---|---|---|
| 15 (withdrawal 3) | 0.0995 QOR (fee 0.0005 QOR) | `0x9705770b…`, block 10,629,908 | 68 | 186 s (entry 17, block 10,629,836) | 3,425 s |
| 18 (withdrawal 4) | 0.0995 QOR (fee 0.0005 QOR) | `0x6542b5f3…`, block 10,686,385 | 11 | 23 s (entry 20, block 10,686,369) | 3,585 s |

Fronted 0.2 QOR in all; the vault is still owed 0 QOR, so 100% has been repaid after finality (`totalOwed` on the vault, EVIDENCE 95, 108). Seconds here come from block timestamps, so they can differ by a second or two from times in EVIDENCE.md.

## Sealed payslips

3 QoreSeal envelopes (ML-KEM-1024 with X25519) in the archive: inbox entries 6, 24, 27.

| Period | Payment entry | Payslip entry | Payslip size | QOR spent by the posters | Evidence |
|---|---|---|---|---|---|
| 2026-11 | 5 ([`73287A6B…`](https://explore.qore.network/tx/73287A6BDDF3363C0D4BD8FEF9A428B7DC1D7A14386DB72ECAE5152432C58C22)) | 6 ([`0B70265B…`](https://explore.qore.network/tx/0B70265B742B431607B01A423E1AF1CE5AA915C948373F5AFAED780753B18B9B)) | 5,822 bytes | 0.255732 QOR | 35, 37 |
| 2026-12 | 23 ([`4C279045…`](https://explore.qore.network/tx/4C279045078423757280BFE453B112413AE2698E7E972FB6D18855B65051FD66)) | 24 ([`8ADA7C5E…`](https://explore.qore.network/tx/8ADA7C5E04F5A1CB66C3372A4DA3C8A81CD7B3094DFF0BED6D7A17F0068A1739)) | 5,905 bytes | 0.257181 QOR | 114, 115 |
| 2027-01 | 26 ([`F82CF360…`](https://explore.qore.network/tx/F82CF360FB8294E00872E0605EB7C3C3586A1F26CD0FF9A1760E50F6ABED6814)) | 27 ([`013F7B58…`](https://explore.qore.network/tx/013F7B58409CF2FF39099F9CA301E4EEA82BC941EC8FA3DB89C8CF37B7F7B982)) | 5,901 bytes | 0.257143 QOR | 121, 122 |

QOR spent is what each transaction's poster paid, from its `coin_spent` events: the gas fee and the chain's fee per posted byte.

## What this does not show

- Nearly all traffic on the rollup is ours. These are testnet numbers from a small team, not usage.
- Two instant exits and two fraud drills are small samples.
- The node is trusted to report chain state truthfully; signatures are checked here, the rest is read.
