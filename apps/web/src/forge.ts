/**
 * The Verify page's forgeries. Each one changes a single field of the receipt the page built from the
 * chain; the page then runs the same checks on the forged receipt and names the check that caught it.
 * No dependencies beyond types, so the Verify view loads nothing new for it.
 */
import type { ReceiptVerification, SettlementReceipt } from "@qorechain/rdk";
import type { CheckKey } from "./pruned.ts";

export type ForgeryId = "stateRoot" | "signature" | "chainId" | "creator" | "rollupId";

export interface Forgery {
  id: ForgeryId;
  /** The button's words. */
  label: string;
  /** What it changes, in one sentence. */
  change: string;
  forge: (r: SettlementReceipt) => SettlementReceipt;
  /** Shown with the contract's answer when the contract does not read the field this forgery changes. */
  evmNote?: string;
}

/** QoreChain's mainnet chain id; the receipts here are for the testnet, qorechain-diana. */
const MAINNET = "qorechain-vladi";
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
  },
  {
    id: "signature",
    label: "One byte of the ML-DSA-87 signature",
    change: "Flips the lowest bit of the signature's first byte.",
    forge: (r) => ({ ...r, pqcSignature: (parseInt(r.pqcSignature.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0") + r.pqcSignature.slice(2) }),
  },
  {
    id: "chainId",
    label: "Another chain",
    change: `Names ${MAINNET}, QoreChain's mainnet, as the receipt's chain.`,
    forge: (r) => ({ ...r, chainId: r.chainId === MAINNET ? "qorechain-diana" : MAINNET }),
  },
  {
    id: "creator",
    label: "Another signer",
    change: "Names Vigil's standby sequencer (keel-b) as the rollup's creator.",
    forge: (r) => ({ ...r, creator: r.creator === STANDBY ? WATCHTOWER_2 : STANDBY }),
    evmNote:
      "The contract was fixed to the rollup's creator when it was deployed and never reads the receipt's signer, so it still finds the anchor's signature valid. The browser checks above catch this forgery.",
  },
  {
    id: "rollupId",
    label: "Another rollup",
    change: `Names a rollup other than the one the receipt is for ("${OTHER_ROLLUP}").`,
    forge: (r) => ({ ...r, rollupId: r.rollupId === OTHER_ROLLUP ? "vigil-pay-1" : OTHER_ROLLUP }),
  },
];

/**
 * The Verify page's checks in the order it lists and numbers them: the RDK's six, with the pinned-key
 * check after the key check, then the page's own two.
 */
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

/** The check that refused a receipt, or undefined if every receipt check passed. */
export function caughtBy(v: { valid: boolean; failed?: CheckKey | undefined; checks: ReceiptVerification["checks"] }): CheckKey | undefined {
  if (v.valid) return undefined;
  return v.failed ?? (ROW_ORDER.find((k) => k !== "pin" && k in v.checks && !v.checks[k as keyof ReceiptVerification["checks"]]) as CheckKey | undefined) ?? "rollupLayerBinding";
}

/** The check that caught each forgery tried on the current receipt (null: it was not caught). */
export type Outcomes = Partial<Record<ForgeryId, CheckKey | null>>;

/** "3 forgeries tried, 3 caught". */
export function tally(o: Outcomes): { tried: number; caught: number; text: string } {
  const all = Object.values(o);
  const tried = all.length;
  const caught = all.filter((k) => k !== null && k !== undefined).length;
  return { tried, caught, text: tried === 0 ? "No forgery tried yet." : `${tried} ${tried === 1 ? "forgery" : "forgeries"} tried, ${caught} caught` };
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
