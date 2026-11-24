/**
 * Is this pasted JSON a settlement receipt at all? Checked before anything is verified or shown, so a
 * data receipt, a summary file or `null` gets a plain answer instead of a broken page.
 */
import { receiptSchemaError, type SettlementReceipt } from "@qorechain/rdk";

const HEX = /^[0-9a-fA-F]*$/;
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isHex = (v: unknown, bytes?: number): v is string => typeof v === "string" && HEX.test(v.replace(/^0x/, "")) && (bytes === undefined || v.replace(/^0x/, "").length === 2 * bytes);

/** Why `x` is not a settlement receipt this page can verify, or undefined if it has the right shape. */
export function receiptProblem(x: unknown): string | undefined {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return "That is JSON, but not a receipt: a settlement receipt is a JSON object.";
  const r = x as Record<string, unknown>;
  if (r["kind"] === "vigil/data-receipt") {
    return "That is a data receipt (proof that one inbox entry sits in a batch), not a settlement receipt. The Open a payslip page builds and checks data receipts for the sealed envelopes in the inbox.";
  }
  if (Array.isArray(r["summary"])) return "That is a receipts summary file, not a receipt. Paste one of the batch-N.json files instead.";
  // The RDK's own schema check (version, algorithm, the version-2 fields).
  let schema: string | undefined;
  try {
    schema = receiptSchemaError(r as unknown as SettlementReceipt);
  } catch (e) {
    schema = e instanceof Error ? e.message : String(e);
  }
  if (schema) return `Not a receipt this page can verify: ${schema}.`;
  for (const f of ["rollupId", "layerId", "creator"] as const) {
    if (typeof r[f] !== "string" || r[f] === "") return `Not a settlement receipt: "${f}" is missing.`;
  }
  for (const f of ["batchIndex", "layerHeight", "mainChainHeight", "anchoredAt"] as const) {
    if (!isUint(r[f])) return `Not a settlement receipt: "${f}" must be a whole number.`;
  }
  if (!isHex(r["stateRoot"], 32)) return 'Not a settlement receipt: "stateRoot" must be 32 bytes of hex.';
  if (!isHex(r["batchStateRoot"], 32)) return 'Not a settlement receipt: "batchStateRoot" must be 32 bytes of hex.';
  if (!isHex(r["pqcSignature"]) || r["pqcSignature"] === "") return 'Not a settlement receipt: "pqcSignature" must be hex.';
  if (typeof r["validatorSetHash"] !== "string") return 'Not a settlement receipt: "validatorSetHash" is missing.';
  if (r["transactionCount"] !== undefined && !isUint(r["transactionCount"])) return 'Not a settlement receipt: "transactionCount" must be a whole number.';
  if (r["compressedStateProof"] !== undefined && typeof r["compressedStateProof"] !== "string") return 'Not a settlement receipt: "compressedStateProof" must be a string.';
  return undefined;
}

/** Parse pasted text into a receipt, or say why it is not one. */
export function parseReceipt(text: string): { ok: true; receipt: SettlementReceipt } | { ok: false; error: string } {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `That is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const problem = receiptProblem(x);
  return problem ? { ok: false, error: problem } : { ok: true, receipt: x as SettlementReceipt };
}
