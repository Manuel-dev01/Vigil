# Vigil web app

Watch `vigil-pay-1` live, follow its instant exits, verify its settlement receipts against the chain, and open sealed payslips, all in your browser.

There is no Vigil server. The page talks to a QoreChain node over its websocket (and, for the contract check, to the public EVM JSON-RPC endpoint) through [`@vigil/chain-ws`](../../packages/chain-ws) and decodes answers with the chain's own protobuf schemas. The RDK runs unchanged in the page.

| View | What it does |
|---|---|
| **Landing** (`#/`) | One batch followed from signature to final, with a few facts read live after the page paints: the chain height, the latest batch, the anchor count, and the exit quorum from `InstantExitVault.quorum()` and `threshold()` |
| **Rollup** (`#/rollup`) | The rollup's status, its deposit pool (what withdrawals are paid from) and the creator's escrowed stake, every batch with its ML-DSA-87 anchor, the upheld fraud challenges, and a live feed of new posts, batches and fraud. The feed comes from websocket subscriptions. On request, the browser acts as a watchtower: it reads every inbox entry and batch submission, re-executes every batch in a Web Worker with the watchtower's own check, compares what the rollup owes with its deposit pool, opens any account with a witness against an anchored root, and forges a batch locally to show the fraud proof that catches it (printed, never sent) |
| **Instant exits** (`#/exits`) | The [`InstantExitVault`](../../contracts/src/InstantExitVault.sol): its liquidity and quorum, and every exit attested for it or fronted, step by step: the L2 withdrawal, the batch, both watchtowers' ML-DSA-87 signatures (verified in the browser, then by `pqcVerify` in an `eth_call`), the payment, finality and the repayment. Any address's exit address is computed in the browser and cross-checked with the vault. A race chart draws the latest exit, and a table lists every fronted exit with its timings (withdrawn to paid, batch to paid, lead over finality, repayment, `front()` gas) and a summary row; `scripts/exit/metrics.ts` writes the same table to `docs/exits-metrics.json` |
| **Verify a receipt** (`#/verify`) | Builds a settlement receipt for any batch from chain state, or takes one you paste, and checks it against the live chain: nine checks, with the ML-DSA-87 signature verified in the browser against the creator's key as the node reports it and against the key's hash pinned in the page. A forgery menu changes one field at a time (a state-root digit, a signature byte, the chain, the signer, the rollup), runs the same checks again and names the check that refused it; "Try all 5" ends with a tally such as "5 forgeries tried, 5 caught". The same receipt is also checked by the [`SettlementReceiptVerifier`](../../contracts/src/SettlementReceiptVerifier.sol) contract on QoreChain's EVM (a free `eth_call` to the EVM JSON-RPC endpoint), and the page shows the contract's public record for that layer height |
| **Trust** (`#/trust`) | Who can move, stop or change what, read live: the exit vault's quorum, threshold and LP by `eth_call`; the challenge window, submitter bond, governance voting period, circuit breaker and upgrade authority over the websocket. A risk rosette and an L2BEAT Stages checklist graded by us (a self-assessment that claims no stage), the instant-exit risk card, and what keeps working if Vigil disappears ([docs/STAGES.md](../../docs/STAGES.md), [docs/ESCAPE_HATCH.md](../../docs/ESCAPE_HATCH.md)) |
| **Open a payslip** (`#/payslip`) | Lists the sealed envelopes in the inbox and proves each one is inside a settled batch (a data receipt). Given a seal key file, which is read only in the page, it opens the payslips sealed to that key with QoreSeal (ML-KEM-1024 together with X25519) and matches each against the public ML-DSA-44 transfer it explains. "Try a random key" makes a key in the page and shows that it opens none. A recipient can share one opened payslip as a link (with a QR code and a printable copy) that carries only that envelope's data key. Opened from the link (`#/payslip?entry=<n>&dk=<key>`), the page needs no key or wallet: it opens that payslip and checks it against the chain (final batch, poster, public transfer, lines adding up), and "Forge it" changes a line to make one check fail. The chain does not tie the paying L2 account to the employer, and the page says so. If the salary later left the rollup through an instant exit, matched on the L2 account and amount, the payslip says so and links to it (not yet exercised on chain; tested offline) |

```bash
pnpm install
pnpm --filter @vigil/web dev      # http://localhost:5173
pnpm --filter @vigil/web build    # static site in apps/web/dist, servable from any path
```

## Live

https://vigil-pq.up.railway.app is served by [Caddy](deploy/Caddyfile) on Railway, with a strict Content-Security-Policy (scripts from the site only; network only to the site, the node's websocket and the EVM JSON-RPC endpoint). [`/version.json`](https://vigil-pq.up.railway.app/version.json) names the commit it was built from and the SHA-256 of every file it serves. The app's first address, `web-production-324cc271.up.railway.app`, now sends every path to the same path here (a permanent redirect, [deploy/old-url](deploy/old-url)), so links shared before 25 Nov 2026 still work. To deploy:

```bash
pnpm --filter @vigil/web build
node apps/web/deploy/package-site.mjs          # refuses a modified tree
railway up apps/web/deploy/out --path-as-root --service <web>
```

**Trust.** The page reads one public node (`rpc-testnet.qore.host`) and its EVM endpoint, without proofs. These checks run in the browser:
- the ML-DSA-87 signatures of anchors and watchtower attestations, against key hashes pinned in `src/config.ts`;
- the ML-DSA-44 signatures of L2 transactions;
- the inbox accumulator and data receipts;
- exit messages, and exit addresses (computed from the pinned ExitAddress code);
- on request, on the Rollup page: qledger-v1 re-execution of every batch, fraud proofs and the RDK's implementation of the chain's rule for deciding them (`checkQledgerFraud`), and account witnesses against an anchored root;
- sealed payslips, opened with a seal key or with one envelope's data key from a share link.

`pqcVerify` runs as a second, labelled check. If the creator's or a watchtower's ML-DSA-87 key is ever rotated, update `PINNED_KEYS` in `src/config.ts`.

**What's inside.** The footer's label lists each primitive Vigil relies on, where it is used, and what the QoreScan scan in [`cbom/`](../../cbom/README.md) saw: an inventory aid, not a certification. Its body (`src/Inside.tsx`, from `src/inside.ts`) loads when a reader opens it; `test/inside.test.ts` checks its scanned facts against the committed CBOM.
