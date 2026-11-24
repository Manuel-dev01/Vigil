/**
 * What the relayer knows, built from the rollup's inbox alone: the quorum's signed exit claims for one
 * InstantExitVault, grouped by claim, each batch's withdrawal list as the attestations give it, and the
 * payout addresses it has been told about. Pure: no network, so it is tested offline.
 *
 * Nothing here is trusted on its own. A claim counts only if its signature verifies against the member's
 * registered ML-DSA-87 key, the vault re-checks every signature on-chain before it pays, and a batch's
 * withdrawal list is used only after it reproduces the withdrawals root the chain stores for that batch.
 */
import { bech32ToHex, hexToBech32, qledgerWithdrawalsRoot, withdrawalsRootMatches, type QledgerWithdrawal } from "@qorechain/rdk";
import { decodeAttestation, decodePayoutNotice, verifyClaim, type ExitClaim, type ExitTarget } from "@vigil/qledger-watchtower";

export interface InboxEntry {
  /** The entry's inbox sequence (1-based). */
  seq: number;
  /** The L1 account that posted it, or `deposit:<addr>` for a deposit. */
  poster: string;
  payload: Uint8Array;
}

/** One claim and the quorum members who signed it. */
export interface ClaimRecord {
  claim: ExitClaim;
  /** member index → ML-DSA-87 signature */
  sigs: Map<number, Uint8Array>;
  /** member index → the inbox entry that carried its signature */
  entries: Map<number, number>;
}

/** A batch's withdrawals in order, as one member's complete attestation lists them. */
export interface AttestedBatch {
  batchIndex: number;
  stateRoot: string;
  withdrawals: { index: number; amountUqor: bigint; recipient: string }[];
  /** the inbox entry the list came from */
  entry: number;
}

export interface IngestReport {
  attestations: number;
  claims: number;
  rejected: number;
  notices: number;
}

/** A claim with enough signatures to front: `signers` ascending, as `front` requires. */
export interface ReadyExit {
  claim: ExitClaim;
  signers: number[];
  sigs: Uint8Array[];
}

const norm = (h: string): string => h.toLowerCase().replace(/^0x/, "");

export const claimKey = (c: ExitClaim): string =>
  [c.batchIndex, norm(c.stateRoot), c.withdrawalIndex, c.amountUqor, norm(c.recipient), c.deadline].join(":");
export const batchKey = (batchIndex: number, stateRoot: string): string => `${batchIndex}:${norm(stateRoot)}`;
/** A withdrawal's identity: (batch, state root, global withdrawal index). */
export const withdrawalKey = (c: Pick<ExitClaim, "batchIndex" | "stateRoot" | "withdrawalIndex">): string =>
  `${batchKey(c.batchIndex, c.stateRoot)}:${c.withdrawalIndex}`;

export class ExitBook {
  readonly claims = new Map<string, ClaimRecord>();
  readonly batches = new Map<string, AttestedBatch>();
  /** Payout addresses (40 hex, lower case) seen but not yet handed to the caller. */
  readonly candidates = new Set<string>();
  private readonly vault: string;
  private readonly members: string[];

  /**
   * @param members the vault's `quorum()`, in order (indices are what `front` takes)
   * @param keys each member's ML-DSA-87 public key as the chain holds it (the vault's `keyOf`), hex
   */
  constructor(
    readonly target: ExitTarget,
    members: string[],
    readonly keys: string[],
  ) {
    if (members.length !== keys.length) throw new Error("one key per quorum member");
    this.vault = norm(target.vault);
    this.members = members.map(norm);
  }

  /** Read entries in inbox order. Every signature is checked here; a bad one is dropped and counted. */
  ingest(entries: InboxEntry[]): IngestReport {
    const report: IngestReport = { attestations: 0, claims: 0, rejected: 0, notices: 0 };
    for (const e of entries) {
      // Whoever posts into the inbox may want to be paid at their own L1 address.
      if (e.poster && !e.poster.startsWith("deposit:")) {
        try {
          this.candidates.add(norm(bech32ToHex(e.poster)));
        } catch {
          /* not an address */
        }
      }
      const notice = decodePayoutNotice(e.payload);
      if (notice) {
        if (norm(notice.vault) === this.vault) {
          this.candidates.add(norm(notice.payout));
          report.notices++;
        }
        continue;
      }
      const a = decodeAttestation(e.payload);
      if (!a || norm(a.vault) !== this.vault) continue;
      const m = this.members.indexOf(norm(a.member));
      if (m < 0) {
        report.rejected += a.claims.length;
        continue;
      }
      report.attestations++;
      const valid = a.claims.filter((s) => verifyClaim(this.target, this.keys[m]!, s));
      report.rejected += a.claims.length - valid.length;
      for (const s of valid) {
        const k = claimKey(s.claim);
        const rec = this.claims.get(k) ?? { claim: { ...s.claim, stateRoot: norm(s.claim.stateRoot), recipient: norm(s.claim.recipient) }, sigs: new Map(), entries: new Map() };
        if (!rec.sigs.has(m)) {
          rec.sigs.set(m, s.signature);
          rec.entries.set(m, e.seq);
          report.claims++;
        }
        this.claims.set(k, rec);
      }
      // A member attests a whole batch at once, every withdrawal in order. Keep the first such list
      // per batch; it is checked against the chain's withdrawals root before any use.
      if (valid.length > 0 && valid.length === a.claims.length) {
        const first = valid[0]!.claim;
        const bk = batchKey(first.batchIndex, first.stateRoot);
        const sameBatch = valid.every((s) => batchKey(s.claim.batchIndex, s.claim.stateRoot) === bk);
        const ascending = valid.every((s, i) => i === 0 || s.claim.withdrawalIndex === valid[i - 1]!.claim.withdrawalIndex + 1);
        if (sameBatch && ascending && !this.batches.has(bk)) {
          this.batches.set(bk, {
            batchIndex: first.batchIndex,
            stateRoot: norm(first.stateRoot),
            withdrawals: valid.map((s) => ({ index: s.claim.withdrawalIndex, amountUqor: s.claim.amountUqor, recipient: norm(s.claim.recipient) })),
            entry: e.seq,
          });
        }
      }
    }
    return report;
  }

  /** Claims that `threshold` distinct members signed, with the lowest-numbered signers first. */
  ready(threshold: number): ReadyExit[] {
    const out: ReadyExit[] = [];
    for (const rec of this.claims.values()) {
      if (rec.sigs.size < threshold) continue;
      const signers = [...rec.sigs.keys()].sort((x, y) => x - y).slice(0, threshold);
      out.push({ claim: rec.claim, signers, sigs: signers.map((i) => rec.sigs.get(i)!) });
    }
    return out.sort((x, y) => x.claim.deadline - y.claim.deadline || x.claim.withdrawalIndex - y.claim.withdrawalIndex);
  }

  /** Every attested withdrawal (with or without a quorum yet), one per withdrawal key. */
  withdrawals(): ExitClaim[] {
    const seen = new Map<string, ExitClaim>();
    for (const rec of this.claims.values()) {
      const k = withdrawalKey(rec.claim);
      if (!seen.has(k)) seen.set(k, rec.claim);
    }
    return [...seen.values()];
  }

  /** Drop everything known about one batch (it was rejected, replaced, or is fully settled). */
  forget(batchIndex: number, stateRoot: string): void {
    const bk = batchKey(batchIndex, stateRoot);
    this.batches.delete(bk);
    for (const [k, rec] of this.claims) if (batchKey(rec.claim.batchIndex, rec.claim.stateRoot) === bk) this.claims.delete(k);
  }
}

/** The batch's withdrawals as `MsgExecuteWithdrawal` proofs need them (recipients as canonical qor1). */
export function batchWithdrawals(b: AttestedBatch): QledgerWithdrawal[] {
  return b.withdrawals.map((w) => ({ index: BigInt(w.index), recipient: hexToBech32(`0x${w.recipient}`, "qor"), amount: w.amountUqor }));
}

/** Whether the list reproduces the withdrawals root the chain stores for the batch. */
export function withdrawalsMatch(
  chainId: string,
  rollupId: string,
  ws: QledgerWithdrawal[],
  storedRoot: Uint8Array,
  reduced: boolean,
): boolean {
  try {
    return withdrawalsRootMatches(storedRoot, qledgerWithdrawalsRoot(chainId, rollupId, ws), reduced);
  } catch {
    return false;
  }
}
