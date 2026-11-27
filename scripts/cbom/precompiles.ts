/**
 * A source check beside QoreScan's: Solidity that names the address of an EVM precompile for classical
 * public-key cryptography. QoreScan 0.1.0 catches `ecrecover(...)`, `address(1).staticcall` and an assembly
 * call to `0x01`, but not a call through a constant written as a full 20-byte address
 * (`address constant REC = 0x0000000000000000000000000000000000000001`), the style our contracts use for
 * pqcVerify (`0x…0a01`). This check reads the sources with comments and strings blanked, and finds:
 *   - a 20-byte address literal whose value is one of these precompiles;
 *   - `address(N)`, through any integer, `bytes20` or `payable` casts, where N is such a number or a
 *     constant (or assembly variable) set to one;
 *   - an assembly `call`, `staticcall`, `delegatecall` or `callcode` whose target is such a number or name.
 * It is a pattern check, not a proof: an address computed at run time (by arithmetic, or read from storage
 * or calldata) is not seen.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Precompiles that verify classical signatures, or do the arithmetic such signatures rest on. */
export const CLASSICAL_PRECOMPILES: ReadonlyMap<bigint, string> = new Map([
  [0x01n, "ecrecover (ECDSA secp256k1)"],
  [0x05n, "modexp (the usual base of RSA verification)"],
  [0x06n, "BN254 point addition (BLS, pairing proofs)"],
  [0x07n, "BN254 scalar multiplication (BLS, pairing proofs)"],
  [0x08n, "BN254 pairing (BLS, pairing proofs)"],
  [0x0bn, "BLS12-381 G1 addition (EIP-2537)"],
  [0x0cn, "BLS12-381 G1 multi-scalar multiplication (EIP-2537)"],
  [0x0dn, "BLS12-381 G2 addition (EIP-2537)"],
  [0x0en, "BLS12-381 G2 multi-scalar multiplication (EIP-2537)"],
  [0x0fn, "BLS12-381 pairing (EIP-2537)"],
  [0x10n, "BLS12-381 map to G1 (EIP-2537)"],
  [0x11n, "BLS12-381 map to G2 (EIP-2537)"],
  [0x100n, "P256VERIFY (ECDSA P-256, RIP-7212)"],
]);

export interface PrecompileUse {
  /** `file:line`. */
  where: string;
  /** The precompile's address, as 0x-hex. */
  address: string;
  /** What the precompile does. */
  what: string;
  /** The source text that names it. */
  text: string;
}

/**
 * The source with every comment and string literal replaced by spaces, newlines kept, so that offsets and
 * line numbers still match the original.
 */
export function blankCommentsAndStrings(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      blank(i, stop);
      i = stop;
    } else i++;
  }
  return out.join("");
}

/** A Solidity number literal (hex, or decimal with underscores and an optional exponent) as a bigint. */
function literalValue(lit: string): bigint | undefined {
  const s = lit.replace(/_/g, "");
  if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s);
  const m = /^(\d+)(?:e(\d+))?$/i.exec(s);
  if (!m) return undefined;
  return BigInt(m[1]!) * 10n ** BigInt(m[2] ?? "0");
}

const NUM = String.raw`0x[0-9a-fA-F_]+|\d[\d_]*(?:[eE]\d+)?`;
const IDENT = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
/** One call argument: anything without a comma or bracket, or a bracketed group up to two levels deep. */
const ARG = String.raw`(?:[^,()]|\((?:[^()]|\([^()]*\))*\))*`;

/** Every place in one Solidity file that names a classical public-key precompile's address. */
export function classicalPrecompileUses(src: string, file: string): PrecompileUse[] {
  const code = blankCommentsAndStrings(src);
  const lineAt = (index: number) => code.slice(0, index).split("\n").length;

  // Names bound to a number: `<type> constant NAME = N;` in Solidity, `let NAME := N` or `NAME := N` in assembly.
  const named = new Map<string, bigint>();
  for (const m of code.matchAll(new RegExp(String.raw`\bconstant\s+(${IDENT})\s*=\s*(?:(?:u?int\d*|bytes20|address|payable)\s*\(\s*)*(${NUM})\b`, "g"))) {
    const v = literalValue(m[2]!);
    if (v !== undefined) named.set(m[1]!, v);
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?:\blet\s+)?\b(${IDENT})\s*:=\s*(${NUM})\b`, "g"))) {
    const v = literalValue(m[2]!);
    if (v !== undefined) named.set(m[1]!, v);
  }
  const valueOf = (token: string): bigint | undefined => (/^[0-9]/.test(token) ? literalValue(token) : named.get(token));

  const uses: PrecompileUse[] = [];
  const seen = new Set<string>();
  const add = (index: number, value: bigint | undefined, text: string) => {
    if (value === undefined) return;
    const what = CLASSICAL_PRECOMPILES.get(value);
    if (!what) return;
    const where = `${file}:${lineAt(index)}`;
    const key = `${where} ${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    uses.push({ where, address: `0x${value.toString(16).padStart(2, "0")}`, what, text: text.replace(/\s+/g, " ").trim() });
  };

  // A 20-byte address literal.
  for (const m of code.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) add(m.index, BigInt(m[0]), m[0]);
  // address(N), address(uint160(N)), address(bytes20(N)), payable(N) ..., N a number or a name.
  for (const m of code.matchAll(new RegExp(String.raw`\baddress\s*\(\s*(?:(?:u?int\d*|bytes20|payable)\s*\(\s*)*(${NUM}|${IDENT})\s*\)`, "g"))) {
    add(m.index, valueOf(m[1]!), m[0]);
  }
  // Assembly calls: call(gas, target, ...), staticcall(gas, target, ...) and the rest.
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:staticcall|call|delegatecall|callcode)\s*\(${ARG},\s*(${NUM}|${IDENT})\s*,`, "g"))) {
    add(m.index, valueOf(m[1]!), m[0]);
  }
  return uses.sort((a, b) => a.where.localeCompare(b.where, undefined, { numeric: true }));
}

/** The check over every .sol file under a directory; `where` is relative to it. */
export function checkSources(dir: string): { files: number; uses: PrecompileUse[] } {
  const paths: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".sol")) paths.push(p);
    }
  };
  walk(dir);
  paths.sort();
  return { files: paths.length, uses: paths.flatMap((p) => classicalPrecompileUses(readFileSync(p, "utf8"), relative(dir, p))) };
}
