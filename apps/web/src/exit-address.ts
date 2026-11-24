/**
 * A payout's exit address, derived in the browser exactly as InstantExitVault.exitAddressOf does:
 *
 *   address(uint160(keccak256(0xff | vault | bytes32(uint160(payout)) | keccak256(initCode))))
 *   initCode = type(ExitAddress).creationCode | abi.encode(vault, payout)
 *
 * The creation code is pinned below. It is the Foundry build of contracts/src/InstantExitVault.sol's
 * ExitAddress (solc 0.8.28, optimizer 200 runs, cancun, bytecode_hash none, no CBOR metadata):
 *   cd contracts && forge build && jq -r .bytecode.object out/InstantExitVault.sol/ExitAddress.json
 * The deployed vault's runtime code embeds these exact bytes. The page also asks the vault's own
 * exitAddressOf() and shows an address only when both agree.
 */
import { concat, encodeAbiParameters, getAddress, isAddress, keccak256, pad, type Hex } from "viem";

export const EXIT_ADDRESS_CREATION_CODE: Hex =
  "0x60c060405234801561000f575f5ffd5b506040516103d33803806103d383398101604081905261002e91610060565b6001600160a01b039182166080521660a052610091565b80516001600160a01b038116811461005b575f5ffd5b919050565b5f5f60408385031215610071575f5ffd5b61007a83610045565b915061008860208401610045565b90509250929050565b60805160a0516103016100d25f395f818160680152818160f0015281816101b6015261024f01525f818160b70152818161011c01526101de01526103015ff3fe608060405260043610610036575f3560e01c806335faa4161461004157806363bd1d4a14610057578063fbfa77cf146100a6575f5ffd5b3661003d57005b5f5ffd5b34801561004c575f5ffd5b506100556100d9565b005b348015610062575f5ffd5b5061008a7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b03909116815260200160405180910390f35b3480156100b1575f5ffd5b5061008a7f000000000000000000000000000000000000000000000000000000000000000081565b60405163df18e04760e01b81526001600160a01b037f00000000000000000000000000000000000000000000000000000000000000008116600483015247915f917f0000000000000000000000000000000000000000000000000000000000000000169063df18e04790602401602060405180830381865afa158015610161573d5f5f3e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061018591906102c5565b90505f8183106101955781610197565b825b9050801561023957604051636a256b2960e01b81526001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000811660048301527f00000000000000000000000000000000000000000000000000000000000000001690636a256b299083906024015f604051808303818588803b158015610221575f5ffd5b505af1158015610233573d5f5f3e3d5ffd5b50505050505b5f61024482856102dc565b905080156102bf575f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316826040515f6040518083038185875af1925050503d805f81146102b5576040519150601f19603f3d011682016040523d82523d5f602084013e6102ba565b606091505b505050505b50505050565b5f602082840312156102d5575f5ffd5b5051919050565b818103818111156102fb57634e487b7160e01b5f52601160045260245ffd5b9291505056";

/** keccak256 of the pinned creation code, for a quick comparison with a fresh build. */
export const EXIT_ADDRESS_CODE_HASH: Hex = "0x8506f2b189377374902cbf2f82081e4b77bff875cbc322a54353a213a6cce558";

/** `vault.exitAddressOf(payout)`, computed here. Both 0x addresses; returns the checksummed address. */
export function exitAddressOf(vault: Hex, payout: Hex): Hex {
  const v = getAddress(vault);
  const p = getAddress(payout);
  const init = concat([EXIT_ADDRESS_CREATION_CODE, encodeAbiParameters([{ type: "address" }, { type: "address" }], [v, p])]);
  const h = keccak256(concat(["0xff", v, pad(p, { size: 32 }), keccak256(init)]));
  return getAddress(`0x${h.slice(26)}`);
}

/**
 * A 0x address typed by a person: 40 hex digits; if it mixes upper and lower case, the case must be
 * its EIP-55 checksum (a wrong one usually means a typo). Returns the checksummed form, or why not.
 */
export function parseHexAddress(input: string): { ok: true; address: Hex } | { ok: false; error: string } {
  const s = input.trim();
  const h = s.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{40}$/.test(h)) return { ok: false, error: "That is not a 20-byte hex address (0x and 40 hex digits)." };
  const mixed = /[a-f]/.test(h) && /[A-F]/.test(h);
  if (mixed && !isAddress(`0x${h}`, { strict: true })) {
    return { ok: false, error: "That address mixes upper and lower case, but not as its EIP-55 checksum: check it for a typo (or enter it all in lower case)." };
  }
  return { ok: true, address: getAddress(`0x${h.toLowerCase()}`) };
}
