/** The exit address, derived in the browser, against the one vigil-pay-1's exits actually used. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bech32ToHex, hexToBech32 } from "@qorechain/rdk";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { EXIT_ADDRESS_CODE_HASH, EXIT_ADDRESS_CREATION_CODE, exitAddressOf, parseHexAddress } from "../src/exit-address.ts";

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = "0x3a897802b62b052a102f55e021bc4668539c29b5";
const artifact = join(here, "..", "..", "..", "contracts", "out", "InstantExitVault.sol", "ExitAddress.json");

describe("exitAddressOf", () => {
  it("gives qor1k44vs60… for the payout qor10w42gcuv… (the exits of batches 15 and 18)", () => {
    const payout = bech32ToHex("qor10w42gcuvzr0mvnt2ukfu9uqe0qh8wulrv2gk6k") as `0x${string}`;
    const exit = exitAddressOf(VAULT, payout);
    expect(hexToBech32(exit, "qor")).toBe("qor1k44vs60vpjqn6rlgy62d8e6v79lsln9a9eyucy");
  });

  it("pins the creation code it says it pins", () => {
    expect(keccak256(EXIT_ADDRESS_CREATION_CODE)).toBe(EXIT_ADDRESS_CODE_HASH);
  });

  it.skipIf(!existsSync(artifact))("matches a fresh Foundry build of ExitAddress", () => {
    const built = (JSON.parse(readFileSync(artifact, "utf8")) as { bytecode: { object: string } }).bytecode.object;
    expect(built.toLowerCase()).toBe(EXIT_ADDRESS_CREATION_CODE.toLowerCase());
  });

  it("depends on the vault and the payout", () => {
    const p = "0x7baaa4638c10dfb64d6ae593c2f019782e7773e3";
    expect(exitAddressOf(VAULT, p)).not.toBe(exitAddressOf("0x3a897802b62b052a102f55e021bc4668539c29b6", p));
    expect(exitAddressOf(VAULT, p)).not.toBe(exitAddressOf(VAULT, "0x7baaa4638c10dfb64d6ae593c2f019782e7773e4"));
  });
});

describe("parseHexAddress (EIP-55)", () => {
  it("accepts lower case, upper case and a correct checksum", () => {
    for (const s of ["0x7baaa4638c10dfb64d6ae593c2f019782e7773e3", "0x7BAAA4638C10DFB64D6AE593C2F019782E7773E3", "0x7BaAa4638c10dFB64D6ae593C2f019782E7773E3"]) {
      expect(parseHexAddress(s)).toEqual({ ok: true, address: "0x7BaAa4638c10dFB64D6ae593C2f019782E7773E3" });
    }
  });

  it("refuses mixed case that is not the checksum", () => {
    // The checksum with its last letter's case flipped.
    const r = parseHexAddress("0x7BaAa4638c10dFB64D6ae593C2f019782E7773e3");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/EIP-55/);
  });

  it("refuses the wrong length or non-hex", () => {
    expect(parseHexAddress("0x7baaa4638c10dfb64d6ae593c2f019782e7773").ok).toBe(false);
    expect(parseHexAddress("0x7baaa4638c10dfb64d6ae593c2f019782e7773zz").ok).toBe(false);
  });
});
