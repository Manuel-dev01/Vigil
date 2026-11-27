/**
 * The Verify page's forgeries. Each one changes a single field of the receipt the page built from the
 * chain; the page then runs the same checks on the forged receipt and names the check that caught it.
 * Imports only the RDK's chain-id table, which the Verify view already loads.
 */
import { CHAIN_IDS, type ReceiptVerification, type SettlementReceipt } from "@qorechain/rdk";
import type { CheckKey } from "./pruned.ts";

export type ForgeryId = "stateRoot" | "signature" | "chainId" | "creator" | "rollupId";

export interface Forgery {
  id: ForgeryId;
  /** The button's words. */
  label: string;
  /** What it changes, in one sentence. */
  change: string;
  forge: (r: SettlementReceipt) => SettlementReceipt;
  /**
   * The checks that test the field this forgery changes, so a refusal by one of them is a catch. A refusal by
   * any other check (a node that failed to answer, say) is reported as such and not counted as caught.
   */
  refusedBy: readonly CheckKey[];
  /** Shown with the contract's answer when the contract does not read the field this forgery changes. */
  evmNote?: string;
}

/** Vigil's standby sequencer (keel-b) and watchtower-2: real accounts, neither of them the rollup's creator. */
const STANDBY = "qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft";
const WATCHTOWER_2 = "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd";
const OTHER_ROLLUP = "another-rollup";

export const FORGERIES: readonly Forgery[] = [
  {
    id: "stateRoot",
    label: "One digit of the state root",
    change: "Changes the first hex digit of the state root.",
    forge: (r) => ({ ...r, stateRoot: (r.stateRoot[0] === "0" ? "1" : "0") + r.stateRoot.slice(1) }),
    refusedBy: ["batchStateRoot", "anchorOnChain", "pqcSignature"],
  },
  {
    id: "signature",
    label: "One byte of the ML-DSA-87 signature",
    change: "Flips the lowest bit of the signature's first byte.",
    forge: (r) => ({ ...r, pqcSignature: (parseInt(r.pqcSignature.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0") + r.pqcSignature.slice(2) }),
    refusedBy: ["anchorOnChain", "pqcSignature"],
  },
  {
    id: "chainId",
    label: "Another chain",
    change: `Names ${CHAIN_IDS.mainnet}, QoreChain's mainnet, as the receipt's chain.`,
    forge: (r) => ({ ...r, chainId: r.chainId === CHAIN_IDS.mainnet ? CHAIN_IDS.testnet : CHAIN_IDS.mainnet }),
    refusedBy: ["chainBinding", "pqcSignature"],
  },
  {
    id: "creator",
    label: "Another signer",
    change: "Names Vigil's standby sequencer (keel-b) as the rollup's creator.",
    forge: (r) => ({ ...r, creator: r.creator === STANDBY ? WATCHTOWER_2 : STANDBY }),
    refusedBy: ["creatorAuthority"],
    evmNote:
      "The contract was fixed to the rollup's creator when it was deployed and never reads the receipt's signer, so it still finds the anchor's signature valid. The browser checks above catch this forgery.",
  },
  {
    id: "rollupId",
    label: "Another rollup",
    change: `Names a rollup other than the one the receipt is for ("${OTHER_ROLLUP}").`,
    forge: (r) => ({ ...r, rollupId: r.rollupId === OTHER_ROLLUP ? "vigil-pay-1" : OTHER_ROLLUP }),
    refusedBy: ["rollupLayerBinding"],
  },
];

/** The Verify page's checks in the order it lists and numbers them. */
export const ROW_ORDER: readonly (CheckKey | "pin")[] = [
  "rollupLayerBinding",
  "batchStateRoot",
  "anchorOnChain",
  "creatorAuthority",
  "pin",
  "chainBinding",
  "pqcSignature",
  "ownAnchor",
  "final",
];

/** A check's number on the page, from 1. */
export const rowNumber = (key: CheckKey | "pin"): number => ROW_ORDER.indexOf(key) + 1;

type Checked = { valid: boolean; failed?: CheckKey | undefined; reason?: string | undefined; checks: ReceiptVerification["checks"] };

/** The check that refused a receipt, or undefined if every receipt check passed. */
export function caughtBy(v: Checked): CheckKey | undefined {
  if (v.valid) return undefined;
  return v.failed ?? (ROW_ORDER.find((k) => k !== "pin" && k in v.checks && !v.checks[k as keyof ReceiptVerification["checks"]]) as CheckKey | undefined) ?? "rollupLayerBinding";
}

/**
 * What became of one forgery: refused by `by`, which `expected` says is a check that tests the changed field;
 * or null when every receipt check passed (not caught).
 */
export type Outcome = { by: CheckKey; expected: boolean; reason?: string } | null;

export function outcomeOf(f: Forgery, v: Checked): Outcome {
  const by = caughtBy(v);
  if (!by) return null;
  return { by, expected: f.refusedBy.includes(by), ...(v.reason ? { reason: v.reason } : {}) };
}

/** What became of each forgery tried on the current receipt. */
export type Outcomes = Partial<Record<ForgeryId, Outcome>>;

/** "5 forgeries tried, 5 caught", plus any refused by a check that does not test the changed field. */
export function tally(o: Outcomes): { tried: number; caught: number; other: number; text: string } {
  const all = Object.values(o).filter((x) => x !== undefined);
  const tried = all.length;
  const caught = all.filter((x) => x?.expected).length;
  const other = all.filter((x) => x && !x.expected).length;
  const text =
    tried === 0
      ? "No forgery tried yet."
      : `${tried} ${tried === 1 ? "forgery" : "forgeries"} tried, ${caught} caught` + (other ? `, ${other} refused for another reason` : "");
  return { tried, caught, other, text };
}

/** The fields of `r` that differ from `base`, by receipt key. */
export function changedFields(r: SettlementReceipt, base: SettlementReceipt | undefined): Set<keyof SettlementReceipt> {
  const out = new Set<keyof SettlementReceipt>();
  if (!base) return out;
  for (const k of new Set([...Object.keys(r), ...Object.keys(base)]) as Set<keyof SettlementReceipt>) {
    if (JSON.stringify(r[k]) !== JSON.stringify(base[k])) out.add(k);
  }
  return out;
}
