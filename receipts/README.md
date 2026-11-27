# Settlement receipts

Snapshots of `@qorechain/rdk` settlement receipts, built and checked against the live chain by `scripts/receipts-snapshot.ts`.

- **`vigil-pay-1/`**, our rollup: a receipt for each of its 25 anchored batches (0 to 25 except 11), rebuilt and verified on 27 Nov 2026 at 16:50 UTC, at height 10,860,020: 25 of 25 valid. Batch 11 has no receipt: the standby sequencer submitted it, and only the creator's key anchors (EVIDENCE 69). `data-6.json`, `data-24.json` and `data-27.json` are data receipts for the three sealed payslips (EVIDENCE 38, 117, 123).
- **`vigil-1/`** is **not operated by the Vigil team**. Its creator, `qor107qx…tztr`, is another participant (checked 18 Nov 2026). These receipts are an outside watcher's independent verification of that rollup, and an example of checking any rollup without its keys.

The chain's parameters allow it to prune finalized batch records after `finalized_batch_retention_blocks` (432,000 blocks on testnet, about 7 days). As of 27 Nov 2026 we have not seen it happen: at 16:50 UTC the node still served `vigil-pay-1`'s batch 0 record, finalized at block 10,355,185, about 505,000 blocks earlier. If a batch's record is pruned, its receipt can no longer be built from chain state, so we snapshot each receipt while the record exists. Posted data is pruned after 648,000 blocks, which we have observed. `summary.json` in each folder records the height at which every receipt was verified, and the result.

Re-verify one yourself, with no key needed:

```bash
pnpm install
cd scripts
npx tsx receipts-snapshot.ts vigil-pay-1 --from 3 --to 3   # rebuilds and verifies batch 3 against the chain
git diff ../receipts                                        # an unchanged receipt shows no diff
```

The script asks the public node about once a second (`--gap-ms` sets the gap) and reads each URL once per run. A run limited with `--from`/`--to` leaves `summary.json` as it was; only a run over every batch rewrites it.

A receipt is a claim; the verification is the evidence. `valid: true` is reported only when every field was re-read from chain state: rollup and layer binding, the batch state root, the anchor on chain, the creator's authority, the ML-DSA-87 signature and the chain binding.
