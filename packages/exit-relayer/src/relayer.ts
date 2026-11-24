/**
 * The exit relayer: pays instant exits with nobody running a script.
 *
 * Each pass:
 *  1. Reads new entries of the rollup's inbox (checked against the chain's inbox accumulator) and keeps
 *     the quorum's exit attestations whose signatures verify, plus payout notices and posters.
 *  2. Maps payouts to exit addresses with the vault's `exitAddressOf`, and tracks every attested
 *     withdrawal that pays the exit address of a payout it knows.
 *  3. Fronts each tracked withdrawal that the quorum has signed, while its batch is unchallenged and
 *     before the claim's deadline, after a free `verifyExit` call says the vault will accept it.
 *  4. Once a tracked withdrawal's batch is final, executes it on L1 (a native transaction, hybrid-signed),
 *     with the proof built from the batch's withdrawal list as the attestation gives it. The list is used
 *     only if it reproduces the withdrawals root the chain stores for that batch.
 *  5. Sweeps each exit address that holds money: the vault is repaid first, the rest goes to the payout.
 *
 * The relayer's ECDSA key can reach the EVM only inside a window that its ML-DSA-87 key opens. Every
 * window admits exactly the calls about to be made: one target (the vault), as many transactions as
 * calls, and a value cap equal to their fees at the gas price they are sent with. It is closed right
 * after. Every vault function is safe for any caller, so even a stolen ECDSA key could do nothing
 * inside the window but pay exits correctly, and nothing at all outside it.
 */
import {
  EMPTY_INBOX_ACC,
  QLEDGER_WITHDRAWAL_DENOM,
  bech32ToHex,
  bytesToHex,
  decodeWireBytes,
  executeWithdrawalMsg,
  fetchQledgerEntries,
  hexToBech32,
  qledgerWithdrawalProof,
  type BatchView,
  type RestClient,
} from "@qorechain/rdk";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import { restGet } from "@vigil/core";
import type { HybridSender } from "@vigil/keel/chain";
import type { ExitClaim } from "@vigil/qledger-watchtower";
import { getAddress, type Hex } from "viem";
import { ExitBook, batchKey, batchWithdrawals, withdrawalKey, withdrawalsMatch, type InboxEntry } from "./book.ts";
import { Vault, WEI_PER_UQOR, exitArg, feeCapUqor, revertReason, type PreparedCall } from "./vault.ts";

export interface RelayerOptions {
  chainId: string;
  evmChainId: number;
  rollupId: string;
  /** "relay" sends; "observe" logs what it would send and sends nothing. */
  mode: "relay" | "observe";
  /** Never front a claim this many seconds or fewer before its deadline. */
  frontMarginSec: number;
  /** Inbox entries to read back on start. */
  lookback: number;
  /** How long each EVM window lasts, in blocks. */
  windowBlocks: number;
  /** The rollup's challenge window, for logs (how early an exit was paid). */
  challengeWindowSec: number;
  /** Never front an exit smaller than this (uqor): each costs the relayer ~0.13 QOR in fees. */
  minExitUqor: bigint;
  /** Send nothing while the relayer's own balance is below this (uqor). */
  minBalanceUqor: bigint;
  /** At most this many EVM windows in any hour. */
  windowsPerHour: number;
}

export interface Quorum {
  /** The vault's `quorum()`, 0x addresses, in order. */
  members: string[];
  /** Each member's ML-DSA-87 key from the vault's `keyOf`, hex. */
  keys: string[];
  threshold: number;
  feeBps: number;
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

interface Tracked {
  claim: ExitClaim;
  /** 40 hex */
  payout: string;
  /** Why fronting is settled for this withdrawal ("fronted", "expired", …); undefined while it may still be fronted. */
  front?: string;
  executed?: boolean;
  swept?: boolean;
  dropped?: string;
  /** Passes on which the exit address read empty while nothing was owed. */
  zeroSeen?: number;
  sweepFailures?: number;
}

interface Planned {
  call: PreparedCall;
  fields: Record<string, unknown>;
  tracked: Tracked[];
}

interface WindowView {
  found: boolean;
  live: boolean;
  expiry_height?: string;
  max_txs?: string;
  used_txs?: string;
}

const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");
const is404 = (e: unknown): boolean => (e as { status?: unknown }).status === 404 || /HTTP 404|not found/i.test((e as Error).message ?? "");

export class Relayer {
  readonly book: ExitBook;
  private cursor?: number;
  /** exit address (40 hex) → payout (40 hex) */
  private readonly exitToPayout = new Map<string, string>();
  private readonly resolved = new Set<string>();
  private readonly tracked = new Map<string, Tracked>();
  private readonly said = new Set<string>();
  /** Payouts from the operator's configuration; only these may be contracts. */
  private readonly configured: Set<string>;
  private windowTimes: number[] = [];

  constructor(
    private readonly rest: RestClient,
    private readonly vault: Vault,
    private readonly sender: HybridSender | undefined,
    private readonly quorum: Quorum,
    private readonly opts: RelayerOptions,
    private readonly log: Logger,
    payouts: string[] = [],
  ) {
    this.book = new ExitBook({ evmChainId: opts.evmChainId, vault: vault.address, chainId: opts.chainId, rollupId: opts.rollupId }, quorum.members, quorum.keys);
    this.configured = new Set(payouts.map(norm));
    for (const p of this.configured) this.book.candidates.add(p);
  }

  /** What the relayer is tracking, for a status line. */
  summary(): Record<string, number> {
    const t = [...this.tracked.values()];
    return {
      inboxCursor: this.cursor ?? 0,
      payouts: this.resolved.size,
      tracked: t.length,
      fronted: t.filter((x) => x.front === "fronted").length,
      executed: t.filter((x) => x.executed).length,
      swept: t.filter((x) => x.swept).length,
    };
  }

  async pass(): Promise<void> {
    // A window must never outlive the calls it was opened for (say, after a crash mid-pass).
    await this.closeStrayWindow().catch((e) => this.once(`stray:${errText(e)}`, "window-check-failed", { message: errText(e) }));
    // A failed read must not stop what is already tracked from being executed and swept.
    try {
      await this.readInbox();
      await this.resolvePayouts();
    } catch (e) {
      this.once(`inbox:${errText(e)}`, "inbox-read-failed", { message: errText(e), note: "still executing and sweeping what is tracked" });
    }
    this.track();
    const batches = new Map<number, BatchView | null>();
    const batchOf = async (i: number): Promise<BatchView | null> => {
      if (!batches.has(i)) {
        try {
          batches.set(i, await this.rest.getBatch(this.opts.rollupId, i));
        } catch (e) {
          if (!is404(e)) throw e;
          batches.set(i, null);
        }
      }
      return batches.get(i) ?? null;
    };
    // One gas price for the whole pass: calls are estimated at it, sent at it, and the window's cap counts it.
    const gasPrice = await this.vault.pub.getGasPrice();
    const calls: Planned[] = [];
    await this.planFronts(batchOf, calls, gasPrice);
    await this.execute(batchOf);
    await this.planSweeps(calls, gasPrice);
    await this.send(calls, gasPrice);
    this.forgetSettled();
  }

  // ------------------------------------------------------------------ reading

  private async readInbox(): Promise<void> {
    const { rollupId, chainId } = this.opts;
    const head = Number((await this.rest.getInbox(rollupId)).headSequence);
    if (this.cursor === undefined) {
      this.cursor = await this.firstKept(Math.max(0, head - this.opts.lookback), head);
      this.log("inbox-start", { from: this.cursor + 1, head });
    }
    while (this.cursor < head) {
      const from = this.cursor;
      const to = Math.min(from + 64, head);
      const accFrom = from === 0 ? EMPTY_INBOX_ACC : decodeWireBytes((await this.rest.getPostedData(rollupId, from)).inboxAcc);
      const got = await fetchQledgerEntries(this.rest, { chainId, rollupId, from: BigInt(from), to: BigInt(to), accFrom });
      const entries: InboxEntry[] = got.map((e, i) => ({ seq: from + 1 + i, poster: e.poster, payload: e.payload }));
      const r = this.book.ingest(entries);
      if (r.attestations || r.notices || r.rejected) this.log("inbox", { from: from + 1, to, ...r });
      this.cursor = to;
    }
  }

  /** The lowest sequence ≥ `lo` from which entries can still be read (the chain prunes old commitments). */
  private async firstKept(lo: number, head: number): Promise<number> {
    if (lo === 0) return 0;
    const kept = async (s: number): Promise<boolean> => {
      try {
        await this.rest.getPostedData(this.opts.rollupId, s);
        return true;
      } catch (e) {
        if (is404(e)) return false;
        throw e;
      }
    };
    if (await kept(lo)) return lo;
    let gone = lo;
    let ok = head;
    while (ok - gone > 1) {
      const mid = Math.floor((gone + ok) / 2);
      if (await kept(mid)) ok = mid;
      else gone = mid;
    }
    return ok;
  }

  private async resolvePayouts(): Promise<void> {
    for (const c of [...this.book.candidates]) {
      if (this.resolved.has(c) || !/^[0-9a-f]{40}$/.test(c)) {
        this.book.candidates.delete(c);
        continue;
      }
      const addr = getAddress(`0x${c}`);
      // A contract payout can pass every free check and still revert in the real call (it can read
      // tx.gasprice, say), which would cost a window every pass. Only configured payouts may be contracts.
      if (!this.configured.has(c)) {
        const code = await this.vault.pub.getCode({ address: addr });
        if (code && code !== "0x") {
          this.resolved.add(c);
          this.book.candidates.delete(c);
          this.log("payout-refused", { payout: addr, reason: "a contract; only configured payouts may be contracts" });
          continue;
        }
      }
      const ea = await this.vault.read<Hex>("exitAddressOf", [addr]);
      this.exitToPayout.set(norm(ea), c);
      this.resolved.add(c);
      this.book.candidates.delete(c);
    }
  }

  /** Track every attested withdrawal that any claim says pays the exit address of a known payout. */
  private track(): void {
    for (const rec of this.book.claims.values()) {
      const c = rec.claim;
      const k = withdrawalKey(c);
      if (this.tracked.has(k)) continue;
      const payout = this.exitToPayout.get(norm(c.recipient));
      if (!payout) continue;
      const t: Tracked = { claim: c, payout };
      this.tracked.set(k, t);
      this.log("exit-seen", this.describe(t));
    }
  }

  // ------------------------------------------------------------------ fronting

  private async planFronts(batchOf: (i: number) => Promise<BatchView | null>, calls: Planned[], gasPrice: bigint): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    let liquidity: bigint | undefined;
    for (const r of this.book.ready(this.quorum.threshold)) {
      const k = withdrawalKey(r.claim);
      const t = this.tracked.get(k);
      if (!t || t.front || t.dropped || calls.some((c) => c.tracked.includes(t))) continue;
      // The payout comes from the claim the quorum signed, not from whichever claim was seen first.
      const payout = this.exitToPayout.get(norm(r.claim.recipient));
      if (!payout) continue;
      if (!t.executed) t.payout = payout;
      const fields = this.describe(t);
      if (r.claim.amountUqor < this.opts.minExitUqor) {
        t.front = "below the minimum exit amount";
        this.log("front-skipped", { ...fields, reason: t.front, minExitUqor: this.opts.minExitUqor.toString() });
        continue;
      }
      if (r.claim.deadline <= now + this.opts.frontMarginSec) {
        t.front = r.claim.deadline <= now ? "claim expired" : "too close to its deadline";
        this.log("front-skipped", { ...fields, reason: t.front, deadline: r.claim.deadline });
        continue;
      }
      const b = await batchOf(r.claim.batchIndex);
      if (!b) {
        this.once(`nobatch:${k}`, "front-waiting", { ...fields, reason: "batch not found" });
        continue;
      }
      if (rootOf(b) !== r.claim.stateRoot) {
        t.front = "batch replaced";
        this.log("front-skipped", { ...fields, reason: "the batch at this index now has a different state root" });
        continue;
      }
      if (b.status !== "submitted") {
        t.front = `batch ${b.status}`;
        this.log("front-skipped", { ...fields, reason: `batch is ${b.status}` });
        continue;
      }
      const args = [exitArg(r.claim, payout), r.signers.map(BigInt), r.sigs.map((s) => `0x${bytesToHex(s)}` as Hex)] as const;
      const v = await this.vault.outcome<Hex>("verifyExit", args);
      if (!v.ok) {
        if (v.reason.startsWith("AlreadyFronted")) {
          t.front = "fronted";
          this.log("front-skipped", { ...fields, reason: "already fronted" });
        } else if (v.reason.startsWith("Expired")) {
          t.front = "expired";
          this.log("front-skipped", { ...fields, reason: "claim expired" });
        } else {
          this.once(`refused:${k}:${v.reason}`, "front-refused", { ...fields, reason: v.reason });
        }
        continue;
      }
      const amount = r.claim.amountUqor * WEI_PER_UQOR;
      const fee = (amount * BigInt(this.quorum.feeBps)) / 10_000n;
      const pay = amount - fee;
      liquidity ??= await this.vault.read<bigint>("available");
      if (liquidity < pay) {
        this.once(`liquidity:${k}`, "front-waiting", { ...fields, reason: "not enough liquidity", availableWei: liquidity.toString(), neededWei: pay.toString() });
        continue;
      }
      if (!this.sender) {
        this.once(`would:${k}`, "would-front", { ...fields, exitId: v.value, payWei: pay.toString() });
        continue;
      }
      try {
        const call = await this.vault.prepare(this.sender.account.evm as Hex, "front", args, gasPrice);
        liquidity -= pay;
        calls.push({
          call,
          tracked: [t],
          fields: {
            ...fields,
            exitId: v.value,
            signers: r.signers,
            payWei: pay.toString(),
            feeWei: fee.toString(),
            deadline: r.claim.deadline,
            finalAt: (b.submittedTime ?? 0) + this.opts.challengeWindowSec,
          },
        });
      } catch (e) {
        this.once(`estimate:${k}`, "front-refused", { ...fields, reason: revertReason(e) });
      }
    }
  }

  // ---------------------------------------------------------------- executing

  private async execute(batchOf: (i: number) => Promise<BatchView | null>): Promise<void> {
    for (const [k, t] of this.tracked) {
      if (t.executed || t.dropped) continue;
      try {
        await this.executeOne(k, t, batchOf);
      } catch (e) {
        this.once(`exec-error:${k}:${errText(e)}`, "execute-failed", { ...this.describe(t), message: errText(e) });
      }
    }
  }

  private async executeOne(k: string, t: Tracked, batchOf: (i: number) => Promise<BatchView | null>): Promise<void> {
    const { chainId, rollupId } = this.opts;
    {
      const fields = this.describe(t);
      const b = await batchOf(t.claim.batchIndex);
      if (!b) return;
      if (rootOf(b) !== t.claim.stateRoot) {
        t.dropped = "the batch at this index now has a different state root";
        this.log("exit-dropped", { ...fields, reason: t.dropped });
        return;
      }
      if (b.status === "rejected") {
        t.dropped = "batch rejected";
        this.log("exit-dropped", { ...fields, reason: t.dropped });
        return;
      }
      if (b.status !== "finalized") return;
      const attested = this.book.batches.get(batchKey(t.claim.batchIndex, t.claim.stateRoot));
      if (!attested) {
        this.once(`nolist:${k}`, "execute-waiting", { ...fields, reason: "no complete attested withdrawal list for this batch" });
        return;
      }
      const ws = batchWithdrawals(attested);
      if (!withdrawalsMatch(chainId, rollupId, ws, decodeWireBytes(b.withdrawalsRoot), b.withdrawalsRootReduced)) {
        // Incomplete so far (claims arrive one per post, and a member signs no claim for a withdrawal
        // that cannot be to an exit address). Keep waiting; anyone else may still execute it.
        this.once(`incomplete:${k}:${ws.length}`, "execute-waiting", { ...fields, reason: "the attested withdrawal list does not reproduce the batch's withdrawals root yet", attested: ws.length });
        return;
      }
      const pos = ws.findIndex((w) => w.index === BigInt(t.claim.withdrawalIndex));
      const w = ws[pos];
      // The root-checked list says where the money really goes; sweep for that payout.
      if (w) {
        const truePayout = this.exitToPayout.get(norm(bech32ToHex(w.recipient)));
        if (!truePayout) {
          t.dropped = "the batch pays this withdrawal to an address that is not a known exit address";
          this.log("exit-dropped", { ...fields, reason: t.dropped });
          return;
        }
        t.payout = truePayout;
      }
      if (!w || !this.sender) {
        if (!this.sender) this.once(`would-exec:${k}`, "would-execute", fields);
        return;
      }
      const msg = executeWithdrawalMsg({
        submitter: this.sender.address,
        rollupId,
        batchIndex: t.claim.batchIndex,
        withdrawalIndex: w.index,
        recipient: w.recipient,
        denom: QLEDGER_WITHDRAWAL_DENOM,
        amount: w.amount,
        proof: qledgerWithdrawalProof(chainId, rollupId, ws, pos),
      });
      const sim = await this.sender.simulate([msg]);
      if (!sim.ok || sim.gasUsed === undefined) {
        if (/already/i.test(sim.error ?? "")) {
          t.executed = true;
          this.log("execute-skipped", { ...fields, reason: "already executed on L1", chain: (sim.error ?? "").slice(0, 200) });
        } else {
          this.once(`execfail:${k}:${sim.error}`, "execute-refused", { ...fields, reason: (sim.error ?? "").slice(0, 300) });
        }
        return;
      }
      if (this.opts.mode !== "relay") {
        this.once(`would-exec:${k}`, "would-execute", { ...fields, gas: sim.gasUsed });
        return;
      }
      const res = await this.sender.send([msg], sim.gasUsed);
      t.executed = true;
      this.log("executed", { ...fields, tx: res.transactionHash, height: res.height, feeUqor: res.feeUqor });
    }
  }

  // ----------------------------------------------------------------- sweeping

  private async planSweeps(calls: Planned[], gasPrice: bigint): Promise<void> {
    const byPayout = new Map<string, Tracked[]>();
    for (const t of this.tracked.values()) {
      if (!t.executed || t.swept || t.dropped) continue;
      byPayout.set(t.payout, [...(byPayout.get(t.payout) ?? []), t]);
    }
    for (const [payout, ts] of byPayout) {
      const exitAddress = getAddress(`0x${ts[0]!.claim.recipient}`);
      const held = await this.vault.balance(exitAddress);
      const fields = { payout: getAddress(`0x${payout}`), exitAddress: hexToBech32(exitAddress, "qor"), heldWei: held.toString(), withdrawals: ts.map((t) => `${t.claim.batchIndex}/${t.claim.withdrawalIndex}`) };
      if (held === 0n) {
        // An empty read right after an execution may just be a lagging node: count it as swept only
        // when nothing is owed and it has read empty on 3 passes.
        const owedNow = await this.vault.read<bigint>("owed", [getAddress(`0x${payout}`)]);
        if (owedNow > 0n) {
          this.once(`sweep-wait:${payout}`, "sweep-waiting", { ...fields, reason: "the exit address reads empty but the payout still owes the vault", owedWei: owedNow.toString() });
          continue;
        }
        let seen = 0;
        for (const t of ts) seen = t.zeroSeen = (t.zeroSeen ?? 0) + 1;
        if (seen >= 3) {
          for (const t of ts) t.swept = true;
          this.log("sweep-skipped", { ...fields, reason: "the exit address is empty and nothing is owed (already swept)" });
        }
        continue;
      }
      if (ts.some((t) => (t.sweepFailures ?? 0) >= 2)) {
        this.once(`sweep-given-up:${payout}`, "sweep-given-up", { ...fields, reason: "sweep() reverted twice; anyone may still call it" });
        continue;
      }
      if (!this.sender) {
        this.once(`would-sweep:${payout}:${held}`, "would-sweep", fields);
        continue;
      }
      try {
        const owedWei = await this.vault.read<bigint>("owed", [getAddress(`0x${payout}`)]);
        const call = await this.vault.prepare(this.sender.account.evm as Hex, "sweep", [getAddress(`0x${payout}`)], gasPrice);
        calls.push({ call, tracked: ts, fields: { ...fields, owedWei: owedWei.toString() } });
      } catch (e) {
        this.once(`sweepfail:${payout}`, "sweep-refused", { ...fields, reason: revertReason(e) });
      }
    }
  }

  // ------------------------------------------------------------------ sending

  private async send(calls: Planned[], gasPrice: bigint): Promise<void> {
    if (calls.length === 0) return;
    if (this.opts.mode !== "relay" || !this.sender) {
      for (const c of calls) this.once(`would-${c.call.functionName}:${JSON.stringify(c.fields)}`, `would-${c.call.functionName}`, c.fields);
      return;
    }
    const balance = await this.sender.balanceUqor();
    if (balance < this.opts.minBalanceUqor) {
      this.once(`low-balance:${Math.floor(Date.now() / 3_600_000)}`, "send-skipped", { reason: "balance below the floor", balanceUqor: balance.toString(), floorUqor: this.opts.minBalanceUqor.toString() });
      return;
    }
    this.windowTimes = this.windowTimes.filter((x) => x > Date.now() - 3_600_000);
    if (this.windowTimes.length >= this.opts.windowsPerHour) {
      this.once(`window-budget:${Math.floor(Date.now() / 3_600_000)}`, "send-skipped", { reason: "hourly window budget spent", windowsPerHour: this.opts.windowsPerHour });
      return;
    }
    this.windowTimes.push(Date.now());
    // Each transaction's fee is converted to uqor rounding up, so allow 1 uqor per call on top.
    const cap = feeCapUqor(
      calls.map((c) => c.call),
      gasPrice,
    ) + BigInt(calls.length);
    try {
      await this.openWindow(calls.length, cap);
      await this.vault.sendAll(
        calls.map((c) => c.call),
        gasPrice,
        (call, receipt) => {
          const c = calls.find((x) => x.call === call)!;
          const ok = receipt.status === "success";
          const fields = { ...c.fields, tx: receipt.transactionHash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() };
          if (call.functionName === "front") {
            // A front that reverts after every free check passed is never retried: that is how an
            // outsider would make the relayer pay for a window every pass.
            c.tracked[0]!.front = ok ? "fronted" : "front reverted";
            const finalAt = Number(c.fields["finalAt"] ?? 0);
            this.log(ok ? "fronted" : "front-failed", { ...fields, secondsBeforeFinal: finalAt ? finalAt - Math.floor(Date.now() / 1000) : undefined });
          } else {
            for (const t of c.tracked) {
              if (ok) t.swept = true;
              else t.sweepFailures = (t.sweepFailures ?? 0) + 1;
            }
            this.log(ok ? "swept" : "sweep-failed", fields);
          }
        },
      );
    } finally {
      await this.closeWindow("calls sent").catch((e) => this.log("window-close-failed", { message: errText(e) }));
    }
  }

  private windowView(): Promise<WindowView> {
    return restGet<WindowView>(`/qorechain/pqc/v1/evm_window/${this.sender!.address}`);
  }

  private async openWindow(txs: number, capUqor: bigint): Promise<void> {
    const sender = this.sender!;
    const w = await this.windowView();
    if (w.found) await this.closeWindow("replacing a window left from an earlier pass");
    const msg = openEvmWindowMsg({
      sender: sender.address,
      blocks: this.opts.windowBlocks,
      maxTxs: txs,
      maxValue: capUqor.toString(),
      allowedTargets: [this.vault.address],
    });
    const sim = await sender.simulate([msg]);
    if (!sim.ok || sim.gasUsed === undefined) throw new Error(`opening the EVM window would fail: ${sim.error}`);
    const res = await sender.send([msg], sim.gasUsed);
    this.log("window-opened", { tx: res.transactionHash, height: res.height, blocks: this.opts.windowBlocks, maxTxs: txs, maxValueUqor: capUqor.toString(), allowedTarget: this.vault.address, feeUqor: res.feeUqor });
  }

  private async closeWindow(why: string): Promise<void> {
    const sender = this.sender!;
    const w = await this.windowView();
    if (!w.found) return;
    const msg = closeEvmWindowMsg(sender.address);
    const sim = await sender.simulate([msg]);
    if (!sim.ok || sim.gasUsed === undefined) {
      this.log("window-close-failed", { reason: (sim.error ?? "").slice(0, 300) });
      return;
    }
    const res = await sender.send([msg], sim.gasUsed);
    this.log("window-closed", { tx: res.transactionHash, height: res.height, usedTxs: w.used_txs, maxTxs: w.max_txs, why, feeUqor: res.feeUqor });
  }

  /** A window must never outlive the calls it was opened for (say, after a crash mid-pass). */
  private async closeStrayWindow(): Promise<void> {
    if (this.opts.mode !== "relay" || !this.sender) return;
    if ((await this.windowView()).found) await this.closeWindow("left open by an earlier pass");
  }

  // ------------------------------------------------------------------ helpers

  /** Forget batches whose tracked exits are all settled, a day after their claims expired. */
  private forgetSettled(): void {
    const now = Math.floor(Date.now() / 1000);
    const byBatch = new Map<string, Tracked[]>();
    for (const t of this.tracked.values()) {
      const bk = batchKey(t.claim.batchIndex, t.claim.stateRoot);
      byBatch.set(bk, [...(byBatch.get(bk) ?? []), t]);
    }
    for (const [bk, ts] of byBatch) {
      const settled = ts.every((t) => t.dropped || (t.executed && t.swept));
      if (!settled || ts.some((t) => t.claim.deadline > now - 86_400)) continue;
      const c = ts[0]!.claim;
      this.book.forget(c.batchIndex, c.stateRoot);
      for (const t of ts) this.tracked.delete(withdrawalKey(t.claim));
      this.log("batch-forgotten", { batch: bk });
    }
  }

  private describe(t: Tracked): Record<string, unknown> {
    return {
      batch: t.claim.batchIndex,
      withdrawal: t.claim.withdrawalIndex,
      amountUqor: t.claim.amountUqor.toString(),
      payout: getAddress(`0x${t.payout}`),
      exitAddress: hexToBech32(`0x${t.claim.recipient}`, "qor"),
    };
  }

  private once(key: string, event: string, fields: Record<string, unknown>): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.log(event, fields);
  }
}

const rootOf = (b: BatchView): string => bytesToHex(decodeWireBytes(b.stateRoot)).toLowerCase();
const errText = (e: unknown): string => ((e as Error)?.message ?? String(e)).split("\n")[0]!.slice(0, 200);
