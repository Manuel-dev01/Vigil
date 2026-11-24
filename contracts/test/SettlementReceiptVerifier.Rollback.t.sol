// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettlementReceiptVerifier} from "../src/SettlementReceiptVerifier.sol";
import {MockPqcKeyStatus, MockPqcVerify} from "./mocks/PqcMocks.sol";

/// KNOWN BEHAVIOUR: the verifier keys records by layer height alone. When a challenge rolls the rollup back
/// and the creator re-anchors a height it had already anchored, with a different (honest) root, the
/// verifier cannot tell a rollback from equivocation: the height is marked conflicted for good, and neither
/// the removed root nor the honest one is ever reported as attested there. Heights below the rollback and
/// new heights above it are unaffected. Consumers that need the honest root of a re-anchored height must
/// read it from a QoreChain node.
///
/// Runs on vigil-pay-1's real anchors (test/vectors/anchors-vigil-pay-1.json); the re-anchors are made up
/// and marked signed in the mock precompile.
contract SettlementReceiptVerifierRollbackTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    SettlementReceiptVerifier verifier;
    MockPqcVerify pqc;
    MockPqcKeyStatus keys;
    string json;
    address creator;
    bytes creatorKey;
    uint256 count;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../test/vectors/anchors-vigil-pay-1.json"));
        creator = vm.parseJsonAddress(json, ".creatorEvm");
        creatorKey = vm.parseJsonBytes(json, ".creatorPublicKey");
        count = vm.parseJsonUint(json, ".count");
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);
        pqc = MockPqcVerify(PQC_VERIFY);
        keys = MockPqcKeyStatus(PQC_KEY_STATUS);
        keys.set(creator, true, 1, creatorKey, true);
        vm.chainId(9800);
        verifier = new SettlementReceiptVerifier(creator, "qorechain-diana", "vigil-pay-1");

        for (uint256 i = 0; i < count; i++) {
            SettlementReceiptVerifier.Anchor memory a = _anchor(i);
            pqc.markValid(creatorKey, a.signature, verifier.anchorMessage(a));
            assertTrue(verifier.attest(a));
        }
    }

    function _key(uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".anchors[", vm.toString(i), "].", field);
    }

    function _anchor(uint256 i) internal view returns (SettlementReceiptVerifier.Anchor memory a) {
        a.layerHeight = uint64(vm.parseJsonUint(json, _key(i, "layerHeight")));
        a.stateRoot = vm.parseJsonBytes32(json, _key(i, "stateRoot"));
        a.validatorSetHash = vm.parseJsonBytes(json, _key(i, "validatorSetHash"));
        a.transactionCount = uint64(vm.parseJsonUint(json, _key(i, "transactionCount")));
        a.compressedStateProof = vm.parseJsonBytes(json, _key(i, "compressedStateProof"));
        a.signature = vm.parseJsonBytes(json, _key(i, "signature"));
    }

    /// The creator's (made-up) anchor of `height` with `root`, marked as signed in the mock.
    function _reanchor(uint64 height, bytes32 root, uint8 tweak)
        internal
        returns (SettlementReceiptVerifier.Anchor memory a)
    {
        a = _anchor(count - 1);
        a.layerHeight = height;
        a.stateRoot = root;
        a.signature[0] = bytes1(uint8(a.signature[0]) ^ tweak);
        pqc.markValid(creatorKey, a.signature, verifier.anchorMessage(a));
    }

    function test_ReanchoringAfterARollbackMarksTheHeightsConflicted_knownBehaviour() public {
        // A challenge removes heights 8, 9 and 10; the creator re-anchors them with the honest roots.
        for (uint64 h = 8; h <= 10; h++) {
            bytes32 removed = _anchor(h).stateRoot;
            bytes32 honest = keccak256(abi.encode("after rollback", h));
            SettlementReceiptVerifier.Anchor memory a = _reanchor(h, honest, uint8(h));

            vm.expectEmit(true, false, false, true, address(verifier));
            emit SettlementReceiptVerifier.Conflict(h, removed, honest, address(this));
            assertFalse(verifier.attest(a), "a re-anchor records nothing");

            assertFalse(verifier.isAttested(h, removed), "the removed root is no longer reported");
            assertFalse(verifier.isAttested(h, honest), "nor is the honest one, ever");
            assertEq(verifier.conflictingRoot(h), honest);
            (bytes32 kept,,, bool conflicted) = verifier.records(h);
            assertEq(kept, removed, "the record keeps the first root it saw");
            assertTrue(conflicted);
        }
        assertEq(verifier.conflictCount(), 3);
        assertEq(verifier.attestedCount(), count, "conflicts do not change the attested count");
        assertEq(verifier.highestHeight(), 10);

        // Heights below the rollback are unaffected.
        for (uint64 h = 0; h < 8; h++) assertTrue(verifier.isAttested(h, _anchor(h).stateRoot));

        // A third root for a conflicted height changes nothing more.
        assertFalse(verifier.attest(_reanchor(9, keccak256("a third root"), 0x55)));
        assertEq(verifier.conflictingRoot(9), keccak256(abi.encode("after rollback", uint64(9))));
        assertEq(verifier.conflictCount(), 3);

        // The first new height after the rollback attests normally.
        bytes32 next = keccak256("height 11");
        assertTrue(verifier.attest(_reanchor(11, next, 0x66)));
        assertTrue(verifier.isAttested(11, next));
        assertEq(verifier.highestHeight(), 11);
    }

    /// A rollback whose resubmission reproduces the same root at the same height (possible when the
    /// removed batch changed no state) is not a conflict.
    function test_ReanchoringTheSameRootIsNotAConflict() public {
        SettlementReceiptVerifier.Anchor memory a = _anchor(10);
        bytes32 root = a.stateRoot;
        SettlementReceiptVerifier.Anchor memory again = _reanchor(10, root, 0x77); // a fresh signature
        assertFalse(verifier.attest(again));
        assertTrue(verifier.isAttested(10, root));
        assertEq(verifier.conflictCount(), 0);
    }
}
