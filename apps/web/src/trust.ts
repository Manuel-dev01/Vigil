/**
 * The trust page's logic, kept free of the browser so it can be tested: what the chain reports (parsed from
 * the node's own REST JSON, which the page reads over the websocket), and what that means for each part of
 * the page — the risk rosette, the Stages checklist, who can do what, and the instant-exit risk card.
 *
 * Everything here is a self-assessment against L2BEAT's Stages framework (the site now calls itself ETHBEAT).
 * It is not an L2BEAT rating, and it claims no stage.
 */
import { hexToBech32 } from "@qorechain/rdk";
import { KNOWN, REPO, dur, qor, shortAddr } from "./config.ts";

/** The framework this page measures against, as read from its public pages on 27 Nov 2026. */
export const FRAMEWORK = {
  name: "L2BEAT's Stages framework",
  page: "https://ethbeat.org/stages",
  /** The page's own footer: "Copyright 2026 ETHBEAT (formerly L2BEAT)"; l2beat.com/stages redirects to it. */
  formerly: "l2beat.com/stages",
  /** The page gives no version number, only this date. */
  pageUpdated: "23 Jul 2025",
  spec: "https://forum.ethbeat.org/t/the-stages-framework/291",
  stage1Update: { title: "Stage 1 update: minimum challenge period reduction from 7d to 5d", url: "https://forum.ethbeat.org/t/stage-1-update-minimum-challenge-period-reduction-from-7d-to-5d/425", date: "30 Apr 2026" },
  readOn: "27 Nov 2026",
  stage1MinChallengeSec: 5 * 86_400,
  stage1MinExitWindowSec: 7 * 86_400,
  stage2MinExitWindowSec: 30 * 86_400,
} as const;

// ------------------------------------------------------------ references

export interface Ref {
  label: string;
  href: string;
}

const EVIDENCE = `${REPO}/blob/main/EVIDENCE.md`;
const THREAT = `${REPO}/blob/main/THREAT_MODEL.md`;
/** GitHub's anchors for the threat model's headings. */
const SECTIONS = {
  "5": "5-why-each-design-choice-resists-the-adversaries-above",
  "7": "7-fraud-drills-on-vigil-pay-1-19-nov-2026",
  "7k": "kill-the-sequencer-20-nov-2026",
  "8": "8-operations-hosted-keys-and-services",
  "10": "10-facts-we-measured-and-rely-on",
  "12": "12-findings",
  "13": "13-residual-risks",
  "14": "14-instant-exits-23-nov-2026",
} as const;

/** A link to rows of EVIDENCE.md, e.g. `ev("65–72")`. */
export const ev = (rows: string): Ref => ({ label: `EVIDENCE ${rows}`, href: EVIDENCE });
/** A link to a section of THREAT_MODEL.md. */
export const tm = (s: keyof typeof SECTIONS): Ref => ({ label: `THREAT_MODEL §${s === "7k" ? "7" : s}`, href: `${THREAT}#${SECTIONS[s]}` });
export const doc = (path: string, label = path): Ref => ({ label, href: `${REPO}/blob/main/${path}` });

// ------------------------------------------------------------ what the chain reports

export interface RollupFacts {
  status: string;
  sequencing: string;
  executionVm: string;
  proofSystem: string;
  challengeWindowSec: number | undefined;
  creator: string;
  /** What the rollup's withdrawals are paid from (uqor). */
  depositPoolUqor: string;
  /** The creator's stake held by the module (uqor); not users' money. */
  escrowUqor: string;
}

export interface RdkParamsFacts {
  minSubmitterBondUqor: string;
  postedDataRetentionBlocks: number | undefined;
}

export interface GovFacts {
  votingPeriodSec: number;
  expeditedVotingPeriodSec: number | undefined;
}

export interface CircuitAccount {
  address: string;
  level: string;
  msgs: string[];
}

export interface CircuitFacts {
  disabled: string[];
  accounts: CircuitAccount[];
}

export interface VaultFacts {
  /** The quorum members' EVM addresses, as quorum() returns them. */
  quorum: string[];
  threshold: number;
  lp: string;
  feeBps: number;
  availableWei: bigint;
  totalOwedWei: bigint;
}

/** One read of everything the page shows. A part that could not be read is undefined, with its reason in `errors`. */
export interface TrustFacts {
  readAt: number;
  height?: number;
  rollup?: RollupFacts;
  params?: RdkParamsFacts;
  gov?: GovFacts;
  circuit?: CircuitFacts;
  /** The chain's upgrade authority, and whether it is the governance module's account. */
  upgradeAuthority?: { address: string; isGov: boolean };
  vault?: VaultFacts;
  errors: Partial<Record<"status" | "rollup" | "params" | "gov" | "circuit" | "authority" | "vault", string>>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : "");
const num = (v: unknown): number | undefined => {
  const n = Number(str(v));
  return str(v) !== "" && Number.isFinite(n) ? n : undefined;
};

/** A protobuf Duration as JSON ("14400s", "0.5s") or bare seconds ("3600"), in seconds. */
export function seconds(v: unknown): number | undefined {
  const m = /^(\d+(?:\.\d+)?)s?$/.exec(str(v).trim());
  return m ? Number(m[1]) : undefined;
}

/** `GET /qorechain/rdk/v1/rollup/{id}`. */
export function parseRollup(j: unknown): RollupFacts {
  const r = obj(obj(j)["rollup"]);
  if (!str(r["rollup_id"])) throw new Error("the node returned no rollup");
  return {
    status: str(r["status"]),
    sequencing: str(r["sequencing"]),
    executionVm: str(r["execution_vm"]),
    proofSystem: str(r["proof_system"]),
    challengeWindowSec: num(r["challenge_window_sec"]),
    creator: str(r["creator"]),
    depositPoolUqor: str(r["deposit_pool"]) || "0",
    escrowUqor: str(r["escrow_balance"]) || "0",
  };
}

/** `GET /qorechain/rdk/v1/params`. */
export function parseRdkParams(j: unknown): RdkParamsFacts {
  const p = obj(obj(j)["params"]);
  const bond = str(p["min_submitter_bond"]);
  if (!/^\d+$/.test(bond)) throw new Error("the node returned no min_submitter_bond");
  return { minSubmitterBondUqor: bond, postedDataRetentionBlocks: num(p["posted_data_retention_blocks"]) };
}

/** `GET /cosmos/gov/v1/params/voting`: the newer `params` object, or the older `voting_params`. */
export function parseGovVoting(j: unknown): GovFacts {
  const o = obj(j);
  const v = seconds(obj(o["params"])["voting_period"]) ?? seconds(obj(o["voting_params"])["voting_period"]);
  if (v === undefined) throw new Error("the node returned no voting period");
  return { votingPeriodSec: v, expeditedVotingPeriodSec: seconds(obj(o["params"])["expedited_voting_period"]) };
}

const LEVELS = ["LEVEL_NONE_UNSPECIFIED", "LEVEL_SOME_MSGS", "LEVEL_ALL_MSGS", "LEVEL_SUPER_ADMIN"];

/** `GET /cosmos/circuit/v1/disable_list` and `GET /cosmos/circuit/v1/accounts`. */
export function parseCircuit(disableList: unknown, accounts: unknown): CircuitFacts {
  const disabled = obj(disableList)["disabled_list"];
  const list = obj(accounts)["accounts"];
  if (!Array.isArray(disabled) || !Array.isArray(list)) throw new Error("the node returned no circuit breaker state");
  return {
    disabled: disabled.map(str).filter(Boolean),
    accounts: list.map((a) => {
      const p = obj(obj(a)["permissions"]);
      const lvl = p["level"];
      const msgs = p["limit_type_urls"];
      return {
        address: str(obj(a)["address"]),
        level: typeof lvl === "number" ? (LEVELS[lvl] ?? String(lvl)) : str(lvl),
        msgs: Array.isArray(msgs) ? msgs.map(str) : [],
      };
    }),
  };
}

/** `GET /cosmos/upgrade/v1beta1/authority`: the account that may schedule chain upgrades. */
export const parseAuthority = (j: unknown): string => {
  const a = str(obj(j)["address"]);
  if (!a) throw new Error("the node returned no authority");
  return a;
};

/** The governance module's account: the first 20 bytes of SHA-256("gov"), as every Cosmos SDK chain derives it. */
export async function govModuleAddress(): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gov")));
  return hexToBech32(`0x${Array.from(d.subarray(0, 20), (x) => x.toString(16).padStart(2, "0")).join("")}`, "qor");
}

const RDK_MSG = "/qorechain.rdk.";

/**
 * What the circuit breaker could do to the rollup without a vote: which of the rollup module's messages are
 * switched off now, and which accounts may switch them off.
 */
export function rdkSwitches(c: CircuitFacts): { disabled: string[]; holders: CircuitAccount[] } {
  return {
    disabled: c.disabled.filter((u) => u.startsWith(RDK_MSG)),
    holders: c.accounts.filter((a) => a.level === "LEVEL_SUPER_ADMIN" || a.level === "LEVEL_ALL_MSGS" || (a.level === "LEVEL_SOME_MSGS" && a.msgs.some((u) => u.startsWith(RDK_MSG)))),
  };
}

// ------------------------------------------------------------ names

/** An EVM address as qor1, or the input if it is not one. */
export function toQor1(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  try {
    return hexToBech32(addr, "qor");
  } catch {
    return addr;
  }
}

/** A known account's name, else its short address. */
export const nameOf = (addr: string): string => KNOWN[toQor1(addr)] ?? shortAddr(addr);

const WEI_PER_UQOR = 1_000_000_000_000n;
export const qorFromWei = (wei: bigint): string => qor(wei / WEI_PER_UQOR);

const windowOf = (f: TrustFacts): number | undefined => f.rollup?.challengeWindowSec;
const bond = (f: TrustFacts): string => (f.params ? qor(f.params.minSubmitterBondUqor) : "the minimum bond");
const vote = (g: GovFacts): string => `${dur(g.votingPeriodSec)} vote${g.expeditedVotingPeriodSec !== undefined ? ` (${dur(g.expeditedVotingPeriodSec)} if expedited)` : ""}`;

// ------------------------------------------------------------ the risk rosette

export type Level = "good" | "caution" | "risk" | "unknown";

export interface Slice {
  key: "state" | "da" | "sequencer" | "proposer" | "exit";
  name: string;
  /** The short answer, in L2BEAT's words where they fit. */
  value: string;
  level: Level;
  text: string;
  refs: Ref[];
}

/** The five slices, graded by us. Where a grade depends on a live value and that value could not be read, the slice says so. */
export function rosette(f: TrustFacts): Slice[] {
  const w = windowOf(f);
  const state: Slice =
    f.rollup && w !== undefined
      ? {
          key: "state",
          name: "State validation",
          value: f.rollup.proofSystem === "fraud" ? "Fraud proofs, anyone may submit" : f.rollup.proofSystem || "unknown",
          level: f.rollup.proofSystem !== "fraud" ? "unknown" : w >= FRAMEWORK.stage1MinChallengeSec ? "good" : "caution",
          text: `Anyone may challenge a batch with a fraud proof; the chain re-executes the disputed entries and slashes a wrong batch's bond. Two challenges have been upheld on vigil-pay-1. The challenge window is ${dur(w)} as the node reports, short of the 5 days Stage 1 asks for.`,
          refs: [ev("24, 44, 55"), tm("7")],
        }
      : unread("state", "State validation", "the rollup", f.errors.rollup);
  const da: Slice = {
    key: "da",
    name: "Data availability",
    value: "Onchain: the L1 inbox",
    level: "caution",
    text: `Every L2 transaction is posted to the rollup's inbox in an L1 transaction. The chain deletes its posted-data records after ${f.params?.postedDataRetentionBlocks?.toLocaleString("en-GB") ?? "648,000"} blocks (observed); after that the bytes are read back from L1 transaction history, and a public archive of every entry, checked against commitments the chain still holds, is in the repository.`,
    refs: [ev("17, 122"), tm("10"), tm("13")],
  };
  const sequencer: Slice = f.rollup
    ? {
        key: "sequencer",
        name: "Sequencer failure",
        value: f.rollup.sequencing === "based" ? "Self sequence" : f.rollup.sequencing || "unknown",
        level: f.rollup.sequencing === "based" ? "good" : "unknown",
        text: "vigil-pay-1 is based: anyone can post to its inbox, and the order is fixed when L1 includes the post. No Vigil sequencer can drop or reorder an entry; L1 block proposers could delay one, as for any L1 transaction.",
        refs: [ev("68"), tm("5")],
      }
    : unread("sequencer", "Sequencer failure", "the rollup", f.errors.rollup);
  const proposer: Slice = {
    key: "proposer",
    name: "Proposer failure",
    value: `Self propose, with a ${bond(f)} bond`,
    level: f.params ? "good" : "unknown",
    text: `Any account that bonds ${bond(f)} may submit batches. With the creator's sequencer stopped, our standby on another key batched a user's withdrawal and it was paid on L1. Batches from anyone but the creator carry no anchor, so they have no settlement receipt.`,
    refs: [ev("65–72"), tm("7k")],
  };
  const m = exitMargin(f);
  const exit: Slice = f.gov
    ? {
        key: "exit",
        name: "Exit window",
        value: m === undefined ? "not graded" : m.normal > 0 ? `About ${dur(m.normal)}, set by L1 governance` : "None",
        level: m === undefined ? "unknown" : m.normal >= FRAMEWORK.stage1MinExitWindowSec ? "caution" : "risk",
        text:
          `Vigil's contracts have no owner and no proxy, so nothing of ours can be upgraded. The rollup's rules live in QoreChain's rollup module: governance can change them by proposal, and can pause a based rollup. That takes a ${vote(f.gov)} as the node reports.` +
          (m === undefined
            ? ""
            : ` Leaving takes about one challenge window (${dur(m.windowSec)}), so a user who acts when voting opens has about ${dur(m.normal)} to spare${m.expedited !== undefined ? `, or ${m.expedited > 0 ? `about ${dur(m.expedited)}` : "none"} if the vote is expedited` : ""}. Stage 1 asks for 7 days.`),
        refs: [tm("13")],
      }
    : unread("exit", "Exit window", "the governance parameters", f.errors.gov);
  return [state, da, sequencer, proposer, exit];
}

/**
 * How long a user has to spare between a governance vote opening and the change taking effect, after the
 * time it takes to leave (one challenge window: a withdrawal is paid on L1 only once its batch is final).
 * L2BEAT's exit window is the same idea: the delay before an upgrade, less the time an exit takes.
 */
export function exitMargin(f: TrustFacts): { windowSec: number; normal: number; expedited: number | undefined } | undefined {
  const w = windowOf(f);
  if (!f.gov || w === undefined) return undefined;
  const e = f.gov.expeditedVotingPeriodSec;
  return { windowSec: w, normal: Math.max(0, f.gov.votingPeriodSec - w), expedited: e === undefined ? undefined : Math.max(0, e - w) };
}

function unread(key: Slice["key"], name: string, what: string, error: string | undefined): Slice {
  return { key, name, value: "not read", level: "unknown", text: `The page could not read ${what} from the node${error ? ` (${error})` : ""}, so this slice is not graded.`, refs: [] };
}

// ------------------------------------------------------------ the Stages checklist

export type Status = "met" | "caveat" | "not met" | "unknown";

export interface Item {
  q: string;
  status: Status;
  text: string;
  refs: Ref[];
  /** Graded from a value read live (as opposed to the code or a recorded transaction). */
  live?: boolean;
}

export function stage0(f: TrustFacts): Item[] {
  return [
    { q: "Does the project call itself a rollup?", status: "met", text: "Yes: a qledger-v1 optimistic rollup on QoreChain.", refs: [doc("README.md")] },
    {
      q: "Are L2 state roots posted on L1?",
      status: "met",
      text: "Every batch puts its state root and withdrawals root on L1; the creator's batches also carry an ML-DSA-87 anchor.",
      refs: [ev("16, 18, 20")],
    },
    {
      q: "Does the project provide data availability on L1?",
      status: "caveat",
      text: "Yes: the inbox is on L1. The chain deletes posted-data records after 648,000 blocks, so entries older than that are read from L1 transaction history or our public archive.",
      refs: [tm("13")],
    },
    {
      q: "Is software that can reconstruct the state source-available?",
      status: "met",
      text: "Yes: the watchtower and Keel replay vigil-pay-1 from chain data and check every root against the chain (Apache-2.0). docs/ESCAPE_HATCH.md reads any balance this way.",
      refs: [tm("10"), doc("docs/ESCAPE_HATCH.md")],
    },
    { q: "Does the project use a proper proof system?", status: "met", text: "Fraud proofs that the chain itself re-executes; two have been upheld on vigil-pay-1.", refs: [ev("44, 55")] },
    {
      q: "Are there at least 5 external actors that can submit a fraud proof?",
      status: "met",
      text: "Anyone can: there is no allowlist, and our upheld challenge posted no bond, only its fee (about 0.18 QOR). Another team's watcher won our first fraud drill.",
      refs: [ev("24, 44, 55")],
    },
  ];
}

export function stage1(f: TrustFacts): Item[] {
  const w = windowOf(f);
  const m = exitMargin(f);
  return [
    w === undefined
      ? { q: "Challenge period of at least 5 days", status: "unknown", text: "The challenge window could not be read.", refs: [], live: true }
      : {
          q: "Challenge period of at least 5 days (cut from 7 days on 30 Apr 2026)",
          status: w >= FRAMEWORK.stage1MinChallengeSec ? "met" : "not met",
          text: `${dur(w)}, as the node reports. The window is set per rollup when it is created; vigil-pay-1 chose 1 hour so that a drill and its withdrawal finish within a day.`,
          refs: [ev("13")],
          live: true,
        },
    f.gov && m
      ? {
          q: "Upgrades by anyone outside a Security Council give users at least 7 days to exit",
          status: m.normal >= FRAMEWORK.stage1MinExitWindowSec ? "met" : "not met",
          text: `There is no Security Council. QoreChain governance can change the rollup module's rules after a ${vote(f.gov)}, as the node reports; less the ${dur(m.windowSec)} an exit takes, that leaves about ${dur(m.normal)}.`,
          refs: [tm("13")],
          live: true,
        }
      : { q: "Upgrades by anyone outside a Security Council give users at least 7 days to exit", status: "unknown", text: "The governance parameters could not be read.", refs: [], live: true },
    {
      q: "Only a Security Council (≥75%) can block a withdrawal indefinitely or push an invalid one",
      status: "not met",
      text: "Governance can pause a based rollup, and funds then wait for governance (QoreChain's v3.2.8 rollup documentation).",
      refs: [tm("13")],
    },
    {
      q: "The proposer set is open, so one live proposer can be assumed",
      status: f.params ? "met" : "unknown",
      text: `Any account with a ${bond(f)} bond may submit batches; a standby on another key did so on 20 Nov.`,
      refs: [ev("65–72")],
      live: true,
    },
  ];
}

export function stage2(f: TrustFacts): Item[] {
  const m = exitMargin(f);
  return [
    { q: "Is the fraud proof system permissionless?", status: "met", text: "Yes: there is no allowlist. Our watchtower's challenge and another team's watcher's were both upheld; ours posted no bond.", refs: [ev("24, 44, 55")] },
    {
      q: "Do users have at least 30 days to exit in case of unwanted upgrades?",
      status: m ? (m.normal >= FRAMEWORK.stage2MinExitWindowSec ? "met" : "not met") : "unknown",
      text: f.gov && m ? `No: a governance change can take effect after a ${vote(f.gov)}.` : "The governance parameters or the challenge window could not be read.",
      refs: [tm("13")],
      live: true,
    },
    { q: "Is the Security Council restricted to act only on errors detected on chain?", status: "not met", text: "There is no Security Council; governance is not restricted this way.", refs: [] },
  ];
}

/** What would change the Stage 1 answer, split by who would have to act. */
export const STAGE1_NEEDS: { who: string; what: string }[] = [
  {
    who: "The rollup (us)",
    what: "A challenge window of at least 5 days. The creator picks it when the rollup is created, so this means a new rollup; L1 withdrawals would then wait 5 days, which is what instant exits are for.",
  },
  {
    who: "QoreChain",
    what: "At least 7 days between a governance decision that changes the rollup module's rules for running rollups (a parameter change, a pause or a chain upgrade) and its effect, or a Security Council as the framework defines one, so users can leave first.",
  },
  {
    who: "QoreChain",
    what: "A pause of a based rollup that cannot hold withdrawals from final batches indefinitely: for example one that lets them through, or that ends on its own.",
  },
  {
    who: "QoreChain",
    what: "The same rules on mainnet, where chain v3.2.8 is not yet applied and nothing here has run.",
  },
];

// ------------------------------------------------------------ who can do what

export interface Power {
  action: string;
  who: string;
  /** How the page knows: read live from the chain or the EVM endpoint, or fixed by code or the chain's rules. */
  source: "read live" | "contract code" | "chain rule";
  refs: Ref[];
}

export function authority(f: TrustFacts): Power[] {
  const w = windowOf(f);
  const v = f.vault;
  const sw = f.circuit && rdkSwitches(f.circuit);
  return [
    { action: "Post a transfer or withdrawal", who: "Anyone with an L1 account and the fee. The inbox is on L1 and has no gatekeeper.", source: "chain rule", refs: [ev("68")] },
    {
      action: "Batch the inbox",
      who: `The creator's sequencer first. Any account that bonds ${bond(f)} may batch too; our standby does after an entry has waited 30 blocks.`,
      source: "read live",
      refs: [ev("65–72")],
    },
    {
      action: "Reject a batch",
      who: `Anyone with a valid fraud proof, within ${w !== undefined ? dur(w) : "the challenge window"} of the batch. The chain re-executes and decides.`,
      source: "read live",
      refs: [ev("44, 55")],
    },
    { action: "Finalise a batch", who: "No one acts: the chain treats a batch as final once its challenge window passes with no upheld challenge.", source: "chain rule", refs: [ev("16")] },
    {
      action: "Pay a withdrawal on L1",
      who: "Anyone, once its batch is final. The money always goes to the recipient the user's ML-DSA-44 signature names.",
      source: "chain rule",
      refs: [ev("72, 93")],
    },
    {
      action: "Pay an exit early",
      who: v
        ? `${v.threshold === v.quorum.length ? (v.quorum.length === 2 ? "Both" : `All ${v.quorum.length}`) : `${v.threshold} of ${v.quorum.length}`} quorum keys, each by an ML-DSA-87 signature: ${v.quorum.map(nameOf).join(" and ")}. Anyone may then submit the payment.`
        : `The vault's quorum (not read${f.errors.vault ? `: ${f.errors.vault}` : ""}).`,
      source: "read live",
      refs: [ev("83, 91, 104")],
    },
    {
      action: "Take liquidity out of the vault",
      who: v ? `The LP alone, by an ML-DSA-87 signature: ${nameOf(v.lp)}.` : "The vault's LP (not read).",
      source: "read live",
      refs: [ev("83")],
    },
    {
      action: "Anchor a batch (settlement receipts)",
      who: f.rollup ? `Only the rollup creator's ML-DSA-87 key: ${nameOf(f.rollup.creator)}.` : "Only the rollup creator's ML-DSA-87 key.",
      source: f.rollup ? "read live" : "chain rule",
      refs: [tm("13")],
    },
    { action: "Change Vigil's contracts", who: "No one: InstantExitVault and SettlementReceiptVerifier have no owner and no proxy.", source: "contract code", refs: [doc("contracts/src/InstantExitVault.sol", "InstantExitVault.sol")] },
    {
      action: "Change the rollup's rules, or pause it",
      who: f.gov
        ? `QoreChain governance, by proposal, after a ${vote(f.gov)}${f.upgradeAuthority?.isGov ? "; the chain's upgrade authority is the governance module's account" : f.upgradeAuthority ? `; the chain's upgrade authority is ${shortAddr(f.upgradeAuthority.address)}` : ""}, as the node reports. The creator cannot pause a based rollup.`
        : "QoreChain governance, by proposal (voting period not read). The creator cannot pause a based rollup.",
      source: "read live",
      refs: [tm("13")],
    },
    {
      action: "Switch off the rollup's messages without a vote",
      who: sw
        ? `${sw.holders.length ? `${sw.holders.map((h) => shortAddr(h.address)).join(", ")} (circuit breaker)` : "No account holds that power"}, as the node reports. ${sw.disabled.length ? `Switched off now: ${sw.disabled.join(", ")}.` : "None of the rollup module's messages is switched off."}`
        : "Not read (circuit breaker).",
      source: "read live",
      refs: [],
    },
  ];
}

// ------------------------------------------------------------ the instant-exit risk card

export interface Field {
  k: string;
  v: string;
  refs: Ref[];
}

export function exitCard(f: TrustFacts): { fields: Field[]; stolen: string[]; delayed: string[] } {
  const v = f.vault;
  const cap = v ? qorFromWei(v.availableWei) : undefined;
  return {
    fields: [
      {
        k: "Validated by",
        v: v
          ? `A ${v.threshold}-of-${v.quorum.length} committee of ML-DSA-87 keys, ${v.quorum.map(nameOf).join(" and ")}, checked by the vault through pqcVerify. One operator (our team), one hosting provider, two regions.`
          : "The vault's quorum (not read).",
        refs: [ev("83"), tm("8")],
      },
      { k: "Limits", v: `None in the contract. In practice an exit is capped by the vault's free liquidity${cap ? `: ${cap}, as the EVM endpoint reports` : ""}.`, refs: [ev("108")] },
      { k: "Fee", v: v ? `${(v.feeBps / 100).toLocaleString("en-GB")}% of the exit, kept by the vault for the LP.` : "Not read.", refs: [ev("83")] },
      {
        k: "Signer budget",
        v: "Each watchtower posts at most 12 attestations a day and keeps a 5 QOR challenge reserve. Using the budget up pauses instant exits, not withdrawals.",
        refs: [tm("12"), tm("13")],
      },
      { k: "Exercised", v: "Two exits fronted before finality and repaid after it, one by hand and one fully automatic. A small sample.", refs: [ev("91, 95, 104, 108")] },
    ],
    stolen: [
      `both quorum keys sign a false claim. The loss is the LP's liquidity${cap ? ` (${cap} now)` : ""}, never a user's withdrawal.`,
      "the LP key, which is the rollup creator's, is stolen. The thief can take the liquidity out.",
      "the quorum signs a claim for a payout that never withdrew. That payout's exit address then owes the vault, and its later withdrawals through that address repay it first.",
    ],
    delayed: [
      "the quorum or the relayer is offline, out of budget, or the vault is out of liquidity. The withdrawal is then paid in full at finality, by anyone.",
      "QoreChain governance pauses the rollup. Funds then wait for governance.",
    ],
  };
}

// ------------------------------------------------------------ the rosette's drawing

/**
 * An SVG path for slice `i` of `n` around (c, c): a ring segment from radius `inner` to `outer`, starting at
 * the top and going clockwise, with `gapDeg` left empty on each side.
 */
export function wedgePath(i: number, n: number, c: number, inner: number, outer: number, gapDeg = 2): string {
  const rad = (d: number) => ((d - 90) * Math.PI) / 180;
  const a0 = (360 / n) * i + gapDeg;
  const a1 = (360 / n) * (i + 1) - gapDeg;
  const pt = (r: number, a: number) => `${(c + r * Math.cos(rad(a))).toFixed(2)} ${(c + r * Math.sin(rad(a))).toFixed(2)}`;
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${pt(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${pt(outer, a1)} L ${pt(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, a0)} Z`;
}
