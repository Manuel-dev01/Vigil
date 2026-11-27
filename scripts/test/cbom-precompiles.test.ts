/**
 * The contracts gate's source check (scripts/cbom/precompiles.ts): Solidity that names a classical public-key
 * precompile's address in a form QoreScan 0.1.0 does not flag. Each form on a small inline source, the
 * canaries in test/vectors/cbom, and Vigil's own contracts.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contractsGate, parseCbom } from "../cbom/lib.ts";
import { blankCommentsAndStrings, checkSources, classicalPrecompileUses } from "../cbom/precompiles.ts";

const REPO = resolve(import.meta.dirname, "../..");
const uses = (body: string) => classicalPrecompileUses(`pragma solidity 0.8.28;\ncontract C {\n${body}\n}\n`, "C.sol");
const addresses = (body: string) => uses(body).map((u) => u.address);

describe("source check: the forms it catches", () => {
  it("a constant written as a full 20-byte address, the form QoreScan 0.1.0 misses", () => {
    expect(uses("address constant REC = 0x0000000000000000000000000000000000000001;")).toEqual([
      { where: "C.sol:3", address: "0x01", what: "ecrecover (ECDSA secp256k1)", text: "0x0000000000000000000000000000000000000001" },
    ]);
    expect(addresses("address constant P256 = 0x0000000000000000000000000000000000000100;")).toEqual(["0x100"]);
  });

  it("address(N) in hex or decimal, through casts", () => {
    expect(addresses("address a = address(1);")).toEqual(["0x01"]);
    expect(addresses("address a = address(0x100);")).toEqual(["0x100"]);
    expect(addresses("address a = address(uint160(0x05));")).toEqual(["0x05"]);
    expect(addresses("address payable a = payable(address(256));")).toEqual(["0x100"]);
    expect(addresses("address a = address(bytes20(uint160(8)));")).toEqual(["0x08"]);
  });

  it("address(NAME) where NAME is a numeric constant", () => {
    expect(addresses("uint160 constant ECRECOVER = 1;\nfunction f() external view { address(ECRECOVER).staticcall(\"\"); }")).toEqual(["0x01"]);
  });

  it("assembly calls to a number, a constant or an assembly variable", () => {
    expect(addresses("function f() external view { assembly { let ok := staticcall(gas(), 0x01, 0, 128, 0, 32) } }")).toEqual(["0x01"]);
    expect(addresses("function f() external view { assembly { let ok := staticcall(sub(gas(), 2000), 256, 0, 160, 0, 32) } }")).toEqual(["0x100"]);
    expect(addresses("uint256 constant P = 0x100;\nfunction f() external view { assembly { let ok := staticcall(gas(), P, 0, 160, 0, 32) } }")).toEqual(["0x100"]);
    expect(addresses("function f() external { assembly { let t := 5\n let ok := call(gas(), t, 0, 0, 0, 0, 0) } }")).toEqual(["0x05"]);
  });

  it("each precompile once per line", () => {
    expect(uses("address constant A = address(1); address constant B = 0x0000000000000000000000000000000000000001;")).toHaveLength(1);
  });
});

describe("source check: what it leaves alone", () => {
  it("pqcVerify, pqcKeyStatus, address(0), address(this) and other precompiles", () => {
    expect(
      uses(
        [
          "address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;",
          "address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;",
          "address constant SHA = address(2);",
          "address constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;",
          "function f() external view { address(0); address(this); assembly { let ok := staticcall(gas(), 0x0a01, 0, 0, 0, 0) } }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a numeric constant equal to 1 that is never used as an address", () => {
    expect(uses("uint8 public constant ALG_ML_DSA_87 = 1;\nuint256 constant WEI = 1e12;")).toEqual([]);
  });

  it("names in comments and strings", () => {
    const src = [
      "// address(1).staticcall(input) and 0x0000000000000000000000000000000000000001",
      "/* assembly { staticcall(gas(), 0x01, 0, 0, 0, 0) }",
      "   address(0x100) */",
      'string constant A = "address(1) and 0x0000000000000000000000000000000000000001";',
      "string constant B = 'address(0x100)';",
      'string constant C = "an escaped \\" quote, then address(1)";',
    ].join("\n");
    expect(uses(src)).toEqual([]);
  });

  it("blanks comments and strings but keeps lines and offsets", () => {
    const src = 'a // x\n/* y\nz */ "q\\"r" b';
    const out = blankCommentsAndStrings(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(3);
    expect(out.replace(/\s+/g, " ").trim()).toBe("a b");
  });
});

describe("source check on the canaries and the contracts", () => {
  it("catches the precompile canary, which QoreScan's own recorded scan passes", () => {
    const qorescan = contractsGate(parseCbom(readFileSync(resolve(REPO, "test/vectors/cbom/precompile.cdx.json"), "utf8")));
    expect(qorescan.ok).toBe(true);
    const { files, uses: found } = checkSources(resolve(REPO, "test/vectors/cbom/precompile"));
    expect(files).toBe(1);
    expect(found.map((u) => `${u.where} ${u.address}`)).toEqual(["PrecompileCanary.sol:9 0x01"]);
  });

  it("passes the comments canary, which names ecrecover and address(1) only in comments and strings", () => {
    expect(checkSources(resolve(REPO, "test/vectors/cbom/comments"))).toEqual({ files: 1, uses: [] });
  });

  it("passes Vigil's contracts, PQGuardVault's doc comment included", () => {
    expect(checkSources(resolve(REPO, "contracts/src"))).toEqual({ files: 5, uses: [] });
  });
});
