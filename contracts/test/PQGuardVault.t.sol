// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PQGuardVault} from "../src/PQGuardVault.sol";
import {MockPqcKeyStatus, MockPqcVerify, MockToken} from "./mocks/PqcMocks.sol";

contract PQGuardVaultTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    PQGuardVault vault;
    MockToken token;
    MockPqcVerify verifier;
    MockPqcKeyStatus keys;

    // The guardian is an ordinary account with a classical key: in the drill the attacker holds it.
    uint256 guardianEcdsaKey = 0xA11CE;
    address guardian;
    address attacker = makeAddr("attacker");
    address payable recipient = payable(makeAddr("recipient"));

    bytes pubkey;
    uint256 constant FUNDS = 50 ether;

    function setUp() public {
        guardian = vm.addr(guardianEcdsaKey);
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);
        verifier = MockPqcVerify(PQC_VERIFY);
        keys = MockPqcKeyStatus(PQC_KEY_STATUS);

        pubkey = _bytes(2592, 0x11);
        keys.set(guardian, true, 1, pubkey, true);

        vault = new PQGuardVault(guardian);
        token = new MockToken();
        vm.deal(address(vault), FUNDS);
        token.mint(address(vault), 1_000e6);
        vm.warp(1_800_000_000);
    }

    // ---------- helpers ----------

    function _bytes(uint256 n, uint8 fill) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i = 0; i < n; i++) b[i] = bytes1(fill);
    }

    /// A "signature" the mock accepts for exactly this release message at the vault's current nonce.
    function _sign(address tok, address to, uint256 amount, uint256 deadline) internal returns (bytes memory sig) {
        sig = _bytes(4627, uint8(vault.nonce() + 7));
        verifier.markValid(pubkey, sig, vault.releaseMessage(tok, to, amount, deadline, vault.nonce()));
    }

    // ---------- the authorised path ----------

    function test_ReleaseNativeWithPqSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 5 ether, deadline);
        assertTrue(vault.isValidRelease(address(0), recipient, 5 ether, deadline, sig));

        vm.prank(attacker); // anyone may relay a signed release; the signature is the authority
        vault.release(address(0), recipient, 5 ether, deadline, sig);

        assertEq(recipient.balance, 5 ether);
        assertEq(address(vault).balance, FUNDS - 5 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_ReleaseTokenWithPqSignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(token), recipient, 250e6, deadline);
        vault.release(address(token), recipient, 250e6, deadline, sig);
        assertEq(token.balanceOf(recipient), 250e6);
    }

    function test_MessageLayoutIsDomainSeparatedAndBound() public view {
        bytes memory m = vault.releaseMessage(address(token), recipient, 7, 99, 3);
        assertEq(m.length, 16 + 32 + 20 + 32 + 20 + 20 + 32 + 32);
        bytes16 tag;
        assembly {
            tag := mload(add(m, 32))
        }
        assertEq(tag, bytes16("vigil/pqguard/v1"));
        assertEq(m, abi.encodePacked(bytes16("vigil/pqguard/v1"), block.chainid, address(vault), uint256(3), address(token), address(recipient), uint256(7), uint256(99)));
    }

    // ---------- ECDSA-only attacks (what the Q-Day Drill bot can do) ----------

    function test_GuardianEcdsaKeyAloneCannotRelease() public {
        uint256 deadline = block.timestamp + 1 hours;
        vm.prank(guardian); // the attacker controls the guardian's classical key
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), payable(attacker), FUNDS, deadline, _bytes(4627, 0x42));
        assertEq(address(vault).balance, FUNDS);
    }

    function test_EcdsaSignatureInPlaceOfPqSignatureFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(vault.releaseMessage(address(0), attacker, FUNDS, deadline, 0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianEcdsaKey, digest);
        bytes memory ecdsaSig = abi.encodePacked(r, s, v);

        vm.prank(guardian);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), payable(attacker), FUNDS, deadline, ecdsaSig);
        assertEq(address(vault).balance, FUNDS);
    }

    function testFuzz_NoCallFromTheGuardianCanDrainWithoutPqSignature(bytes calldata data, uint96 value) public {
        vm.deal(guardian, uint256(value));
        uint256 tokensBefore = token.balanceOf(address(vault));
        vm.prank(guardian);
        (bool ok,) = address(vault).call{value: value}(data);
        ok; // reverting or not, nothing may leave the vault
        assertGe(address(vault).balance, FUNDS);
        assertEq(token.balanceOf(address(vault)), tokensBefore);
        assertEq(vault.nonce(), 0);
    }

    function testFuzz_AnyCallerAnyGarbageSignatureFails(address caller, bytes calldata sig, uint256 amount) public {
        vm.assume(caller != address(vault));
        amount = bound(amount, 1, FUNDS);
        vm.prank(caller);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), payable(caller), amount, block.timestamp + 1, sig);
    }

    function test_TokenApprovalsAndTransfersByGuardianMoveNothing() public {
        // An attacker with the classical key can make the guardian approve or transfer its OWN tokens,
        // but the vault holds no allowance logic and never acts for msg.sender.
        vm.startPrank(guardian);
        token.approve(attacker, type(uint256).max);
        vm.expectRevert(bytes("balance"));
        token.transfer(attacker, 1);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 1_000e6);
    }

    // ---------- binding and replay ----------

    function test_ReplayFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_RedirectedRecipientOrAmountFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), payable(attacker), 1 ether, deadline, sig);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), recipient, 2 ether, deadline, sig);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(token), recipient, 1 ether, deadline, sig);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), recipient, 1 ether, deadline + 1, sig);
    }

    function test_SignatureForAnotherVaultFails() public {
        PQGuardVault other = new PQGuardVault(guardian);
        vm.deal(address(other), FUNDS);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline); // signed for `vault`
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        other.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_SignatureForAnotherChainFails() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline); // chain 31337
        vm.chainId(9800);
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_ExpiredFails() public {
        uint256 deadline = block.timestamp + 10;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);
        vm.warp(deadline + 1);
        assertFalse(vault.isValidRelease(address(0), recipient, 1 ether, deadline, sig));
        vm.expectRevert(PQGuardVault.Expired.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_WrongSignatureLengthFails() public {
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), recipient, 1 ether, block.timestamp + 1, _bytes(4626, 1));
    }

    // ---------- key status ----------

    function test_KeyWithoutProofOfPossessionIsRefused() public {
        keys.set(guardian, true, 1, pubkey, false);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);
        vm.expectRevert(PQGuardVault.KeyNotUsable.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_UnregisteredOrWrongAlgorithmKeyIsRefused() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);

        keys.set(guardian, false, 0, "", false);
        vm.expectRevert(PQGuardVault.KeyNotUsable.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);

        keys.set(guardian, true, 2, pubkey, true);
        vm.expectRevert(PQGuardVault.KeyNotUsable.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);

        keys.set(guardian, true, 1, _bytes(1312, 0x11), true);
        vm.expectRevert(PQGuardVault.KeyNotUsable.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_RotatedKeyInvalidatesOldSignatures() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);
        keys.set(guardian, true, 1, _bytes(2592, 0x22), true); // the guardian rotated its PQ key
        vm.expectRevert(PQGuardVault.BadSignature.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    // ---------- inactive precompiles ----------

    function test_InactiveVerifyPrecompileIsNeverReadAsSuccess() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(address(0), recipient, 1 ether, deadline);
        vm.etch(PQC_VERIFY, ""); // a call to an empty account succeeds with empty data
        vm.expectRevert(PQGuardVault.PrecompileUnavailable.selector);
        vault.release(address(0), recipient, 1 ether, deadline, sig);
    }

    function test_InactiveKeyStatusPrecompileIsNeverReadAsSuccess() public {
        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(PQGuardVault.PrecompileUnavailable.selector);
        vault.guardianKey();
    }

    function test_ZeroGuardianRejected() public {
        vm.expectRevert(PQGuardVault.ZeroGuardian.selector);
        new PQGuardVault(address(0));
    }

    function test_NoOwnerSurface() public view {
        // The only state-changing entry points are release() and receive(). There is no owner,
        // admin, pause, upgrade, sweep or rescue function to call with a classical key.
        (bool ok,) = address(vault).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
    }
}
