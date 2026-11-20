// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettlementReceiptVerifier} from "../src/SettlementReceiptVerifier.sol";
import {MockPqcKeyStatus, MockPqcVerify} from "./mocks/PqcMocks.sol";

/// Tests against vigil-pay-1's real anchors (test/vectors/anchors-vigil-pay-1.json, recorded from
/// qorechain-diana). The signature check itself is the chain's pqcVerify precompile, which forge
/// cannot run, so a mock stands in that accepts exactly the (key, signature, message) triples a test
/// marks valid. The real signatures are checked against the live precompile by
/// scripts/evm/receipt-verifier.ts (simulate step) and, after deployment, on chain.
contract SettlementReceiptVerifierTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    SettlementReceiptVerifier verifier;
    MockPqcVerify pqc;
    MockPqcKeyStatus keys;

    string json;
    address creator;
    bytes creatorKey;
    uint256 count;
    address relayer = makeAddr("anyone");

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
    }

    // ---------- helpers ----------

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

    function _signBytes(uint256 i) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, _key(i, "signBytes"));
    }

    /// Tell the mock precompile that the creator's key signed exactly this anchor's message.
    function _markSigned(SettlementReceiptVerifier.Anchor memory a) internal {
        pqc.markValid(creatorKey, a.signature, verifier.anchorMessage(a));
    }

    function _markAllRealAnchors() internal {
        for (uint256 i = 0; i < count; i++) pqc.markValid(creatorKey, _anchor(i).signature, _signBytes(i));
    }

    // ---------- the message ----------

    function test_RecordedVectorsCoverEveryAnchor() public view {
        assertEq(count, 11, "vigil-pay-1 had 11 anchors (layer heights 0-10) when the vectors were recorded");
        for (uint256 i = 0; i < count; i++) assertEq(_anchor(i).layerHeight, i);
    }

    function test_AnchorMessageMatchesTheChainFormatByteForByte() public view {
        for (uint256 i = 0; i < count; i++) {
            assertEq(verifier.anchorMessage(_anchor(i)), _signBytes(i), string.concat("anchor ", vm.toString(i)));
        }
    }

    function test_EverySignedFieldChangesTheMessage() public view {
        SettlementReceiptVerifier.Anchor memory a = _anchor(3);
        bytes32 base = keccak256(verifier.anchorMessage(a));
        SettlementReceiptVerifier.Anchor memory b = _anchor(3);
        b.layerHeight += 1;
        assertTrue(keccak256(verifier.anchorMessage(b)) != base, "layer height");
        b = _anchor(3);
        b.stateRoot = bytes32(uint256(b.stateRoot) ^ 1);
        assertTrue(keccak256(verifier.anchorMessage(b)) != base, "state root");
        b = _anchor(3);
        b.validatorSetHash = hex"00";
        assertTrue(keccak256(verifier.anchorMessage(b)) != base, "validator-set hash");
        b = _anchor(3);
        b.transactionCount += 1;
        assertTrue(keccak256(verifier.anchorMessage(b)) != base, "transaction count");
        b = _anchor(3);
        b.compressedStateProof = hex"01";
        assertTrue(keccak256(verifier.anchorMessage(b)) != base, "compressed state proof");
    }

    function test_ChainAndLayerAreBoundIntoTheMessage() public {
        SettlementReceiptVerifier other = new SettlementReceiptVerifier(creator, "qorechain-diana", "vigil-pay-2");
        assertTrue(keccak256(other.anchorMessage(_anchor(0))) != keccak256(_signBytes(0)));
    }

    // ---------- checking ----------

    function test_AllRealAnchorsCheckValid() public {
        _markAllRealAnchors();
        for (uint256 i = 0; i < count; i++) {
            assertEq(uint8(verifier.check(_anchor(i))), uint8(SettlementReceiptVerifier.Result.Valid));
        }
    }

    function test_ReplayingASignatureAtAnotherHeightFails() public {
        _markAllRealAnchors();
        // Batches 4, 5 and 6 share one state root. Each anchor's signature covers its own layer
        // height, so batch 4's signature cannot stand in for batch 5.
        SettlementReceiptVerifier.Anchor memory a = _anchor(5);
        a.signature = _anchor(4).signature;
        assertEq(a.stateRoot, _anchor(4).stateRoot);
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.BadSignature));
    }

    function test_ForgedRootFails() public {
        _markAllRealAnchors();
        SettlementReceiptVerifier.Anchor memory a = _anchor(2);
        a.stateRoot = bytes32(uint256(a.stateRoot) ^ (1 << 255));
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.BadSignature));
    }

    function test_WrongSignatureLength() public {
        SettlementReceiptVerifier.Anchor memory a = _anchor(0);
        a.signature = hex"00";
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.BadSignatureLength));
    }

    function test_KeyMustBeRegisteredMlDsa87WithPossessionProven() public {
        _markAllRealAnchors();
        SettlementReceiptVerifier.Anchor memory a = _anchor(0);
        keys.set(creator, false, 1, creatorKey, true);
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.KeyNotUsable), "unregistered");
        keys.set(creator, true, 2, creatorKey, true);
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.KeyNotUsable), "other algorithm");
        keys.set(creator, true, 1, creatorKey, false);
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.KeyNotUsable), "no possession proof");
        keys.set(creator, true, 1, hex"1234", true);
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.KeyNotUsable), "wrong length");
        keys.set(creator, true, 1, creatorKey, true);
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.Valid));
    }

    function test_AnotherAccountsKeyIsNotTheCreators() public {
        // A signature by some other registered key over the same message does not count.
        SettlementReceiptVerifier.Anchor memory a = _anchor(0);
        bytes memory otherKey = new bytes(2592);
        otherKey[0] = 0x42;
        pqc.markValid(otherKey, a.signature, verifier.anchorMessage(a));
        assertEq(uint8(verifier.check(a)), uint8(SettlementReceiptVerifier.Result.BadSignature));
    }

    function test_InactivePrecompilesAreNeverReadAsAnAnswer() public {
        SettlementReceiptVerifier.Anchor memory a = _anchor(0);
        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(SettlementReceiptVerifier.PrecompileUnavailable.selector);
        verifier.check(a);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);
        keys.set(creator, true, 1, creatorKey, true);
        vm.etch(PQC_VERIFY, "");
        vm.expectRevert(SettlementReceiptVerifier.PrecompileUnavailable.selector);
        verifier.check(a);
    }

    // ---------- recording ----------

    function test_AttestRecordsEveryRealAnchor() public {
        _markAllRealAnchors();
        vm.warp(1_795_200_000);
        for (uint256 i = 0; i < count; i++) {
            SettlementReceiptVerifier.Anchor memory a = _anchor(i);
            vm.expectEmit(true, true, true, false);
            emit SettlementReceiptVerifier.Attested(a.layerHeight, a.stateRoot, relayer);
            vm.prank(relayer);
            assertTrue(verifier.attest(a));
            assertTrue(verifier.isAttested(a.layerHeight, a.stateRoot));
            (bytes32 root, uint64 at, uint64 blockNo, bool conflicted) = verifier.records(a.layerHeight);
            assertEq(root, a.stateRoot);
            assertEq(at, 1_795_200_000);
            assertEq(blockNo, block.number);
            assertFalse(conflicted);
        }
        assertEq(verifier.attestedCount(), count);
        assertEq(verifier.highestHeight(), count - 1);
        assertEq(verifier.conflictCount(), 0, "shared roots across heights are not conflicts");
    }

    function test_AttestManyAndRepeatsAreHarmless() public {
        _markAllRealAnchors();
        SettlementReceiptVerifier.Anchor[] memory all = new SettlementReceiptVerifier.Anchor[](count);
        for (uint256 i = 0; i < count; i++) all[i] = _anchor(i);
        assertEq(verifier.attestMany(all), count);
        assertEq(verifier.attestMany(all), 0, "a second pass records nothing");
        assertEq(verifier.attestedCount(), count);
    }

    function test_AttestRevertsOnAnInvalidAnchor() public {
        SettlementReceiptVerifier.Anchor memory a = _anchor(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementReceiptVerifier.InvalidAnchor.selector, SettlementReceiptVerifier.Result.BadSignature
            )
        );
        verifier.attest(a);
        assertEq(verifier.attestedCount(), 0);
    }

    function test_TwoSignedRootsForOneHeightMarkItConflictedForGood() public {
        _markAllRealAnchors();
        SettlementReceiptVerifier.Anchor memory honest = _anchor(7);
        assertTrue(verifier.attest(honest));

        // Suppose the creator's key also signed another root for height 7.
        SettlementReceiptVerifier.Anchor memory other = _anchor(7);
        other.stateRoot = keccak256("another root");
        other.signature[0] = bytes1(uint8(other.signature[0]) ^ 1);
        _markSigned(other);

        vm.expectEmit(true, false, false, true);
        emit SettlementReceiptVerifier.Conflict(7, honest.stateRoot, other.stateRoot, address(this));
        assertFalse(verifier.attest(other));

        assertFalse(verifier.isAttested(7, honest.stateRoot), "neither root is reported once conflicted");
        assertFalse(verifier.isAttested(7, other.stateRoot));
        assertEq(verifier.conflictingRoot(7), other.stateRoot);
        assertEq(verifier.conflictCount(), 1);
        // Re-sending either anchor changes nothing.
        assertFalse(verifier.attest(honest));
        assertFalse(verifier.attest(other));
        assertEq(verifier.conflictCount(), 1);
        (,,, bool conflicted) = verifier.records(7);
        assertTrue(conflicted);
    }

    function test_AnUnsignedRootCannotCauseAConflict() public {
        _markAllRealAnchors();
        assertTrue(verifier.attest(_anchor(7)));
        SettlementReceiptVerifier.Anchor memory forged = _anchor(7);
        forged.stateRoot = keccak256("forged");
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementReceiptVerifier.InvalidAnchor.selector, SettlementReceiptVerifier.Result.BadSignature
            )
        );
        verifier.attest(forged);
        assertTrue(verifier.isAttested(7, _anchor(7).stateRoot));
    }

    // ---------- deployment ----------

    function test_ConfigIsFixed() public view {
        assertEq(verifier.creator(), creator);
        assertEq(verifier.chainId(), "qorechain-diana");
        assertEq(verifier.layerId(), "vigil-pay-1");
        assertEq(verifier.evmChainId(), 9800);
    }

    function test_RefusesAChainIdThatDoesNotMatchTheEvmChain() public {
        vm.expectRevert(SettlementReceiptVerifier.UnknownChain.selector);
        new SettlementReceiptVerifier(creator, "qorechain-vladi", "vigil-pay-1");
        vm.chainId(1);
        vm.expectRevert(SettlementReceiptVerifier.UnknownChain.selector);
        new SettlementReceiptVerifier(creator, "qorechain-diana", "vigil-pay-1");
        vm.chainId(9801);
        new SettlementReceiptVerifier(creator, "qorechain-vladi", "vigil-pay-1");
    }

    function test_RefusesZeroCreatorAndEmptyLayer() public {
        vm.expectRevert(SettlementReceiptVerifier.ZeroCreator.selector);
        new SettlementReceiptVerifier(address(0), "qorechain-diana", "vigil-pay-1");
        vm.expectRevert(SettlementReceiptVerifier.UnknownChain.selector);
        new SettlementReceiptVerifier(creator, "qorechain-diana", "");
    }
}
