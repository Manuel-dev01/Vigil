# @vigil/chain-ws

Read QoreChain from a web page with no server in between.

QoreChain's public REST and RPC endpoints send no CORS headers, so a page on another origin can't `fetch` them. The node's CometBFT websocket isn't subject to CORS, and it answers every RPC method, including `abci_query` (any gRPC query), `tx`, `tx_search` and live subscriptions. This package turns that one connection into the node's REST API:

- **`WsRpc`**: JSON-RPC over the websocket, with subscriptions that are kept until ended: each is sent once per connection, renewed after a reconnect, and asked for again if the node refuses it. `health()` (and the `onHealth` option) says how many the node has confirmed, for an honest "live" badge.
- **`restOverWs(rpc, registry)`**: a `fetch` replacement.
  - Each REST route (`/qorechain/rdk/v1/batch/{rollup_id}/{batch_index}` …) is taken from the `google.api.http` option in the chain's own descriptors, sent as the matching gRPC query through `abci_query`, and decoded into the same JSON the REST gateway returns.
  - Transaction routes are answered from CometBFT's `tx` and `tx_search`.
- **`descriptors/qorechain-diana.binpb`**: the chain's protobuf schemas, as returned by the node's gRPC reflection.
  - 211 files: every `qorechain.*` and `cosmos.*` file and what they import.
  - The height and SHA-256 are in the `.json` beside it.
  - Refresh with `pnpm --filter @vigil/chain-ws snapshot`.

Hand the `fetch` to any client that takes one, and the RDK works unchanged in a browser:

```ts
import { createRdkClient, verifySettlementReceipt } from "@qorechain/rdk";
import { WsRpc, chainRegistry, restOverWs } from "@vigil/chain-ws";

const rpc = new WsRpc({ url: "wss://rpc-testnet.qore.host/websocket" });
const registry = chainRegistry(new Uint8Array(await (await fetch(descriptorsUrl)).arrayBuffer()));
const client = createRdkClient({ network: "testnet", fetch: restOverWs(rpc, registry) });
const result = await verifySettlementReceipt(receipt, { client }); // { valid: true, mode: "chain", … }
```

## Checked
- **Parity:** `scripts/parity.ts` compares 14 REST paths (rollup, batches, inbox, posted data, bonds, params, anchors, PQ accounts, balances, one tx, a tx search, and a 404) between the public REST API and the websocket. On 19 Nov 2026 every one was identical.
- **Live tests:** `VIGIL_LIVE=1 pnpm vitest run packages/chain-ws` checks the RDK over the websocket only.
  - `verifySettlementReceipt` reports `valid: true` in chain mode for every stored `vigil-pay-1` receipt, and rejects one whose state root was changed.
  - `fetchQledgerEntries` reads the same inbox entries as REST, each checked against the chain's accumulator.
- **Offline tests:** the snapshot's hash, route mapping, request encoding, error mapping, and refusal of writes and unknown routes.

## Trust
The page trusts the node it connects to, exactly as a REST client does. Nothing here adds a server of ours. Proof-carrying reads (`abci_query` with `prove: true`, checked against light-client headers) are the next step.
