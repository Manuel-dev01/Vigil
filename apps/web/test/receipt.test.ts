/** What the Verify page accepts as a settlement receipt before verifying anything. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReceipt, receiptProblem } from "../src/receipt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "..", "..", "receipts", "vigil-pay-1");
const read = (f: string): string => readFileSync(join(dir, f), "utf8");

describe("receipt schema gate", () => {
  it("passes every snapshot receipt in receipts/vigil-pay-1", () => {
    const files = readdirSync(dir).filter((f) => /^batch-\d+\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(receiptProblem(JSON.parse(read(f))), f).toBeUndefined();
  });

  it("names a data receipt (data-6.json) for what it is", () => {
    const r = parseReceipt(read("data-6.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/data receipt/);
  });

  it("refuses summary.json", () => {
    const r = parseReceipt(read("summary.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/summary/);
  });

  it("refuses null, arrays, numbers and broken JSON without throwing", () => {
    for (const text of ["null", "[]", "42", '"x"', "{", "{}"]) {
      const r = parseReceipt(text);
      expect(r.ok, text).toBe(false);
    }
  });

  it("refuses a receipt with a missing or malformed field", () => {
    const good = JSON.parse(read("batch-0.json")) as Record<string, unknown>;
    expect(receiptProblem({ ...good, stateRoot: undefined })).toMatch(/stateRoot/);
    expect(receiptProblem({ ...good, stateRoot: "xyz" })).toMatch(/stateRoot/);
    expect(receiptProblem({ ...good, batchIndex: -1 })).toMatch(/batchIndex/);
    expect(receiptProblem({ ...good, layerHeight: 2 ** 64 })).toMatch(/layerHeight/);
    expect(receiptProblem({ ...good, algorithm: "ed25519" })).toMatch(/algorithm/);
    expect(receiptProblem({ ...good, version: 9 })).toMatch(/version/);
  });
});
