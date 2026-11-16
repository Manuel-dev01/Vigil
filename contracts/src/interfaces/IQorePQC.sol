// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice QoreChain EVM post-quantum precompiles (testnet, chain v3.2.8+).
/// pqcVerify  at 0x0000000000000000000000000000000000000a01: ML-DSA-87, FIPS 204 pure mode with an
///            EMPTY context (checked on qorechain-diana, 16 Nov 2026). Domain separation therefore
///            has to be inside `message`.
/// pqcKeyStatus at 0x0000000000000000000000000000000000000a02: the account's registered key.
/// An inactive precompile answers a call with success and EMPTY data, so callers must check the
/// return length rather than trust a typed call.
interface IQorePQC {
    function pqcVerify(bytes memory pubkey, bytes memory signature, bytes memory message)
        external
        view
        returns (bool valid);

    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
