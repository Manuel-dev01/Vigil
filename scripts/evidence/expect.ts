/**
 * What each numbered EVIDENCE row says its transaction did, written as checks the chain can answer.
 *
 * Every row is also checked for the generic facts (the transaction exists, its height and date, and
 * that it succeeded, or failed with the code the row records). The table below adds what the row's
 * "What it proves" text claims and a transaction can show: the events the chain emitted and their
 * attributes, EVM logs, gas and fees. Values come from the row text or, for a step in a sequence,
 * from the rows around it (the exit row 91 fronts is the one rows 86 and 87 post and batch). A value
 * written `abcd1234…wxyz` is matched as the ledger abbreviates it (same start and end); `null` means
 * the attribute must be absent (an unscoped EVM window has no `allowed_targets`).
 *
 * A row the table does not list gets the generic checks only, and the report says so. Claims that
 * need chain state rather than the transaction (balances, bonds today, anchors, contract records)
 * are not checked here: each row's "How to re-verify" column has the command.
 */

export type AttrValue = string | null;

export interface EventClaim {
  type: string;
  attrs?: Record<string, AttrValue>;
  /** The row says this event is NOT there (e.g. a standby's batch is unanchored). */
  absent?: true;
}

export type LogName = "Attested" | "Fronted" | "Settled" | "Probe";

export interface LogClaim {
  event: LogName;
  address: string;
  /** Decoded arguments that must match (bigint for integers, lower-case hex for bytes and addresses). */
  args?: Record<string, bigint | string>;
  /** A check that does not fit `args`, with the words the report prints for it. */
  test?: { says: string; ok: (args: Record<string, unknown>) => boolean };
}

export interface RowExpect {
  /** The row records a failed transaction: its ABCI code and codespace, and words from its log. */
  failure?: { code: number; codespace: string; rawLog?: string };
  /** Native: the transaction's message types in order (the part after the last dot). */
  msgs?: string[];
  events?: EventClaim[];
  gasUsed?: number;
  gasWanted?: number;
  /** Native: the fee paid, in uqor. */
  feeUqor?: number;
  /** EVM: the address a deployment created. */
  contract?: string;
  /** EVM: the sender. */
  from?: string;
  logs?: LogClaim[];
}

// Accounts and contracts, as EVIDENCE.md and the README name them.
const CREATOR = "qor1z6m6kshavs5zjvd3tz0nu9tjpde5p7w83mj90s";
const DRILL_PREPARED = "qor1naj0qh80tjhfufdvpmg5szd7dmnsg5j88tagaq";
const FIRST_DEPLOYER = "qor1r0zkpgngnrc30qtskf2l5ewv0v9kqwjwn5m6yv";
const PQGUARD_VAULT_QOR = "qor1gzmtjrtfkjnwyfm4s0lhmxy39spj24v3za82j6";
const WT1 = "qor1s7t0tq7n6a3m6kp4qkannfd7s04wyuh8hjkh6m";
const WT2 = "qor1y6z2767n0uhann4q9dvdzujad8euj2x2z6z6yd";
const WT3 = "qor1z0mxtgun49kfwfsx4naww4m4g3paew50v3lp33";
const EMPLOYER1 = "qor1r74gzxy9u495j0jz9xl2gf69uy2gwxfa7l5pws";
const EMPLOYEE1 = "qor1caz97rcllrw3q4agg8rp69mfve9ar6tygzczry";
const AUDITOR1 = "qor1u7tkkkd56h27lcl3qgzzcavaukuj74mjvxqf9d";
const EVIL1 = "qor1kgvdpmv87386eyp7k577r55ttx9tf5m77jwygk";
const EVIL2 = "qor1fvrd7gscnq6xkmrcrdm4gzzwnv4f3lfk0ummn2";
const OTHER_TEAMS_WATCHER = "qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5";
const EVM_DEPLOYER = "qor1qdf0xu8fvmp0uchhhdfcx7mq893h65jk8yfcp6";
const KEEL_B = "qor1qwker9qw2l4jpsudwkkkcrwnc9a29xpvw36gft";
const KEEPALIVE = "qor12t0u9hrz2qnfmkrpp3k5u3s9mghsz9vdwkjd6l";
const RELAYER = "qor1vwqwy8nqj060e8ufdze7qlnsq7lsjaxsfhf8hn";
const EXIT_ADDRESS = "qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy";
const VAULT_QOR = "qor182yhsq4k9vzj5yp02hszr0zxdpfec2d4nhyfj6";
const OOJAE_QOREX = "qor10w42…k6k";
const OOJAE_QOREX_EVM = "0x7baaa4638c10dfb64d6ae593c2f019782e7773e3";

const VERIFIER = "0xc87c7680b70e21464aac4e2308a9caa5324e4590";
const VAULT = "0x3a897802b62b052a102f55e021bc4668539c29b5";
const PQGUARD_VAULT = "0x40b6b90d69b4a6e2277583ff7d98912c03255591";
const BLOCKHASH_PROBE = "0x2d484549b2f05c2867c8f7051951b569dab79ca6";
const RELAYER_EVM = "0x6380e21e6093f4fc9f8968b3e07e7007bf0974d0";

const ROLLUP = "vigil-pay-1";
/** 1 uqor in wei: QOR has 6 decimals natively and 18 in the EVM. */
const WEI_PER_UQOR = 10n ** 12n;

// ------------------------------------------------------------------ shorthands

/** Hybrid-signed (secp256k1 + ML-DSA-87), optionally by a named account. */
const hybrid = (address?: string): EventClaim => ({
  type: "pqc_hybrid_verify",
  attrs: { status: "verified", ...(address ? { address } : {}) },
});
/** Signed by a named account (the account the chain's PQ check ran for). */
const signer = (address: string): EventClaim => ({ type: "pqc_hybrid_verify", attrs: { address } });
const classicalBootstrap = (address: string): EventClaim => ({ type: "pqc_hybrid_classical_only", attrs: { address } });
const keyRegistered = (address: string, extra: Record<string, string> = {}): EventClaim => ({
  type: "pqc_key_registered",
  attrs: { address, ...extra },
});
const kemRegistered = (address: string): EventClaim => ({
  type: "pqc_kem_key_registered",
  attrs: { address, algorithm_id: "mlkem1024" },
});
const send = (recipient: string, amount: string, sender?: string): EventClaim => ({
  type: "transfer",
  attrs: { recipient, amount, ...(sender ? { sender } : {}) },
});
const posted = (sequence: number, extra: Record<string, string> = {}): EventClaim => ({
  type: "rdk_data_posted",
  attrs: { rollup_id: ROLLUP, sequence: String(sequence), ...extra },
});
const batch = (index: number): EventClaim => ({
  type: "batch_submitted",
  attrs: { rollup_id: ROLLUP, batch_index: String(index) },
});
const consumed = (batchIndex: number, start: number, end: number): EventClaim => ({
  type: "rdk_inbox_consumed",
  attrs: { rollup_id: ROLLUP, batch_index: String(batchIndex), inbox_start: String(start), inbox_end: String(end) },
});
/** Anchored in the same transaction by the creator's ML-DSA-87 signature. */
const anchored = (layerHeight: number, stateRoot?: string): EventClaim => ({
  type: "state_anchored",
  attrs: { layer_id: ROLLUP, layer_height: String(layerHeight), pqc_verified: "true", ...(stateRoot ? { state_root: stateRoot } : {}) },
});
/** The state root the chain reports for a layer height, where the row gives a root but does not say "anchored". */
const rootAt = (layerHeight: number, stateRoot: string): EventClaim => ({
  type: "state_anchored",
  attrs: { layer_id: ROLLUP, layer_height: String(layerHeight), state_root: stateRoot },
});
const bonded = (submitter: string): EventClaim => ({
  type: "rdk_submitter_bonded",
  attrs: { rollup_id: ROLLUP, submitter, bond: "1000000000uqor" },
});
const withdrawal = (batchIndex: number, recipient: string, amount: string, index?: number): EventClaim => ({
  type: "rdk_withdrawal_executed",
  attrs: {
    rollup_id: ROLLUP,
    batch_index: String(batchIndex),
    recipient,
    amount,
    ...(index !== undefined ? { withdrawal_index: String(index) } : {}),
  },
});
/** An EVM window. `blocks` is the row's stated length, so the expiry is the row's height plus it. */
const windowOpened = (
  address: string,
  o: { height?: number; blocks?: number; maxTxs?: number; maxValueUqor?: number; target?: string | null },
): EventClaim => ({
  type: "pqc_evm_window_opened",
  attrs: {
    address,
    ...(o.height !== undefined && o.blocks !== undefined ? { expiry_height: String(o.height + o.blocks) } : {}),
    ...(o.maxTxs !== undefined ? { max_txs: String(o.maxTxs) } : {}),
    ...(o.maxValueUqor !== undefined ? { max_value: String(o.maxValueUqor) } : {}),
    ...(o.target !== undefined ? { allowed_targets: o.target } : {}),
  },
});
const windowClosed = (address: string): EventClaim => ({ type: "pqc_evm_window_closed", attrs: { address } });
const fraudUpheld = (batchIndex: number, submitter: string, challenger: string): EventClaim[] => [
  {
    type: "rdk_fraud_upheld",
    attrs: {
      rollup_id: ROLLUP,
      batch_index: String(batchIndex),
      submitter,
      challenger,
      slashed: "1000000000uqor",
      challenger_reward: "500000000uqor",
      burned: "500000000uqor",
    },
  },
  { type: "burn", attrs: { source: "rollup_slash", amount: "500000000" } },
];
const attested = (layerHeight: number, stateRoot?: string): LogClaim => ({
  event: "Attested",
  address: VERIFIER,
  args: { layerHeight: BigInt(layerHeight), ...(stateRoot ? { stateRoot } : {}) },
});
const attestedRange = (from: number, to: number): LogClaim[] =>
  Array.from({ length: to - from + 1 }, (_, i) => attested(from + i));

// ------------------------------------------------------------------ the rows

export const EXPECT: Record<number, RowExpect> = {
  1: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(DRILL_PREPARED, { key_type: "hybrid" }), classicalBootstrap(DRILL_PREPARED)] },
  2: { msgs: ["MsgSend"], failure: { code: 10, codespace: "sdk", rawLog: "invalid coins" } },
  3: {
    msgs: ["MsgSend"],
    events: [hybrid(DRILL_PREPARED), send(FIRST_DEPLOYER, "500000000erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA,26000000uqor", DRILL_PREPARED)],
  },
  4: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(FIRST_DEPLOYER)] },
  5: { msgs: ["MsgOpenEVMWindow"], events: [windowOpened(FIRST_DEPLOYER, { height: 10_241_808, blocks: 120, maxTxs: 1, maxValueUqor: 250_000, target: null })] },
  6: { contract: PQGUARD_VAULT, gasUsed: 683_341 },
  7: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(FIRST_DEPLOYER)] },
  8: { msgs: ["MsgSend"], events: [send(PQGUARD_VAULT_QOR, "500000000erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA,25000000uqor")] },
  9: { msgs: ["MsgConvertCoin"], failure: { code: 12, codespace: "erc20", rawLog: "failed to retrieve balance: EVM call unexpected error" } },
  10: { msgs: ["MsgSend"], events: [hybrid(DRILL_PREPARED), send(DRILL_PREPARED, "100000uqor", DRILL_PREPARED)] },
  11: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(CREATOR)] },
  12: { events: [hybrid(CREATOR)] },
  13: {
    msgs: ["MsgCreateRollup"],
    feeUqor: 91_616,
    events: [
      hybrid(CREATOR),
      { type: "rollup_created", attrs: { rollup_id: ROLLUP, creator: CREATOR, profile: "nft", settlement_mode: "optimistic" } },
      { type: "rdk_sequencing_set", attrs: { rollup_id: ROLLUP, sequencing: "based" } },
      { type: "transfer", attrs: { sender: CREATOR, amount: "10000000000uqor" } },
      { type: "burn", attrs: { source: "rollup_create", amount: "100000000" } },
      { type: "transfer", attrs: { sender: CREATOR, amount: "1000000000uqor" } },
      { type: "sidechain_registered", attrs: { layer_id: ROLLUP, creator: CREATOR, status: "proposed" } },
    ],
  },
  14: { msgs: ["MsgBondRollupSubmitter"], feeUqor: 41_577, events: [hybrid(CREATOR), bonded(CREATOR)] },
  15: {
    msgs: ["MsgDepositToRollup"],
    feeUqor: 54_185,
    events: [
      hybrid(CREATOR),
      { type: "rdk_rollup_deposit", attrs: { rollup_id: ROLLUP, depositor: CREATOR, account: "6b6c0bea…c70e", amount: "1000000uqor", sequence: "1" } },
    ],
  },
  16: { msgs: ["MsgSubmitBatch"], events: [batch(0), consumed(0, 0, 1), anchored(0, "27cc2491…959e")] },
  17: { msgs: ["MsgPostRollupData"], events: [hybrid(CREATOR), posted(2, { size: "3783", poster: CREATOR })] },
  18: { msgs: ["MsgSubmitBatch"], events: [batch(1), anchored(1, "2930bd63…caa8")] },
  19: { msgs: ["MsgPostRollupData"], events: [posted(3)] },
  20: { msgs: ["MsgSubmitBatch"], events: [batch(2), anchored(2, "c818db2b…5c6e")] },
  21: { msgs: ["MsgExecuteWithdrawal"], events: [withdrawal(2, CREATOR, "250000uqor")] },
  22: { msgs: ["MsgPostRollupData"], events: [hybrid(CREATOR), posted(4, { size: "3783", poster: CREATOR })] },
  23: { msgs: ["MsgSubmitBatch"], events: [hybrid(), batch(3), anchored(3, "08984124…c384")] },
  24: { msgs: ["MsgSend"], events: [hybrid(), send(WT1, "5000000uqor")] },
  25: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(WT1)] },
  26: { msgs: ["MsgSend"], events: [hybrid(CREATOR), send(WT2, "5000000uqor", CREATOR)] },
  27: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(WT2)] },
  28: {
    msgs: ["MsgSend", "MsgSend", "MsgSend"],
    events: [hybrid(CREATOR), send(EMPLOYER1, "1000000uqor", CREATOR), send(EMPLOYEE1, "1000000uqor", CREATOR), send(AUDITOR1, "1000000uqor", CREATOR)],
  },
  29: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(EMPLOYER1)] },
  30: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(EMPLOYEE1)] },
  31: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(AUDITOR1)] },
  32: { msgs: ["MsgRegisterKEMKey"], events: [hybrid(EMPLOYER1), kemRegistered(EMPLOYER1)] },
  33: { msgs: ["MsgRegisterKEMKey"], events: [kemRegistered(EMPLOYEE1)] },
  34: { msgs: ["MsgRegisterKEMKey"], events: [kemRegistered(AUDITOR1)] },
  35: { msgs: ["MsgPostRollupData"], events: [posted(5, { data_hash: "84eeba7e…6a65" })] },
  36: { msgs: ["MsgSubmitBatch"], events: [batch(4), anchored(4, "778c8a0f…d561")] },
  37: { msgs: ["MsgPostRollupData"], events: [posted(6, { size: "5822", poster: EMPLOYER1, data_hash: "44bc6d02…1077" })] },
  38: { msgs: ["MsgSubmitBatch"], events: [batch(5), rootAt(5, "778c8a0f…d561")] },
  39: { msgs: ["MsgSend"], events: [send(EVIL1, "1005000000uqor", OOJAE_QOREX)] },
  40: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(EVIL1)] },
  41: { msgs: ["MsgBondRollupSubmitter"], events: [bonded(EVIL1)] },
  42: { msgs: ["MsgPostRollupData"], events: [posted(7, { size: "52", poster: EVIL1 })] },
  43: { msgs: ["MsgSubmitBatch"], events: [batch(6), consumed(6, 6, 7)] },
  44: {
    msgs: ["MsgChallengeBatch"],
    events: [...fraudUpheld(6, EVIL1, OTHER_TEAMS_WATCHER), { type: "rdk_inbox_rolled_back", attrs: { rollup_id: ROLLUP, consumed_sequence: "6" } }],
  },
  45: {
    msgs: ["MsgChallengeBatch"],
    failure: { code: 9, codespace: "rdk", rawLog: "batch 6 is rejected: batch already finalized" },
    events: [signer(WT1)],
  },
  46: { msgs: ["MsgSend", "MsgSend"], events: [hybrid(CREATOR), send(WT3, "10000000uqor", CREATOR), send(WT2, "10000000uqor", CREATOR)] },
  47: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(WT3)] },
  48: { msgs: ["MsgSend"], events: [send(EVIL2, "1005000000uqor", OOJAE_QOREX)] },
  49: { msgs: ["MsgPostRollupData"], events: [posted(8, { poster: CREATOR })] },
  50: { msgs: ["MsgSubmitBatch"], events: [batch(7), rootAt(7, "2c891f7a…c663")] },
  51: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(EVIL2)] },
  52: { msgs: ["MsgBondRollupSubmitter"], events: [bonded(EVIL2)] },
  53: { msgs: ["MsgPostRollupData"], events: [posted(9, { size: "52", poster: EVIL2 })] },
  54: { msgs: ["MsgSubmitBatch"], events: [batch(8), consumed(8, 8, 9)] },
  55: {
    msgs: ["MsgChallengeBatch"],
    gasUsed: 345_265,
    gasWanted: 605_960,
    events: [hybrid(WT2), ...fraudUpheld(8, EVIL2, WT2), { type: "rdk_inbox_rolled_back", attrs: { rollup_id: ROLLUP, consumed_sequence: "8" } }],
  },
  56: { msgs: ["MsgSubmitBatch"], events: [batch(8), consumed(8, 8, 9), rootAt(8, "2c891f7a…")] },
  57: { msgs: ["MsgSend"], events: [hybrid(CREATOR), send(EVM_DEPLOYER, "3000000uqor", CREATOR)] },
  58: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(EVM_DEPLOYER)] },
  59: {
    msgs: ["MsgOpenEVMWindow"],
    events: [hybrid(EVM_DEPLOYER), windowOpened(EVM_DEPLOYER, { height: 10_400_739, blocks: 600, maxTxs: 6, maxValueUqor: 1_500_000, target: null })],
  },
  60: { contract: VERIFIER, gasUsed: 1_133_962 },
  61: {
    contract: BLOCKHASH_PROBE,
    logs: [
      {
        event: "Probe",
        address: BLOCKHASH_PROBE,
        test: {
          says: "BLOCKHASH is zero at depths 1, 2, 10, 100, 256 and 257, and the EIP-2935 call returns empty data",
          ok: (a) => {
            const depths = (a["depths"] as bigint[]).map(Number);
            const hashes = a["hashes"] as string[];
            const zero = (h: string | undefined) => h !== undefined && /^0x0{64}$/.test(h);
            return [1, 2, 10, 100, 256, 257].every((d) => zero(hashes[depths.indexOf(d)])) && a["historyReturn"] === "0x";
          },
        },
      },
    ],
  },
  62: { gasUsed: 279_928, logs: [attested(0, "0x27cc24911b144e354f0154d22fbf5a9a2143655cc9763e90614b2aba6761959e")] },
  63: { gasUsed: 2_305_444, logs: attestedRange(1, 10) },
  64: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(EVM_DEPLOYER)] },
  65: { msgs: ["MsgSend"], events: [hybrid(), send(KEEL_B, "1010000000uqor", OOJAE_QOREX)] },
  66: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(KEEL_B)] },
  67: { msgs: ["MsgBondRollupSubmitter"], events: [bonded(KEEL_B)] },
  68: { msgs: ["MsgPostRollupData"], events: [posted(13, { poster: EMPLOYEE1 })] },
  69: {
    msgs: ["MsgSubmitBatch"],
    events: [signer(KEEL_B), batch(11), consumed(11, 12, 13), { type: "state_anchored", absent: true }],
  },
  70: { msgs: ["MsgPostRollupData"], events: [posted(14)] },
  71: { msgs: ["MsgSubmitBatch"], events: [batch(12), anchored(12)] },
  72: { msgs: ["MsgExecuteWithdrawal"], events: [hybrid(KEEL_B), withdrawal(11, OOJAE_QOREX, "100000uqor", 2)] },
  73: { msgs: ["MsgSend"], events: [hybrid(CREATOR), send(KEEPALIVE, "3000000uqor", CREATOR)] },
  74: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(KEEPALIVE, { key_type: "hybrid" }), classicalBootstrap(KEEPALIVE)] },
  75: { msgs: ["MsgPostRollupData"], events: [hybrid(KEEPALIVE), posted(15, { poster: KEEPALIVE })] },
  76: { msgs: ["MsgSubmitBatch"], events: [signer(CREATOR), batch(13), anchored(13)] },
  77: { msgs: ["MsgPostRollupData"], events: [hybrid(KEEPALIVE), posted(16, { poster: KEEPALIVE })] },
  78: { msgs: ["MsgSubmitBatch"], events: [signer(CREATOR), batch(14), anchored(14)] },
  79: {
    msgs: ["MsgOpenEVMWindow"],
    events: [hybrid(EVM_DEPLOYER), windowOpened(EVM_DEPLOYER, { height: 10_627_884, blocks: 200, maxTxs: 2, maxValueUqor: 250_000, target: VERIFIER })],
  },
  80: { gasUsed: 712_745, logs: [attested(12), attested(13), attested(14, "0x9a3e20ba101649bcf52cefa56577cb86d8acec74c4ce8558d56623e47e36fe07")] },
  81: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(EVM_DEPLOYER)] },
  82: {
    msgs: ["MsgOpenEVMWindow"],
    events: [windowOpened(EVM_DEPLOYER, { height: 10_629_378, blocks: 300, maxTxs: 2, maxValueUqor: 800_000, target: null })],
  },
  83: { contract: VAULT, gasUsed: 1_960_643 },
  84: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(EVM_DEPLOYER)] },
  85: { msgs: ["MsgSend"], events: [hybrid(CREATOR), send(VAULT_QOR, "1000000uqor", CREATOR)] },
  86: { msgs: ["MsgPostRollupData"], events: [posted(17)] },
  87: { msgs: ["MsgSubmitBatch"], events: [batch(15), anchored(15)] },
  88: { msgs: ["MsgPostRollupData"], events: [posted(18, { size: "4781", poster: WT3 })] },
  89: { msgs: ["MsgPostRollupData"], events: [posted(19, { poster: WT2 })] },
  90: { msgs: ["MsgOpenEVMWindow"], events: [windowOpened(EVM_DEPLOYER, { target: VAULT })] },
  91: {
    gasUsed: 472_141,
    logs: [{ event: "Fronted", address: VAULT, args: { payout: OOJAE_QOREX_EVM, batchIndex: 15n, withdrawalIndex: 3n, paid: 99_500n * WEI_PER_UQOR } }],
  },
  92: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(EVM_DEPLOYER)] },
  93: { msgs: ["MsgExecuteWithdrawal"], events: [hybrid(KEEPALIVE), withdrawal(15, EXIT_ADDRESS, "100000uqor", 3)] },
  94: { msgs: ["MsgOpenEVMWindow"], events: [windowOpened(EVM_DEPLOYER, { target: VAULT })] },
  95: {
    gasUsed: 226_361,
    logs: [{ event: "Settled", address: VAULT, args: { payout: OOJAE_QOREX_EVM, repaid: 100_000n * WEI_PER_UQOR, stillOwed: 0n } }],
  },
  96: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(EVM_DEPLOYER)] },
  97: { msgs: ["MsgSend"], events: [hybrid(CREATOR), send(RELAYER, "3000000uqor", CREATOR)] },
  98: { msgs: ["MsgRegisterPQCKeyV2"], events: [keyRegistered(RELAYER, { key_type: "hybrid" }), classicalBootstrap(RELAYER)] },
  99: { msgs: ["MsgPostRollupData"], events: [hybrid(KEEPALIVE), posted(20, { poster: KEEPALIVE })] },
  100: { msgs: ["MsgSubmitBatch"], events: [batch(18), anchored(18)] },
  101: { msgs: ["MsgPostRollupData"], events: [posted(21, { poster: WT3 })] },
  102: { msgs: ["MsgPostRollupData"], events: [posted(22, { poster: WT2 })] },
  103: {
    msgs: ["MsgOpenEVMWindow"],
    events: [windowOpened(RELAYER, { height: 10_686_382, blocks: 150, maxTxs: 1, maxValueUqor: 69_379, target: VAULT })],
  },
  104: {
    from: RELAYER_EVM,
    gasUsed: 472_177,
    logs: [{ event: "Fronted", address: VAULT, args: { payout: OOJAE_QOREX_EVM, batchIndex: 18n, withdrawalIndex: 4n, paid: 99_500n * WEI_PER_UQOR } }],
  },
  105: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(RELAYER)] },
  106: { msgs: ["MsgExecuteWithdrawal"], events: [hybrid(RELAYER), withdrawal(18, EXIT_ADDRESS, "100000uqor", 4)] },
  107: { msgs: ["MsgOpenEVMWindow"], events: [windowOpened(RELAYER, { maxTxs: 1, maxValueUqor: 7_190, target: VAULT })] },
  108: {
    from: RELAYER_EVM,
    gasUsed: 39_233,
    logs: [{ event: "Settled", address: VAULT, args: { payout: OOJAE_QOREX_EVM, repaid: 100_000n * WEI_PER_UQOR, stillOwed: 0n } }],
  },
  109: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(RELAYER)] },
  110: { msgs: ["MsgCloseEVMWindow"], events: [signer(EVM_DEPLOYER)] },
  111: {
    msgs: ["MsgOpenEVMWindow"],
    events: [windowOpened(EVM_DEPLOYER, { height: 10_691_040, blocks: 200, maxTxs: 2, maxValueUqor: 250_000, target: VERIFIER })],
  },
  112: { gasUsed: 1_163_793, logs: attestedRange(15, 19) },
  113: { msgs: ["MsgCloseEVMWindow"], events: [windowClosed(EVM_DEPLOYER)] },
  114: { msgs: ["MsgPostRollupData"], events: [hybrid(EMPLOYER1), posted(23, { poster: EMPLOYER1, data_hash: "0854763a…a9a1" })] },
  115: { msgs: ["MsgPostRollupData"], events: [posted(24, { size: "5905", poster: EMPLOYER1 })] },
  116: {
    msgs: ["MsgChallengeBatch"],
    feeUqor: 240_358,
    failure: { code: 9, codespace: "rdk", rawLog: "batch 6 is rejected: batch already finalized" },
    events: [signer(WT2)],
  },
  117: { msgs: ["MsgSubmitBatch"], events: [batch(21), anchored(21)] },
  118: { msgs: ["MsgPostRollupData"], feeUqor: 73_480, events: [hybrid(KEEPALIVE), { type: "rdk_data_posted", attrs: { rollup_id: ROLLUP, poster: KEEPALIVE } }] },
  119: { msgs: ["MsgSubmitBatch"], events: [batch(22), anchored(22)] },
  120: { msgs: ["MsgSend"], events: [hybrid(CREATOR), send(EMPLOYER1, "2000000uqor", CREATOR)] },
  121: { msgs: ["MsgPostRollupData"], events: [hybrid(EMPLOYER1), posted(26, { poster: EMPLOYER1, data_hash: "c0266bd1…1ba3" })] },
  122: { msgs: ["MsgPostRollupData"], events: [posted(27, { size: "5901", poster: EMPLOYER1, data_hash: "45a27668…cc1e" })] },
  123: { msgs: ["MsgSubmitBatch"], events: [batch(24), consumed(24, 26, 27), anchored(24)] },
};
