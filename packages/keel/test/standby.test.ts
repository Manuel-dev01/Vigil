import { describe, expect, it } from "vitest";
import { oldestWaitingSequence, parseStandbyBlocks, standbyDecision } from "../src/standby.ts";

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

  it("measures the wait from the next entry, not the last batched one (posted data is numbered from 1)", () => {
    // vigil-pay-1 on 20 Nov: consumed_sequence 12; posted_data/12 was batched the day before
    // (height 10,393,102), and the waiting entry was posted_data/13 (height 10,433,589).
    expect(oldestWaitingSequence(12)).toBe(13);
    expect(oldestWaitingSequence(0)).toBe(1);
    expect(standbyDecision({ tipHeight: 10_433_593, oldestWaitingHeight: 10_433_589, standbyBlocks: 30 }).due).toBe(false);
  });
});

import { pickPulseSender } from "../src/pulse.ts";

describe("keep-alive pulse", () => {
  it("sends from whichever L2 account holds more, so neither drains", () => {
    expect(pickPulseSender(100_000n, 260_000n, 10_000n)).toBe("b");
    expect(pickPulseSender(260_000n, 100_000n, 10_000n)).toBe("a");
    expect(pickPulseSender(50_000n, 50_000n, 10_000n)).toBe("a");
  });
  it("refuses when neither account can pay", () => {
    expect(pickPulseSender(9_999n, 5n, 10_000n)).toBeUndefined();
    expect(pickPulseSender(9_999n, 10_000n, 10_000n)).toBe("b");
  });
});
