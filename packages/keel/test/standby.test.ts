import { describe, expect, it } from "vitest";
import { parseStandbyBlocks, standbyDecision } from "../src/standby.ts";

describe("standby", () => {
  it("does nothing while the inbox is empty", () => {
    expect(standbyDecision({ tipHeight: 1_000, oldestWaitingHeight: undefined, standbyBlocks: 30 })).toEqual({ due: false, waited: 0 });
  });

  it("leaves a fresh entry to the primary", () => {
    expect(standbyDecision({ tipHeight: 1_010, oldestWaitingHeight: 1_000, standbyBlocks: 30 })).toEqual({ due: false, waited: 10 });
    expect(standbyDecision({ tipHeight: 1_029, oldestWaitingHeight: 1_000, standbyBlocks: 30 }).due).toBe(false);
  });

  it("takes over once the oldest entry has waited the full margin", () => {
    expect(standbyDecision({ tipHeight: 1_030, oldestWaitingHeight: 1_000, standbyBlocks: 30 })).toEqual({ due: true, waited: 30 });
    expect(standbyDecision({ tipHeight: 5_000, oldestWaitingHeight: 1_000, standbyBlocks: 30 }).due).toBe(true);
  });

  it("never counts a negative wait (a node behind the post)", () => {
    expect(standbyDecision({ tipHeight: 990, oldestWaitingHeight: 1_000, standbyBlocks: 1 })).toEqual({ due: false, waited: 0 });
  });

  it("refuses a margin that is not a positive whole number", () => {
    expect(() => standbyDecision({ tipHeight: 1, oldestWaitingHeight: 0, standbyBlocks: 0 })).toThrow();
    expect(() => standbyDecision({ tipHeight: 1, oldestWaitingHeight: 0, standbyBlocks: 1.5 })).toThrow();
  });

  it("parses the setting: unset or 0 means primary", () => {
    expect(parseStandbyBlocks(undefined)).toBeUndefined();
    expect(parseStandbyBlocks("")).toBeUndefined();
    expect(parseStandbyBlocks("0")).toBeUndefined();
    expect(parseStandbyBlocks("30")).toBe(30);
    expect(() => parseStandbyBlocks("-3")).toThrow();
    expect(() => parseStandbyBlocks("2.5")).toThrow();
    expect(() => parseStandbyBlocks("soon")).toThrow();
  });
});
