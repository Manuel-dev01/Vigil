// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PQGuardVault} from "../src/PQGuardVault.sol";
import {MockPqcKeyStatus, MockPqcVerify} from "./mocks/PqcMocks.sol";
import {
    TogglePayout, FalseToken, NoReturnToken, RawReturnToken, RevertingToken
} from "./mocks/TestActors.sol";

/// How PQGuardVault.release treats tokens that do not behave like a plain ERC-20, and native transfers that
/// fail. The rule in the contract: a token transfer counts only if the call succeeds and either returns
/// nothing from an address that has code, or returns a word that decodes to true. A failed release never
/// consumes the nonce, so the same signature can be submitted again.
contract PQGuardVaultTokensTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    PQGuardVault vault;
    MockPqcVerify verifier;
    MockPqcKeyStatus keys;
    address guardian = makeAddr("guardian");
    address payable recipient = payable(makeAddr("recipient"));
    bytes pubkey;
    uint256 deadline;

    function setUp() public {
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);
        verifier = MockPqcVerify(PQC_VERIFY);
        keys = MockPqcKeyStatus(PQC_KEY_STATUS);
        pubkey = new bytes(2592);
        pubkey[0] = 0x11;
        keys.set(guardian, true, 1, pubkey, true);
        vault = new PQGuardVault(guardian);
        vm.deal(address(vault), 10 ether);
        vm.warp(1_800_000_000);
        deadline = block.timestamp + 1 hours;
    }

    function _sign(address tok, address to, uint256 amount) internal returns (bytes memory sig) {
        sig = new bytes(4627);
        sig[0] = bytes1(uint8(vault.nonce() + 7));
        verifier.markValid(pubkey, sig, vault.releaseMessage(tok, to, amount, deadline, vault.nonce()));
    }

    function _release(address tok, uint256 amount, bytes memory sig) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(vault).call(
            abi.encodeCall(PQGuardVault.release, (tok, recipient, amount, deadline, sig))
        );
    }

    // ---------- tokens that report failure ----------

    function test_TokenReturningFalseReverts_NonceKept() public {
        FalseToken t = new FalseToken();
        bytes memory sig = _sign(address(t), recipient, 1);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(address(t), recipient, 1, deadline, sig);
        assertEq(vault.nonce(), 0);
        assertTrue(vault.isValidRelease(address(t), recipient, 1, deadline, sig), "the signature stays usable");
    }

    function test_TokenThatRevertsReverts() public {
        RevertingToken t = new RevertingToken();
        bytes memory sig = _sign(address(t), recipient, 1);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(address(t), recipient, 1, deadline, sig);
        assertEq(vault.nonce(), 0);
    }

    function test_TokenWithoutEnoughBalanceReverts() public {
        NoReturnToken t = new NoReturnToken();
        bytes memory sig = _sign(address(t), recipient, 1);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(address(t), recipient, 1, deadline, sig);
    }

    // ---------- a "token" with no code ----------

    /// A call to an address with no code succeeds with empty data. The vault must not read that as a
    /// successful transfer.
    function test_TokenAddressWithNoCodeReverts() public {
        address notAToken = makeAddr("no-code");
        bytes memory sig = _sign(notAToken, recipient, 1);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(notAToken, recipient, 1, deadline, sig);
        assertEq(vault.nonce(), 0);
    }

    // ---------- non-standard return data ----------

    function test_TokenReturningNothingIsAccepted() public {
        NoReturnToken t = new NoReturnToken();
        t.mint(address(vault), 100);
        bytes memory sig = _sign(address(t), recipient, 40);
        vault.release(address(t), recipient, 40, deadline, sig);
        assertEq(t.balanceOf(recipient), 40);
        assertEq(t.balanceOf(address(vault)), 60);
        assertEq(vault.nonce(), 1);
    }

    function test_TokenReturningAWordTrueIsAccepted() public {
        RawReturnToken t = new RawReturnToken();
        t.mint(address(vault), 100);
        t.setAnswer(abi.encode(true));
        vault.release(address(t), recipient, 10, deadline, _sign(address(t), recipient, 10));
        assertEq(t.balanceOf(recipient), 10);
    }

    function test_TokenReturningAWordFalseReverts() public {
        RawReturnToken t = new RawReturnToken();
        t.mint(address(vault), 100);
        t.setAnswer(abi.encode(false));
        bytes memory sig = _sign(address(t), recipient, 10);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(address(t), recipient, 10, deadline, sig);
        assertEq(t.balanceOf(recipient), 0, "the token's own transfer is undone with the revert");
    }

    /// More than one word: only the first is read (abi.decode ignores trailing bytes).
    function test_TokenReturningTrueAndTrailingBytesIsAccepted() public {
        RawReturnToken t = new RawReturnToken();
        t.mint(address(vault), 100);
        t.setAnswer(abi.encode(true, uint256(0xdead)));
        vault.release(address(t), recipient, 10, deadline, _sign(address(t), recipient, 10));
        assertEq(t.balanceOf(recipient), 10);
        assertEq(vault.nonce(), 1);
    }

    /// Return data that is not a valid ABI bool (shorter than a word, or a word other than 0 or 1) makes
    /// abi.decode revert inside release: the release fails, as it should, but with empty revert data rather
    /// than TransferFailed. Clients should treat an empty revert from release like TransferFailed.
    function test_TokenReturningMalformedDataRevertsWithoutAReason() public {
        RawReturnToken t = new RawReturnToken();
        t.mint(address(vault), 100);
        bytes memory sig = _sign(address(t), recipient, 10);

        bytes[3] memory answers = [bytes(hex"01"), abi.encode(uint256(2)), abi.encode(type(uint256).max)];
        for (uint256 i = 0; i < answers.length; i++) {
            t.setAnswer(answers[i]);
            (bool ok, bytes memory ret) = _release(address(t), 10, sig);
            assertFalse(ok, "malformed answer accepted");
            assertEq(ret.length, 0, "reverts without a reason");
        }
        assertEq(t.balanceOf(recipient), 0);
        assertEq(vault.nonce(), 0);
    }

    // ---------- native coin ----------

    function test_NativeReleaseToARefusingRecipientReverts_NonceKept() public {
        TogglePayout r = new TogglePayout(false);
        bytes memory sig = _sign(address(0), address(r), 1 ether);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(address(0), payable(address(r)), 1 ether, deadline, sig);
        assertEq(vault.nonce(), 0);
        r.setAccept(true);
        vault.release(address(0), payable(address(r)), 1 ether, deadline, sig);
        assertEq(address(r).balance, 1 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_NativeReleaseAboveTheBalanceReverts() public {
        bytes memory sig = _sign(address(0), recipient, 10 ether + 1);
        vm.expectRevert(PQGuardVault.TransferFailed.selector);
        vault.release(address(0), recipient, 10 ether + 1, deadline, sig);
        assertEq(vault.nonce(), 0);
        assertEq(address(vault).balance, 10 ether);
    }

    function test_ReleaseEmitsAndDepositEmits() public {
        bytes memory sig = _sign(address(0), recipient, 1 ether);
        vm.expectEmit(true, true, true, true, address(vault));
        emit PQGuardVault.Released(0, address(0), recipient, 1 ether);
        vault.release(address(0), recipient, 1 ether, deadline, sig);

        vm.deal(address(this), 1 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit PQGuardVault.Deposited(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
    }
}
