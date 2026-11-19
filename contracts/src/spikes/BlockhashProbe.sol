// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title BlockhashProbe (spike S3b)
/// @notice What BLOCKHASH returns inside a mined transaction on QoreChain's EVM. Under eth_call it
///         returned zero for every recent block (spike S3), which rules out verifying chain state in
///         Solidity from a block header ("Mode N"), unless a mined transaction sees real hashes.
///         The constructor does the whole job: it emits BLOCKHASH for several depths and what the
///         EIP-2935 history address answers, and the deploy script compares each hash with CometBFT's
///         block_id.hash for that height. No functions, no state, nothing to call afterwards.
contract BlockhashProbe {
    address public constant HISTORY_2935 = 0x0000F90827F1C53a10cb7A02335B175320002935;

    event Probe(uint256 number, uint256[] depths, bytes32[] hashes, bool historyCallOk, bytes historyReturn);

    constructor() {
        uint256[7] memory d = [uint256(0), 1, 2, 10, 100, 256, 257];
        uint256[] memory depths = new uint256[](d.length);
        bytes32[] memory hashes = new bytes32[](d.length);
        for (uint256 i = 0; i < d.length; i++) {
            depths[i] = d[i];
            hashes[i] = blockhash(block.number - d[i]);
        }
        (bool ok, bytes memory ret) = HISTORY_2935.staticcall(abi.encode(block.number - 1));
        emit Probe(block.number, depths, hashes, ok, ret);
    }
}
