# Settlement receipts

> `vigil-1` is **not operated by the Vigil team**. Its creator, `qor107qx…tztr`, is another participant (checked 18 Nov 2026). These receipts are an outside watcher's independent verification of that rollup, and an example of checking any rollup without its keys.

Snapshots of `@qorechain/rdk` settlement receipts, built with `buildSettlementReceipt` and checked with `verifySettlementReceipt` against the live chain (`scripts/receipts-snapshot.ts`).

The chain's parameters allow it to prune finalized batch records after `finalized_batch_retention_blocks` (432,000 blocks on testnet, about 7 days); as of 24 Nov 2026 we have not seen it happen. If a batch's record is pruned, its receipt can no longer be built from chain state, so we snapshot each receipt while the record exists. Posted data is pruned after 648,000 blocks, which we have observed. `summary.json` in each folder records the height at which every receipt was verified, and the result.

Re-verify one yourself, with no key needed:

```bash
pnpm install
cd scripts
npx tsx receipts-snapshot.ts vigil-1 --from 3 --to 3   # rebuilds and verifies batch 3 against the chain
```

A receipt is a claim; the verification is the evidence. `valid: true` is reported only when every field was re-read from chain state: rollup and layer binding, the batch state root, the anchor on chain, the creator's authority, the ML-DSA-87 signature and the chain binding.
