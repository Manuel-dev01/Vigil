# sentinel

This package watches Vigil from the outside and tells a human on Telegram when something needs attention. It holds no key and sends no transaction. Every check is a read of the chain, the EVM endpoint or the web app, once a minute.

| Severity | When | Rule |
|---|---|---|
| Critical | An EVM window is open on a key that must never open one | creator/drill account, watchtowers, keel-b, keep-alive, employer-1 |
| Critical | A vigil-pay-1 batch from the last two days is challenged or rejected | |
| Warning | The relayer's or the deployer's window stays open too long | 10 min and 30 min; their windows last a few minutes |
| Warning | A hot key falls below its floor | watchtowers 6 QOR, keeping the 5 QOR challenge reserve |
| Warning | Inbox entries wait more than 10 minutes without a batch | the sequencer is stuck |
| Warning | No new batch for 3 days | the keep-alive posts every 2 days |
| Warning | The InstantExitVault is owed money for more than 2 hours, or holds under 0.3 QOR | |
| Warning | The web app does not answer | |

A condition is announced once when it starts and once when it clears. A summary of balances and status goes out every day at 08:00 UTC. If the chain cannot be read for 10 checks in a row, that is announced too.

```sh
pnpm --filter @vigil/sentinel start -- --once      # one check, printed
```

**Configuration:**
- `TELEGRAM_BOT_TOKEN`: the bot's token, kept secret. Without it, alerts go to the log only.
- `TELEGRAM_CHAT_ID`: optional. Without it, the sentinel uses the chat of whoever last pressed Start on the bot.
- `SENTINEL_INTERVAL`: seconds between checks (default 60).

The accounts and their rules are in `src/accounts.ts`, and the rules themselves, tested offline, are in `src/rules.ts`.
