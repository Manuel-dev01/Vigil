# Leaving vigil-pay-1 without Vigil

If our team, our servers and our web app all disappear, your money on `vigil-pay-1` is still yours. The inbox, the batches, fraud proofs and withdrawals are rules of QoreChain's rollup module, not services of ours. This page gives the commands to read your balance, withdraw, batch your own withdrawal if no one else will, and claim it, from a fresh copy of this repository.

**How these were checked.** On **27 Nov 2026** each command below was run from a fresh `git clone` of this branch, in read-only or dry-run mode, against the live testnet. None was run with `--broadcast`, and no key of ours was used: the dry runs used a throwaway account made for the check, which holds nothing and has no registered key, so each stopped before anything was signed for the chain. The transactions these commands send have run on chain from our own accounts (the EVIDENCE rows below), but **not yet from an account outside the team**.

What keeps working and what stops is at the end, with the risk grades in [STAGES.md](STAGES.md).

## What you need

- Node 20 or later, pnpm and git. No server of ours: the scripts read QoreChain's public testnet endpoints (`api-testnet.qore.host`, `rpc-testnet.qore.host`).
- **Your L2 key file**, the ML-DSA-44 key that controls your `vigil-pay-1` account (written by `pnpm --filter @vigil/keel l2-key new --out <file>`; it holds `QLEDGER_SEED_HEX`). Step 1 needs only its public account id.
- **For steps 2 to 4, an L1 account** on `qorechain-diana`: its ML-DSA-87 key registered on chain (a hybrid account), a little QOR for fees (posting an entry cost about 0.07 QOR, EVIDENCE 118), and its secret in a file outside git, as `QORE_MNEMONIC=…`, readable only by you. Step 3 also needs 1,000 QOR for the bond. Any account will do: a withdrawal pays the recipient named inside your signed L2 transaction, not the account that sends it.

```bash
git clone https://github.com/Manuel-dev01/Vigil && cd Vigil
pnpm install --frozen-lockfile
```

## 1. Read your balance by replaying the chain

No key and no transaction. The script replays every batch from the chain's own data, checks each state root and withdrawals root against what the chain published, and prints your balance and nonce. With `--to` it lists every withdrawal to that L1 address and says whether it is paid, final (anyone can execute it now) or waiting for its batch's challenge window. It also says how long the oldest unbatched entry has waited, which tells you whether step 3 is needed. If the chain has deleted some batch records, the script names those batches: their withdrawals are not in the list.

```bash
pnpm --filter @vigil/keel balance -- --key <your l2 key file> --to <your qor1 address>
# or with a public account id instead of the key file:
pnpm --filter @vigil/keel balance -- --account <64 hex characters>
```

**Checked on 27 Nov 2026, 17:00 UTC**, with a public account id and the exit address of EVIDENCE 93 and 106 (32 requests, 35 s):

```
rollup      vigil-pay-1: replayed to batch 25, every root checked against the chain
replayed    from the first batch
account     6b6c0bea5e3bfbf32e6312de5c4648dd853570ac134ece008bd6d919b88dc70e
settled     0.32 QOR, nonce 7 (after batch 25)
with inbox  0.32 QOR, nonce 7 (with 0 entries posted but not yet batched)
inbox       nothing waiting to be batched
withdrawals to qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy: 2
  batch 15 withdrawal 3: 0.1 QOR, paid on L1; nothing to do
  batch 18 withdrawal 4: 0.1 QOR, paid on L1; nothing to do
```

## 2. Post a withdrawal

Sign an L2 withdrawal with your ML-DSA-44 key and post it to the rollup's inbox from your L1 account. The script replays the rollup first, takes your nonce and balance from it, and refuses a transaction the rollup would skip before it costs a fee. Without `--broadcast` it only simulates.

```bash
pnpm --filter @vigil/keel send -- --env <your L1 account file> --key <your l2 key file> \
  --amount 0.25 --withdraw-to <your qor1 address>
# add --broadcast to post it
```

Amounts of 100 QOR or more also need `--approved`. The script's message asks for the team's written OK: that rule is for our own accounts. With your own account, the flag is your confirmation.

**Dry-run checked on 27 Nov 2026, 17:01 UTC**, with a throwaway L2 key that holds nothing: it replayed to batch 25, signed a 0.01 QOR withdrawal with ML-DSA-44 (3,794 bytes) and refused it before any post, because the rollup would skip it (`refused: the rollup would skip this transaction`). With a funded key it goes on to check your L1 account and simulate the post. On chain from our accounts: a user's withdrawal posted by a non-operator account while our sequencer was stopped (EVIDENCE 68), and others (EVIDENCE 19, 86, 99).

## 3. If no one batches it, batch it yourself

`vigil-pay-1` is a based rollup: any account that holds the chain's `min_submitter_bond` (1,000 QOR, read live) may submit batches. Our sequencer batches an entry within a few blocks, and our standby after 30. If step 1 shows your entry has waited longer than that, both are probably down: bond and run Keel yourself as a standby.

```bash
pnpm --filter @vigil/keel bond -- --env <your L1 account file>
# add --broadcast to bond 1,000 QOR
pnpm --filter @vigil/keel start -- --env <your L1 account file> --standby-blocks 30 --dry-run --once
# then drop --dry-run and --once to run it as a standby sequencer
```

Keel re-executes every batch it plans and never builds on a batch that does not reproduce. A key that is not the rollup creator's batches **unanchored**: the batch is checked, challenged and paid out like any other, but has no settlement receipt (EVIDENCE 69, 72). Your bond is slashed if a batch from your key is proven wrong (as the evil submitters' were, EVIDENCE 44 and 55). Getting the bond back (`MsgUnbondRollupSubmitter`) has no command here and is not yet exercised.

**Dry-run checked on 27 Nov 2026, 17:02 UTC**, with the throwaway account:
- `bond` read the rollup (`active, based, qledger-v1`) and the bond (`1,000 QOR (min_submitter_bond, read live)`), then refused for the two reasons a real user fixes first: the key is not registered, and the account holds less than the bond plus fees. It signed nothing.
- Keel's preflight read the rollup, the bond, the key and the EVM window, and refused to start (`submitter bond 0 uqor is below the minimum`; `the ML-DSA-87 key in this .env is not the account's registered key`).

On chain from our accounts: our standby bonded (EVIDENCE 67) and, with the creator's sequencer stopped, batched a user's withdrawal (EVIDENCE 69).

## 4. Claim it after the challenge window

Once the batch is final (1 hour on `vigil-pay-1`), anyone can execute the withdrawal on L1, and the money goes to the recipient you signed for. The script recomputes the withdrawal and its Merkle proof by replaying the rollup, and simulates. A withdrawal the chain has already paid fails simulation and is skipped.

```bash
pnpm --filter @vigil/keel claim -- --env <your L1 account file> --batch <N>
# add --broadcast to execute
```

**Dry-run checked on 27 Nov 2026, 17:02 UTC**, with the throwaway account and batch 18: it replayed from the first batch, found `batch 18: finalized, 1 withdrawal(s), 0.1 QOR in all`, and stopped at the key check before signing. On chain: withdrawals executed with this script (EVIDENCE 21), by our standby (EVIDENCE 72), by the keep-alive account (EVIDENCE 93) and by the relayer (EVIDENCE 106).

**Claim within about a week of finality.** The chain's parameters allow it to delete a finalized batch's record after 432,000 blocks; we have not seen that happen (EVIDENCE 73). We expect its withdrawals could then no longer be executed (not yet exercised).

## Keep the inbox data

The chain deletes an inbox entry's posted-data record after 648,000 blocks (observed; [THREAT_MODEL §10](../THREAT_MODEL.md#10-facts-we-measured-and-rely-on)). After that, a replay reads the entry from the repository's archive, `data/inbox/vigil-pay-1.jsonl`, checked against commitments the chain still holds. If no one refreshes that archive, keep your own while the chain still has the entries:

```bash
pnpm --filter @vigil/scripts inbox:archive -- vigil-pay-1 --check          # read-only
pnpm --filter @vigil/scripts inbox:archive -- vigil-pay-1 --out <your file>  # extend a copy you keep
```

**Checked on 27 Nov 2026, 17:04 UTC** with `--check`: 27 archived entries matched their retained commitments and 25 batch range hashes; the chain's inbox head was 28 (30 requests).

## The web app, served by anyone

```bash
pnpm --filter @vigil/web build    # a static site in apps/web/dist that talks only to the public node
```

Built from the fresh clone on 27 Nov 2026. It needs no server of ours, and its Content-Security-Policy is in `apps/web/deploy/Caddyfile`.

## If Vigil disappears

**Keeps working:**
- posting to the inbox, from any L1 account (EVIDENCE 68);
- batching, by any account with the bond, using Keel or any other qledger-v1 sequencer (EVIDENCE 65 to 72);
- fraud proofs, from anyone; another team's watcher won our first fraud drill (EVIDENCE 44);
- withdrawals from final batches, executed by anyone, paid to the recipient the user signed for (EVIDENCE 72, 93);
- checking a settlement receipt you hold in Solidity: `SettlementReceiptVerifier` has no owner, and checks the anchor's ML-DSA-87 signature against the creator's key in the chain's key registry (EVIDENCE 60). A check against the rollup module needs the batch record, which the chain's parameters allow it to delete after 432,000 blocks (not yet observed, EVIDENCE 73).

**Stops:**
- anchors, and so settlement receipts for new batches: only the creator's key can anchor ([THREAT_MODEL §13](../THREAT_MODEL.md#13-residual-risks));
- instant exits: the quorum and the relayer are ours, so withdrawals are paid at finality instead;
- our watchtowers (other teams' watchers remain), the keep-alive, the alerts and the hosted web app.

**What this does not cover.** QoreChain governance can pause a based rollup, and funds then wait for governance ([STAGES.md](STAGES.md)). Nothing on this page works around the L1 itself.
