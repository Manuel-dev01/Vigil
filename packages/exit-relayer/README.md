# exit-relayer

This package pays instant exits with nobody in the loop. It watches one `InstantExitVault` (`contracts/src/InstantExitVault.sol`) and its rollup's inbox, and for every exit it knows the payout of it:

1. **Fronts it** as soon as the quorum's attestations are in the inbox and the free `verifyExit` call says the vault will accept them. The batch must be unchallenged and the claim at least `--front-margin` seconds from its deadline.
2. **Executes the withdrawal** on L1 once its batch is final, with a native transaction, hybrid-signed (secp256k1 + ML-DSA-87). Anyone may do this; the chain pays the exit address the withdrawal names.
3. **Sweeps the exit address.** The vault is repaid first and the rest goes to the payout.

If nobody fronted an exit (no liquidity, quorum offline, deadline passed), steps 2 and 3 still pay the user in full after the challenge window.

```sh
pnpm --filter @vigil/exit-relayer start -- --once                                       # observe, one pass
pnpm --filter @vigil/exit-relayer start -- --env ../../.env.exit-relayer --mode relay \
  --payouts qor1…                                                                       # relay
```

## No rollup state needed
To execute a withdrawal, a proof needs the batch's whole withdrawal list. Keel's `claim.ts` gets it by replaying the rollup from its first batch. The relayer takes it from the attestation instead: each quorum member signs every withdrawal of a batch, in order. The list is used only if it reproduces the withdrawals root the chain stores for that batch (`withdrawalsRootMatches`), so a wrong list can't produce a proof the chain accepts. The relayer keeps nothing on disk; on start it reads back `--lookback` inbox entries and asks the chain what is already done (`verifyExit` reverts `AlreadyFronted`; a simulated execution fails with "withdrawal already executed"; an empty exit address has been swept).

## Which payouts it serves
An attestation names only the withdrawal's recipient, `exitAddressOf(payout)`, a CREATE2 address that can't be turned back into the payout. The relayer learns payouts three ways and keeps those whose exit address matches a signed recipient:
- `--payouts` / `EXIT_PAYOUTS`;
- **payout notices** in the inbox: `vigil/instant-exit/v1/payout | vault (20) | payout (20)` (`encodePayoutNotice` in `@vigil/qledger-watchtower`). A notice is a no-op entry for qledger-v1 and can go in the same transaction as the L2 withdrawal. It grants nothing: a wrong notice simply never matches a claim;
- the inbox's own posters (a user who posts their own withdrawal is often paid at that account).

## The EVM window
The relayer's account is a unified QoreChain account with its ML-DSA-87 key registered, so its ECDSA key can't send an EVM transaction unless a window is open, and only a hybrid-signed `MsgOpenEVMWindow` (which needs the ML-DSA-87 key) opens one. For each pass with calls to make, the relayer:
1. sizes every call first (`eth_estimateGas` needs no window);
2. opens a window that admits exactly those calls: target the vault only, as many transactions as calls, and a value cap equal to their maximum fees at the gas price they are sent with (the cap counts value plus fee, and they carry no value);
3. sends them with explicit nonces (opening the window advanced the nonce);
4. closes the window.

A window left open by a crash is closed on the next pass. Every vault function is safe for any caller: `front` pays only a payout whose exit address the quorum signed for, and `sweep` sends only to the vault and the payout. So even someone holding the ECDSA key could do nothing inside a window except pay exits correctly, and nothing at all outside one.

## Options (each one can also be set with the environment variable named)
| Flag | Environment | Default | Meaning |
|---|---|---|---|
| `--mode` | `EXIT_RELAYER_MODE` | `observe` | `relay` sends; `observe` logs what it would send |
| `--vault` | `EXIT_VAULT` | `deployments/diana.json` | The `InstantExitVault` |
| `--rollup` | `EXIT_ROLLUP` | the vault's `rollupId()` | Must equal the vault's |
| `--payouts` | `EXIT_PAYOUTS` | none | Payouts to serve besides announced ones |
| `--interval` | `EXIT_RELAYER_INTERVAL` | `6` | Seconds between passes |
| `--front-margin` | `EXIT_FRONT_MARGIN` | `60` | Leave a claim alone this close to its deadline |
| `--lookback` | `EXIT_LOOKBACK` | `500` | Inbox entries read back on start |
| `--window-blocks` | `EXIT_WINDOW_BLOCKS` | `150` | Window length in blocks (about 3.5 minutes) |
| `--env` | `EXIT_RELAYER_ENV` | none | A `.env` with the key, for local runs; hosted, use the secret `RELAYER_MNEMONIC` |

The key must be the relayer's own. It refuses the rollup creator's key (whose EVM window stays closed), a quorum member's (watchtowers never open windows) and the LP's. One relayer per key. Logs are JSON lines on stdout; secrets are never logged.
