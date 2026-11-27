/**
 * The evidence check, offline: parsing EVIDENCE.md, judging recorded chain answers
 * (test/vectors/evidence-check-answers.json), catching tampered answers, and the throttled reader.
 * No network: the reader is driven by a fake fetch and a fake clock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, encodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { EVENTS_ABI, judgeRow, matchesAbbrev } from "../evidence/check.ts";
import { EXPECT } from "../evidence/expect.ts";
import { ChainReader, MIN_GAP_MS, type Fetched } from "../evidence/fetch.ts";
import { parseLedger, type TxRow } from "../evidence/ledger.ts";
import { buildReport, commandsOf, ranges, readOnlyResults, toMarkdown } from "../evidence/report.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const ledger = parseLedger(readFileSync(resolve(ROOT, "EVIDENCE.md"), "utf8"));
const vector = JSON.parse(readFileSync(resolve(ROOT, "test/vectors/evidence-check-answers.json"), "utf8")) as {
  answers: Record<string, Fetched>;
};
const row = (n: number): TxRow => {
  const r = ledger.rows.find((x) => x.n === n);
  if (!r) throw new Error(`no row ${n}`);
  return r;
};
const answer = (n: number): Fetched => structuredClone(vector.answers[String(n)]) as Fetched;
/** Recorded answers are edited freely in the tamper tests. */
type Any = any;

describe("EVIDENCE.md parser", () => {
  it("finds the numbered rows 1 to N in order, each with a full hash", () => {
    expect(ledger.rows.length).toBeGreaterThanOrEqual(123);
    expect(ledger.rows.map((r) => r.n)).toEqual(ledger.rows.map((_, i) => i + 1));
    for (const r of ledger.rows) {
      expect(r.kind === "evm").toBe(/EVM 9800/.test(r.network));
      expect(r.date).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(r.height).toBeGreaterThan(10_000_000);
    }
  });

  it("finds the read-only checks", () => {
    expect(ledger.readOnly.length).toBe(6);
    expect(ledger.readOnly.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses a row without a full hash, or with a cell missing", () => {
    const head = "| # | Date (UTC) | Network | Height | Tx hash | Explorer | What it proves | How to re-verify |\n|---|---|---|---|---|---|---|---|\n";
    expect(() => parseLedger(`${head}| 1 | 2026-11-19 | testnet | 1 | \`ABCD…1234\` | x | y | z |`)).toThrow(/full transaction hash/);
    expect(() => parseLedger(`${head}| 1 | 2026-11-19 | testnet | 1 | x | y | z |`)).toThrow(/8 cells/);
  });
});

describe("what each row claims (expect.ts)", () => {
  it("lists claims for every numbered row, and for no row that does not exist", () => {
    expect(Object.keys(EXPECT).map(Number).sort((a, b) => a - b)).toEqual(ledger.rows.map((r) => r.n));
  });

  it("checks the hybrid signature on every row that says hybrid-signed", () => {
    for (const r of ledger.rows.filter((x) => /hybrid-signed|pqc_hybrid_verify|hybrid signature/.test(x.proves))) {
      const hybrid = EXPECT[r.n]?.events?.find((e) => e.type === "pqc_hybrid_verify" && e.attrs?.["status"] === "verified");
      expect(hybrid, `row ${r.n}`).toBeDefined();
    }
  });

  it("expects a failure exactly where the row records an error code", () => {
    const failing = ledger.rows.filter((x) => /\bcode \d+/.test(x.proves)).map((x) => x.n);
    const expected = Object.entries(EXPECT)
      .filter(([, x]) => x.failure)
      .map(([n]) => Number(n));
    expect(expected.sort((a, b) => a - b)).toEqual(failing);
    for (const n of failing) expect(row(n).proves).toContain(`code ${EXPECT[n]?.failure?.code}`);
  });

  it("checks every gas figure a row states in full", () => {
    for (const r of ledger.rows.filter((x) => x.kind === "evm")) {
      const stated = /([\d,]{5,}) gas\b/.exec(r.proves) ?? /Gas used ([\d,]+)/.exec(r.proves);
      if (stated?.[1]) expect(EXPECT[r.n]?.gasUsed, `row ${r.n}`).toBe(Number(stated[1].replace(/,/g, "")));
    }
  });
});

describe("judging recorded answers", () => {
  for (const n of Object.keys(vector.answers).map(Number)) {
    it(`row ${n} is re-verified from its recorded answer`, () => {
      const r = judgeRow(row(n), EXPECT[n], answer(n));
      expect(r.checks.filter((c) => !c.ok)).toEqual([]);
      expect(r.status).toBe("verified");
      expect(r.checks.length).toBeGreaterThanOrEqual(4);
    });
  }

  it("a row with no listed claims still gets the generic checks, and says so", () => {
    const r = judgeRow(row(13), undefined, answer(13));
    expect(r).toMatchObject({ status: "verified", claimsListed: false });
    expect(r.checks.map((c) => c.what)).toEqual(["height", "date (UTC)", "result"]);
  });
});

describe("catching answers that disagree with the row", () => {
  const mismatch = (n: number, edit: (body: Any) => void) => {
    const f = answer(n);
    edit(f.body);
    return judgeRow(row(n), EXPECT[n], f);
  };
  const failedChecks = (r: ReturnType<typeof judgeRow>) => r.checks.filter((c) => !c.ok).map((c) => c.what);

  it("another height", () => {
    const r = mismatch(13, (b) => (b.tx_response.height = "10351826"));
    expect(r.status).toBe("mismatch");
    expect(failedChecks(r)).toEqual(["height"]);
  });

  it("a success where the row records a failure, and the reverse", () => {
    expect(failedChecks(mismatch(2, (b) => ((b.tx_response.code = 0), (b.tx_response.codespace = ""))))).toContain("result");
    expect(failedChecks(mismatch(16, (b) => ((b.tx_response.code = 11), (b.tx_response.codespace = "sdk"))))).toEqual(["result"]);
  });

  it("another challenger in the upheld fraud proof", () => {
    const r = mismatch(55, (b) => {
      const e = b.tx_response.events.find((x: Any) => x.type === "rdk_fraud_upheld");
      e.attributes.find((a: Any) => a.key === "challenger").value = "qor1ua2dl0nuf3qxr5yfhr3x9ah5cdh9vw7qczvdj5";
    });
    expect(r.status).toBe("mismatch");
    expect(r.checks.find((c) => !c.ok)).toMatchObject({ what: "event rdk_fraud_upheld", actual: expect.stringContaining("qor1ua2dl") });
  });

  it("an anchor on the standby's batch, which the row says has none", () => {
    const r = mismatch(69, (b) => b.tx_response.events.push({ type: "state_anchored", attributes: [] }));
    expect(failedChecks(r)).toEqual(["no state_anchored event"]);
  });

  it("another state root than the ledger's abbreviation", () => {
    const r = mismatch(16, (b) => {
      const e = b.tx_response.events.find((x: Any) => x.type === "state_anchored");
      e.attributes.find((a: Any) => a.key === "state_root").value = "078c8a0f" + "0".repeat(56);
    });
    expect(failedChecks(r)).toEqual(["event state_anchored"]);
  });

  it("a different fee or gas", () => {
    expect(failedChecks(mismatch(13, (b) => (b.tx.auth_info.fee.amount[0].amount = "91617")))).toEqual(["fee (uqor)"]);
    expect(failedChecks(mismatch(55, (b) => (b.tx_response.gas_used = "345266")))).toEqual(["gas used"]);
  });

  it("EVM: a different amount fronted, a missing log, a revert", () => {
    const paid = mismatch(91, (b) => {
      // Fronted's data: batchIndex, withdrawalIndex, paid, fee. Change the last nibble of `paid`.
      const l = b.result.logs[0];
      const words = l.data.slice(2).match(/.{64}/g);
      words[2] = words[2].slice(0, 63) + (words[2].at(-1) === "0" ? "1" : "0");
      l.data = "0x" + words.join("");
    });
    expect(failedChecks(paid)).toEqual(["log Fronted from 0x3a897802b62b052a102f55e021bc4668539c29b5"]);
    expect(failedChecks(mismatch(62, (b) => (b.result.logs = [])))).toEqual(["log Attested from 0xc87c7680b70e21464aac4e2308a9caa5324e4590"]);
    expect(failedChecks(mismatch(6, (b) => (b.result.status = "0x0")))).toEqual(["result"]);
  });

  it("EVM: a block hash that is not zero in the BLOCKHASH probe", () => {
    const r = mismatch(61, (b) => {
      const l = b.result.logs[0];
      const a = decodeEventLog({ abi: EVENTS_ABI, data: l.data, topics: l.topics }).args as Any;
      const hashes = [...a.hashes];
      hashes[a.depths.findIndex((d: bigint) => d === 256n)] = `0x${"ab".repeat(32)}`;
      l.data = encodeAbiParameters(parseAbiParameters("uint256, uint256[], bytes32[], bool, bytes"), [
        a.number,
        a.depths,
        hashes,
        a.historyCallOk,
        a.historyReturn,
      ]);
    });
    expect(failedChecks(r)).toEqual(["log Probe from 0x2d484549b2f05c2867c8f7051951b569dab79ca6"]);
  });
});

describe("answers that cannot be judged", () => {
  const native = row(13);
  const evm = row(62);
  const f = (httpStatus: number, body: unknown): Fetched => ({ url: "x", fetchedAt: "2026-11-27T00:00:00Z", httpStatus, body });

  it("a transaction the node no longer returns is 'not found', not a failure", () => {
    expect(judgeRow(native, EXPECT[13], f(404, { code: 5, message: "tx not found: 02993B…" })).status).toBe("not found");
    expect(judgeRow(native, EXPECT[13], f(400, { code: 3, message: "tx not found" })).status).toBe("not found");
    expect(judgeRow(evm, EXPECT[62], f(200, { jsonrpc: "2.0", id: 1, result: null })).status).toBe("not found");
  });

  it("a rate limit, a server error or a broken answer is an error", () => {
    expect(judgeRow(native, EXPECT[13], f(429, "Too Many Requests")).status).toBe("error");
    expect(judgeRow(native, EXPECT[13], f(0, "fetch failed")).status).toBe("error");
    expect(judgeRow(native, EXPECT[13], f(200, "<html>")).status).toBe("error");
    expect(judgeRow(evm, EXPECT[62], f(200, { jsonrpc: "2.0", id: 1, error: { message: "limit" } })).status).toBe("error");
  });
});

describe("matching the ledger's abbreviations", () => {
  it("matches start and end, or the whole value", () => {
    expect(matchesAbbrev("27cc2491…959e", "27cc24911b144e354f0154d22fbf5a9a2143655cc9763e90614b2aba6761959e")).toBe(true);
    expect(matchesAbbrev("27cc2491…959f", "27cc24911b144e354f0154d22fbf5a9a2143655cc9763e90614b2aba6761959e")).toBe(false);
    expect(matchesAbbrev("2c891f7a…", "2c891f7a00")).toBe(true);
    expect(matchesAbbrev("abc…cde", "abcde")).toBe(false);
    expect(matchesAbbrev("1000000uqor", "1000000uqor")).toBe(true);
    expect(matchesAbbrev("1000000uqor", "10000000uqor")).toBe(false);
    expect(matchesAbbrev("x", undefined)).toBe(false);
  });
});

describe("the report", () => {
  it("formats row ranges", () => {
    expect(ranges([])).toBe("none");
    expect(ranges([5])).toBe("5");
    expect(ranges([1, 2, 3, 5, 7, 8])).toBe("1 to 3, 5 and 7, 8");
    expect(ranges([3, 1, 2])).toBe("1 to 3");
  });

  it("lists every read-only check by command, never as passed", () => {
    const ro = readOnlyResults(ledger.readOnly);
    expect(ro.every((x) => x.status === "by command" && x.command.length > 0)).toBe(true);
    expect(ro.find((x) => x.command.includes("deploy-vault.ts"))?.why).toMatch(/key/);
    expect(commandsOf("`a b`; recorded in `test/vectors/x.json`")).toBe("a b");
  });

  it("puts the headline, the failures and the by-command rows in the summary", () => {
    const ok = judgeRow(row(13), EXPECT[13], answer(13));
    const bad = judgeRow(row(16), EXPECT[16], { ...answer(16), httpStatus: 404, body: { code: 5, message: "tx not found" } });
    const report = buildReport({
      ledgerSha256: "0".repeat(64),
      rows: [ok, bad],
      readOnly: ledger.readOnly,
      rest: "https://api-testnet.qore.host",
      evmRpc: "https://evm-testnet.qore.host",
      tipHeight: 10_859_709,
      tipTime: "2026-11-27T16:42:57.893Z",
      readTimes: ["2026-11-27T16:43:00Z", "2026-11-27T16:45:10Z"],
      minGapMs: 1000,
    });
    expect(report.headline).toBe("1 of 2 rows re-verified at height 10,859,709 (27 Nov 2026, 16:42 UTC), as the node reports");
    expect(report.summary).toMatchObject({ rows: 2, verified: 1, "not found": 1, mismatch: 0, error: 0 });
    const md = toMarkdown(report);
    expect(md).toContain(report.headline);
    expect(md).toContain("| not found | 16 |");
    expect(md).toContain("## Rows not re-verified");
    expect(md).toContain("deploy-vault.ts verify");
    expect(md.split("\n").filter((l) => /^\| [1-6] \| 2026-/.test(l))).toHaveLength(6);
  });
});

describe("the throttled reader", () => {
  /** A fake clock: sleeping moves time forward at once. */
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => (t += ms) };
  };

  it("never sends two requests less than a second apart, even if asked to", async () => {
    const c = clock();
    const starts: number[] = [];
    const fetchFn = (async () => {
      starts.push(c.now());
      c.advance(50);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
    }) as typeof fetch;
    const reader = new ChainReader({ fetchFn, gapMs: 10, now: c.now, sleep: c.sleep });
    expect(reader.gapMs).toBe(MIN_GAP_MS);
    for (let i = 0; i < 4; i++) await reader.evmReceipt(`0x${String(i).repeat(64)}`);
    expect(starts.slice(1).map((s, i) => s - (starts[i] as number))).toEqual([1000, 1000, 1000]);
  });

  it("retries a rate limit at most twice, then reports the error", async () => {
    const c = clock();
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("slow down", { status: 429 });
    }) as typeof fetch;
    const reader = new ChainReader({ fetchFn, now: c.now, sleep: c.sleep });
    const f = await reader.nativeTx("A".repeat(64));
    expect(calls).toBe(3);
    expect(f.httpStatus).toBe(429);
  });

  it("only reads and only asks for receipts", async () => {
    const c = clock();
    const seen: { url: string; method: string; body?: string }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const reader = new ChainReader({ fetchFn, now: c.now, sleep: c.sleep });
    await reader.tip();
    await reader.nativeTx("B".repeat(64));
    await reader.evmReceipt(`0x${"c".repeat(64)}`);
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET", "POST"]);
    expect(JSON.parse(seen[2]?.body ?? "{}").method).toBe("eth_getTransactionReceipt");
    expect(seen.every((s) => s.url.startsWith("https://api-testnet.qore.host/") || s.url === "https://evm-testnet.qore.host")).toBe(true);
  });
});
