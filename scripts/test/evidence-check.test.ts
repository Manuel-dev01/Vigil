/**
 * The evidence check, offline: parsing EVIDENCE.md, judging recorded chain answers
 * (test/vectors/evidence-check-answers.json), catching tampered answers, and the throttled reader.
 * No network: the reader is driven by a fake fetch and a fake clock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEventLog, encodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../evidence/args.ts";
import { EVENTS_ABI, isTxNotFound, judgeRow, matchesAbbrev, qorAt } from "../evidence/check.ts";
import { EXPECT } from "../evidence/expect.ts";
import { ChainReader, MIN_GAP_MS, worthKeeping, type Fetched } from "../evidence/fetch.ts";
import { cells, parseLedger, type TxRow } from "../evidence/ledger.ts";
import { buildReport, commandsOf, failReasons, NOT_SCRIPTED, ranges, readOnlyResults, toMarkdown } from "../evidence/report.ts";

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
    expect(ledger.readOnly.length).toBeGreaterThanOrEqual(6);
    expect(ledger.readOnly.map((r) => r.index)).toEqual(ledger.readOnly.map((_, i) => i + 1));
  });

  it("reads rows that start with a link target, as every row of EVIDENCE.md does", () => {
    const head = "| # | Date (UTC) | Network | Height | Tx hash | Explorer | What it proves | How to re-verify |\n|---|---|---|---|---|---|---|---|\n";
    const hash = "A".repeat(64);
    const md =
      `${head}| <a id="r7"></a>7 | 2026-11-17 | testnet | 10,241,833 | \`${hash}\` | x | y | z |\n\n` +
      "## Read-only checks (no transaction)\n\n| Date (UTC) | Network | Height | What it shows | How to re-verify |\n|---|---|---|---|---|\n" +
      '| <a id="ro-escrow"></a>2026-11-27 | testnet | ~10,859,700 | x | `GET /x` |\n';
    const parsed = parseLedger(md);
    expect(parsed.rows.map((r) => [r.n, r.date, r.height, r.hash])).toEqual([[7, "2026-11-17", 10_241_833, hash]]);
    expect(parsed.readOnly.map((r) => [r.index, r.date, r.height])).toEqual([[1, "2026-11-27", "~10,859,700"]]);
    // No row of EVIDENCE.md is lost to its link target: one parsed row per anchored line, in both tables.
    const lines = readFileSync(resolve(ROOT, "EVIDENCE.md"), "utf8").split(/\r?\n/);
    const numbered = lines.filter((l) => /^\|\s*(<a id="r\d+"><\/a>)?\d+\s*\|/.test(l));
    expect(numbered.length).toBe(ledger.rows.length);
    for (const [i, l] of numbered.entries()) expect(l.startsWith(`| <a id="r${i + 1}"></a>${i + 1} |`), `row ${i + 1}`).toBe(true);
    const readOnly = lines.filter((l) => /^\|\s*(<a id="[^"]+"><\/a>)?\d{4}-\d{2}-\d{2}\s*\|/.test(l) && cells(l).length === 5);
    expect(readOnly.length).toBe(ledger.readOnly.length);
  });

  it("refuses a row without a full hash, or with a cell missing", () => {
    const head = "| # | Date (UTC) | Network | Height | Tx hash | Explorer | What it proves | How to re-verify |\n|---|---|---|---|---|---|---|---|\n";
    expect(() => parseLedger(`${head}| 1 | 2026-11-19 | testnet | 1 | \`ABCD…1234\` | x | y | z |`)).toThrow(/full transaction hash/);
    expect(() => parseLedger(`${head}| 1 | 2026-11-19 | testnet | 1 | x | y | z |`)).toThrow(/8 cells/);
  });
});

describe("what each row claims (expect.ts)", () => {
  // Rows added to EVIDENCE.md later get the generic checks until their claims are listed (the report
  // names them), so these tests hold the listed rows to their text and do not fail on a new row.
  const listed = ledger.rows.filter((r) => EXPECT[r.n] !== undefined);

  it("lists claims for rows 1 to 123, and for no row that does not exist", () => {
    for (let n = 1; n <= 123; n++) expect(EXPECT[n], `row ${n}`).toBeDefined();
    const rows = new Set(ledger.rows.map((r) => r.n));
    expect(Object.keys(EXPECT).map(Number).filter((n) => !rows.has(n))).toEqual([]);
  });

  it("checks the hybrid signature on every listed row that says hybrid-signed", () => {
    for (const r of listed.filter((x) => /hybrid-signed|pqc_hybrid_verify|hybrid signature/.test(x.proves))) {
      const hybrid = EXPECT[r.n]?.events?.find((e) => e.type === "pqc_hybrid_verify" && e.attrs?.["status"] === "verified");
      expect(hybrid, `row ${r.n}`).toBeDefined();
    }
  });

  it("expects a failure exactly where a listed row records an error code", () => {
    const failing = listed.filter((x) => /\bcode \d+/.test(x.proves)).map((x) => x.n);
    const expected = Object.entries(EXPECT)
      .filter(([, x]) => x.failure)
      .map(([n]) => Number(n));
    expect(expected.sort((a, b) => a - b)).toEqual(failing);
    for (const n of failing) expect(row(n).proves).toContain(`code ${EXPECT[n]?.failure?.code}`);
  });

  it("checks every gas figure a listed EVM row states in full", () => {
    for (const r of listed.filter((x) => x.kind === "evm")) {
      const stated = /([\d,]{5,}) gas\b/.exec(r.proves) ?? /Gas used ([\d,]+)/.exec(r.proves);
      if (stated?.[1]) expect(EXPECT[r.n]?.gasUsed, `row ${r.n}`).toBe(Number(stated[1].replace(/,/g, "")));
    }
  });

  it("checks every transaction fee a listed row states, to the row's precision", () => {
    // The ways EVIDENCE.md states what a transaction itself paid ("Fee 0.091616 QOR", "paid its 0.24 QOR
    // fee", "279,928 gas (0.0315 QOR)", "fee 240,358 uqor"). A vault's 0.5% fee is a log value, not this.
    const inQor = [/\bfee (\d+\.\d+) QOR\b/i, /\bits (\d+\.\d+) QOR fee\b/, /\bgas \((\d+\.\d+) QOR\)/, /\bgas, about \d+k each, (\d+\.\d+) QOR\b/];
    const found: number[] = [];
    for (const r of listed) {
      const qor = inQor.map((re) => re.exec(r.proves)?.[1]).find((v) => v !== undefined);
      const uqor = /\bfee ([\d,]+) uqor\b/.exec(r.proves)?.[1];
      if (qor === undefined && uqor === undefined) continue;
      found.push(r.n);
      const x = EXPECT[r.n];
      if (uqor !== undefined) expect(x?.feeUqor, `row ${r.n}`).toBe(Number(uqor.replace(/,/g, "")));
      if (qor !== undefined) {
        // An exact figure may be listed in uqor instead.
        if (x?.feeQor !== undefined) expect(x.feeQor, `row ${r.n}`).toBe(qor);
        else expect(x?.feeUqor !== undefined && qorAt(BigInt(x.feeUqor), 6, qor), `row ${r.n}`).toBe(qor);
      }
    }
    expect(found.filter((n) => n <= 123)).toEqual([13, 14, 15, 45, 55, 62, 80, 112, 116, 118]);
  });

  it("matches the ledger's data hash, and the root row 62 abbreviates, as the rows write them", () => {
    expect(EXPECT[38]?.msgBytes?.["data_hash"]).toBe("a3b68326…f327");
    expect(row(38).proves).toContain("a3b68326…f327");
    // Row 62 writes the root as 27cc…959e; the full value is not taken from the chain's own answer.
    expect(row(62).recheck).toContain("0x27cc…959e");
    expect(JSON.stringify(EXPECT[62]?.logs?.[0]?.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))).toContain('"0x27cc…959e"');
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
    // Row 45 says "its 0.24 QOR fee": 0.235 or more rounds to it, 0.245 does not.
    expect(failedChecks(mismatch(45, (b) => (b.tx.auth_info.fee.amount[0].amount = "235000")))).toEqual([]);
    expect(failedChecks(mismatch(45, (b) => (b.tx.auth_info.fee.amount[0].amount = "245000")))).toEqual(["fee (QOR, as the row rounds it)"]);
    // Row 55 says "605,960 at 0.3 uqor, fee 0.18 QOR".
    expect(failedChecks(mismatch(55, (b) => (b.tx.auth_info.fee.amount[0].amount = "242384")))).toEqual(["fee (QOR, as the row rounds it)", "gas price (uqor)"]);
  });

  it("a different data hash in the batch message", () => {
    const r = mismatch(38, (b) => (b.tx.body.messages[0].data_hash = Buffer.from("ab".repeat(32), "hex").toString("base64")));
    expect(r.checks.find((c) => !c.ok)).toMatchObject({ what: "message data_hash", expected: "a3b68326…f327", actual: "ab".repeat(32) });
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
    const vaultFee = mismatch(91, (b) => {
      const l = b.result.logs[0];
      const words = l.data.slice(2).match(/.{64}/g);
      words[3] = (BigInt(`0x${words[3]}`) + 1n).toString(16).padStart(64, "0");
      l.data = "0x" + words.join("");
    });
    expect(failedChecks(vaultFee)).toEqual(["log Fronted from 0x3a897802b62b052a102f55e021bc4668539c29b5"]);
  });

  it("EVM: another state root than row 62's 27cc…959e, or another cost than its 0.0315 QOR", () => {
    const root = mismatch(62, (b) => {
      const l = b.result.logs[0];
      l.topics[2] = `0x27cc${"0".repeat(56)}959f`;
    });
    expect(failedChecks(root)).toEqual(["log Attested from 0xc87c7680b70e21464aac4e2308a9caa5324e4590"]);
    // 279,928 gas at twice the price is 0.0630 QOR.
    const cost = mismatch(62, (b) => (b.result.effectiveGasPrice = `0x${(BigInt(b.result.effectiveGasPrice) * 2n).toString(16)}`));
    expect(cost.checks.find((c) => !c.ok)).toMatchObject({ what: "fee (QOR, as the row rounds it)", expected: "0.0315", actual: "0.0630" });
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
    expect(judgeRow(evm, EXPECT[62], f(200, { jsonrpc: "2.0", id: 1, result: null })).status).toBe("not found");
  });

  it("only the node's own 'tx not found' answer counts as not found; any other 404 is an error", () => {
    // A proxy's HTML page, the gateway's answer for a route that does not exist, or another code.
    const html = f(404, "<html><body>404 Not Found</body></html>");
    const noRoute = f(404, { code: 5, message: "Not Found", details: [] });
    const other = f(404, { code: 3, message: "invalid hash" });
    for (const g of [html, noRoute, other]) {
      expect(isTxNotFound(g)).toBe(false);
      expect(judgeRow(native, EXPECT[13], g).status).toBe("error");
    }
    expect(isTxNotFound(f(404, { code: 5, message: "tx not found: 02993B…" }))).toBe(true);
    expect(isTxNotFound(f(200, { message: "tx not found" }))).toBe(false);
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
    expect(ranges([1, 2, 3, 5, 7, 8])).toBe("1 to 3, 5, 7 and 8");
    expect(ranges([1, 2])).toBe("1 and 2");
    expect(ranges([6, 60, 83])).toBe("6, 60 and 83");
    expect(ranges([3, 1, 2])).toBe("1 to 3");
  });

  it("rounds a fee to the places the row writes it with", () => {
    expect(qorAt(240_358n, 6, "0.24")).toBe("0.24");
    expect(qorAt(91_616n, 6, "0.091616")).toBe("0.091616");
    expect(qorAt(279_928n * 112_500_000_000n, 18, "0.0315")).toBe("0.0315");
    expect(qorAt(712_745n * 112_500_000_000n, 18, "0.080")).toBe("0.080");
    expect(qorAt(1_500_000n, 6, "2")).toBe("2");
    expect(() => qorAt(1n, 6, "0.0000001")).toThrow(/places/);
  });

  it("lists every read-only check by command, never as passed, with the reason meant for it", () => {
    const ro = readOnlyResults(ledger.readOnly);
    expect(ro.every((x) => x.status === "by command" && x.command.length > 0)).toBe(true);
    const why = (cmd: string) => ro.find((x) => x.command.includes(cmd))?.why;
    expect(why("deploy-vault.ts")).toMatch(/needs a key/);
    expect(why("spike:b")).toMatch(/separate probe .* requests few/);
    expect(why("qledger-watchtower")).toMatch(/^it replays batches/);
    expect(why("kit-gap-check.ts")).toMatch(/^it replays batches/);
    expect(why("receipts-snapshot.ts")).toMatch(/^it replays batches/);
    expect(why("spike:a <rollupId>")).toMatch(/offline part \(`pnpm test`\) runs in CI/);
    // A read-only row added later with a command no rule knows gets a neutral reason, not a wrong one.
    const added = readOnlyResults([{ index: 7, date: "2026-12-01", network: "testnet", height: "~10,900,000", recheck: "`pnpm --filter @vigil/web check-solvency`" }]);
    expect(added[0]?.why).toBe(NOT_SCRIPTED);
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
    expect(md).toContain("A claim in a row's text that is not listed there is not checked.");
    expect(md).not.toContain("This run fails");
    expect(md).not.toContain("--cache");
    expect(md.split("\n").filter((l) => /^\| [1-6] \| 2026-/.test(l))).toHaveLength(6);
  });

  it("names the rows whose answer carries no date, and says when answers came from a cache", () => {
    const rows = [6, 13, 62].map((n) => judgeRow(row(n), EXPECT[n], answer(n)));
    const report = buildReport({
      ledgerSha256: "0".repeat(64),
      rows,
      readOnly: [],
      rest: "r",
      evmRpc: "e",
      tipHeight: null,
      tipTime: null,
      readTimes: [],
      minGapMs: 1000,
      requests: 0,
      reusedFromCache: 4,
    });
    const md = toMarkdown(report);
    expect(md).toContain("so row 6 gets no date check");
    expect(rows.map((r) => r.status)).toEqual(["verified", "verified", "verified"]);
    expect(md).toContain("rebuilt from the answers saved when they were read (`--cache`), with no new reads");
    expect(report.run).toMatchObject({ requests: 0, reusedFromCache: 4 });
  });

  it("fails a run with a mismatch, a failed read, or fewer than half the rows re-verified", () => {
    const s = (o: Partial<Record<"verified" | "mismatch" | "not found" | "error", number>>) => {
      const c = { verified: 0, mismatch: 0, "not found": 0, error: 0, ...o };
      return { ...c, rows: c.verified + c.mismatch + c["not found"] + c.error, claimsListed: 0, checks: 0, checksPassed: 0 };
    };
    expect(failReasons(s({ verified: 123 }))).toEqual([]);
    expect(failReasons(s({ verified: 100, "not found": 23 }))).toEqual([]);
    expect(failReasons(s({ verified: 122, mismatch: 1 }))).toEqual(["1 row disagrees with the chain"]);
    expect(failReasons(s({ verified: 121, mismatch: 2 }))).toEqual(["2 rows disagree with the chain"]);
    expect(failReasons(s({ verified: 121, error: 2 }))).toEqual(["2 rows could not be read"]);
    // The node returns "not found" for everything (a moved route, a pruned index): nothing proved, so red.
    expect(failReasons(s({ "not found": 123 }))).toEqual(["only 0 of 123 rows were re-verified, fewer than half"]);
    expect(failReasons(s({ verified: 61, "not found": 62 }))).toEqual(["only 61 of 123 rows were re-verified, fewer than half"]);
    const md = toMarkdown(
      buildReport({
        ledgerSha256: "0".repeat(64),
        rows: [judgeRow(row(13), EXPECT[13], { ...answer(13), httpStatus: 404, body: { code: 5, message: "tx not found: 02993B" } })],
        readOnly: [],
        rest: "r",
        evmRpc: "e",
        tipHeight: null,
        tipTime: null,
        readTimes: [],
        minGapMs: 1000,
      }),
    );
    expect(md).toContain("**This run fails:** only 0 of 1 rows were re-verified, fewer than half.");
  });
});

describe("the command line", () => {
  it("reads the flags", () => {
    expect(parseArgs([])).toEqual({ write: false, gapMs: MIN_GAP_MS });
    expect(parseArgs(["--write", "--cache", "c", "--summary", "s.md", "--gap-ms", "1500"])).toEqual({
      write: true,
      cache: "c",
      summary: "s.md",
      gapMs: 1500,
    });
    expect([...(parseArgs(["--", "--rows", "13,60-62"]).rows ?? [])]).toEqual([13, 60, 61, 62]);
  });

  it("refuses a gap that is not a whole number of at least 1000 ms, so the throttle cannot be switched off", () => {
    for (const bad of [["--gap-ms", "1.5s"], ["--gap-ms", "abc"], ["--gap-ms", ""], ["--gap-ms", "999"], ["--gap-ms", "1e3"], ["--gap-ms", "-2000"]]) {
      expect(() => parseArgs(bad), bad.join(" ")).toThrow(UsageError);
    }
  });

  it("refuses a flag with its value missing, rather than reading the next flag as the value", () => {
    expect(() => parseArgs(["--gap-ms", "--write"])).toThrow(/--gap-ms needs a value/);
    expect(() => parseArgs(["--gap-ms"])).toThrow(/--gap-ms needs a value/);
    expect(() => parseArgs(["--rows", "--write"])).toThrow(/--rows needs a value/);
  });

  it("refuses an unknown flag, bad rows, and --rows with --write", () => {
    expect(() => parseArgs(["--row", "44"])).toThrow(/unknown argument "--row"/);
    expect(() => parseArgs(["--rows", "4x"])).toThrow(/cannot read "4x"/);
    expect(() => parseArgs(["--rows", "44", "--write"])).toThrow(/without --rows/);
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

  it("keeps requests a second apart when the gap is not a number (NaN, infinite or missing)", async () => {
    for (const gapMs of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const c = clock();
      const starts: number[] = [];
      const fetchFn = (async () => {
        starts.push(c.now());
        c.advance(30);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });
      }) as typeof fetch;
      const reader = new ChainReader({ fetchFn, ...(gapMs === undefined ? {} : { gapMs }), now: c.now, sleep: c.sleep });
      expect(reader.gapMs, String(gapMs)).toBe(MIN_GAP_MS);
      for (let i = 0; i < 4; i++) await reader.evmReceipt(`0x${String(i).repeat(64)}`);
      expect(starts.slice(1).map((s, i) => s - (starts[i] as number)), String(gapMs)).toEqual([1000, 1000, 1000]);
    }
  });

  it("caches only complete answers, so a 'not found' or a failure is asked again", () => {
    const f = (httpStatus: number, body: unknown): Fetched => ({ url: "x", fetchedAt: "t", httpStatus, body });
    expect(worthKeeping(f(200, { tx_response: {} }))).toBe(true);
    expect(worthKeeping(f(200, { jsonrpc: "2.0", id: 1, result: { status: "0x1" } }))).toBe(true);
    expect(worthKeeping(f(200, { jsonrpc: "2.0", id: 1, result: null }))).toBe(false);
    expect(worthKeeping(f(200, { jsonrpc: "2.0", id: 1, error: { message: "limit" } }))).toBe(false);
    expect(worthKeeping(f(404, { code: 5, message: "tx not found" }))).toBe(false);
    expect(worthKeeping(f(200, "<html>"))).toBe(false);
    expect(worthKeeping(f(429, "slow down"))).toBe(false);
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
