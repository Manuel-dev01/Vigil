// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A canary for the contracts gate (scripts/cbom/gate.ts), like PQGuardVault's doc comment: a
///         classical (ECDSA) key is named here, and ecrecover(digest, v, r, s) is written out, but nothing
///         calls them. The gate must pass it; CI checks that it does. Never compiled or deployed.
contract CommentsOnly {
    // ECDSA.recover(digest, signature) and using ECDSA for bytes32; appear only in comments.
    /* address(1).staticcall(input) is commented out too. */
    string public constant NOTE = "ecrecover( and ECDSA.recover( are only text here";
    address public constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
}
