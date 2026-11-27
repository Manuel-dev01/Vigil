# sentinel

This package watches Vigil from the outside and tells a human on Telegram when something needs attention. It holds no key and sends no transaction. Every check is a read of the chain, the EVM endpoint or the web app, once a minute.

| Severity | When | Rule |
|---|---|---|
| Critical | An EVM window is open on a key that must never open one | creator/drill account, watchtowers, keel-b, keep-alive, employer-1 |
| Critical | A vigil-pay-1 batch does not re-execute and no challenge has been upheld once half its challenge window has passed | **Unchallenged bad batch.** Repeated every 10 minutes until it clears |
| Critical | A vigil-pay-1 batch from the last two days is challenged or rejected | |
| Warning | The relayer's or the deployer's window stays open too long | 10 min and 30 min; their windows last a few minutes |
| Warning | A hot key falls below its floor | watchtowers 6 QOR, keeping the 5 QOR challenge reserve |
| Warning | Inbox entries wait more than 10 minutes without a batch | the sequencer is stuck |
| Warning | No new batch for 3 days | the keep-alive posts every 2 days |
| Warning | The InstantExitVault is owed money for more than 2 hours, or holds under 0.3 QOR | |
| Warning | The web app does not answer | |
| Warning | An instant exit the relayer serves is not fronted within 5 minutes of its batch | Exits below the relayer's minimum, or in a batch over the watchtowers' cap of 4, are paid at finality by design and not flagged |
| Warning | Re-execution fails 5 checks in a row, or cannot start from the batches the chain still lists | The bad-batch check would be blind |

**Re-execution.** The sentinel re-executes every live `vigil-pay-1` batch itself, with the watchtower's pure core (`checkBatch` from `packages/qledger-watchtower/src/check.ts`, imported, not copied), and compares the state root, withdrawals root and data hash each batch published (`src/judge.ts`). It reads each inbox entry once, through the shared reader in `@vigil/core/inbox`; the committed archive supplies entries the chain has pruned. It holds no key, so it cannot challenge: it tells a human, who can.

**Instant exits.** From the same re-execution it knows every withdrawal in a batch waiting for finality. Those paid to the exit address of a payout the relayer serves (announced with a payout notice, posted by the payout itself, or listed in `EXIT_PAYOUTS`) are checked with the vault's public `fronted(exitId)` (`src/exits.ts`).

A condition is announced once when it starts and once when it clears; an unchallenged bad batch is announced again every 10 minutes while it lasts. A check that could not re-execute the batches, or read an exit, does not announce their alerts as resolved: they stay open until a check that can look finds them gone. A bad batch whose submission time the node does not report is alerted at once. A summary of balances and status goes out every day at 08:00 UTC. If the chain cannot be read for 10 checks in a row, that is announced too.

```sh
pnpm --filter @vigil/sentinel start -- --once      # one check, printed
```

**Configuration:**
- `TELEGRAM_BOT_TOKEN`: the bot's token, kept secret. Without it, alerts go to the log only.
- `TELEGRAM_CHAT_ID`: optional. Without it, the sentinel uses the chat of whoever last pressed Start on the bot.
- `SENTINEL_INTERVAL`: seconds between checks (default 60).
- `EXIT_PAYOUTS`: optional. The payouts the exit relayer is configured with (comma list, `qor1…` or `0x…`), so their exits are watched too. Set it to the relayer's value: a payout that was neither announced with a payout notice nor posted its own entries is watched only if it is listed here.

The accounts and their rules are in `src/accounts.ts`, and the rules themselves, tested offline, are in `src/rules.ts`. `test/judge.test.ts` runs the re-execution and the exit watch on `vigil-pay-1` as recorded on 24 Nov ([`test/vectors/inbox-vigil-pay-1.json`](../../test/vectors/inbox-vigil-pay-1.json), at the repository root): all 22 batches valid, a changed state root, withdrawals root or data hash flagged, a rollback re-judged, pruned records handled, and batch 18's exit found with the vault's own exit id.
