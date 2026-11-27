// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A canary for the contracts gate (scripts/cbom/gate.ts). It verifies a classical signature, so the
///         gate must fail on it; CI checks that it does. Not a Vigil contract: never compiled or deployed.
contract ClassicalCanary {
    function signer(bytes32 digest, uint8 v, bytes32 r, bytes32 s) external pure returns (address) {
        return ecrecover(digest, v, r, s);
    }
}
