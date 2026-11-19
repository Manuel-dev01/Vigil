# Vigil web app

Watch `vigil-pay-1` live, verify its settlement receipts against the chain, and open sealed payslips, all in your browser.

There is no Vigil server. The page talks to a QoreChain node over its websocket through [`@vigil/chain-ws`](../../packages/chain-ws) and decodes answers with the chain's own protobuf schemas. The RDK runs unchanged in the page.

| View | What it does |
|---|---|
| **Rollup** (`#/`) | The rollup's status, every batch with its ML-DSA-87 anchor, the upheld fraud challenges, and a live feed of new posts, batches and fraud. The feed comes from websocket subscriptions |
| **Verify a receipt** (`#/verify`) | Builds a settlement receipt for any batch from chain state, or takes one you paste, and runs the RDK's `verifySettlementReceipt` against the live chain. The ML-DSA-87 signature is checked in the browser. It also checks that the receipt carries *this* batch's own anchor, and there is a one-click forgery to watch the check fail |
| **Open a payslip** (`#/payslip`) | Lists the sealed envelopes in the inbox and proves each one is inside a settled batch (a data receipt). Given a seal key file, which is read only in the page, it opens the payslips sealed to that key with QoreSeal (ML-KEM-1024 together with X25519) and matches each against the public ML-DSA-44 transfer it explains |

```bash
pnpm install
pnpm --filter @vigil/web dev      # http://localhost:5173
pnpm --filter @vigil/web build    # static site in apps/web/dist, servable from any path
```

## Live

https://web-production-324cc271.up.railway.app is served by [Caddy](deploy/Caddyfile) on Railway, with a strict Content-Security-Policy (scripts from the site only; network only to the site and the node's websocket). [`/version.json`](https://web-production-324cc271.up.railway.app/version.json) names the commit it was built from and the SHA-256 of every file it serves. To deploy:

```bash
pnpm --filter @vigil/web build
node apps/web/deploy/package-site.mjs          # refuses a modified tree
railway up apps/web/deploy/out --path-as-root --service <web>
```
