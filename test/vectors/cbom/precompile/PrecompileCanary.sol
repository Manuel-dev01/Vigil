// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A canary for the contracts gate's source check (scripts/cbom/precompiles.ts). It calls the ecrecover
///         precompile through a constant written as a full 20-byte address, as our contracts write pqcVerify's,
///         which QoreScan 0.1.0 does not flag. The gate with --sources must fail on it; CI checks that it does.
///         Not a Vigil contract: never compiled or deployed.
contract PrecompileCanary {
    address public constant REC = 0x0000000000000000000000000000000000000001;

    function signer(bytes32 digest, uint8 v, bytes32 r, bytes32 s) external view returns (address) {
        (bool ok, bytes memory out) = REC.staticcall(abi.encode(digest, v, r, s));
        require(ok && out.length == 32);
        return abi.decode(out, (address));
    }
}
