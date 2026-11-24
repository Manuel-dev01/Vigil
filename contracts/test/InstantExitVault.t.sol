// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InstantExitVault, ExitAddress} from "../src/InstantExitVault.sol";
import {MockPqcKeyStatus, MockPqcVerify} from "./mocks/PqcMocks.sol";

/// The signature check is the chain's pqcVerify precompile, which forge cannot run. A mock stands in that
/// accepts exactly the (key, signature, message) triples a test marks valid, so changing any byte of the
/// message, key or signature fails as the real check would. Real ML-DSA-87 signatures from the watchtower
/// keys are checked against the live precompile by scripts/exit/instant-exit.ts.
contract InstantExitVaultTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 constant WEI = 1e12; // per uqor

    MockPqcVerify pqc;
    MockPqcKeyStatus keys;
    InstantExitVault vault;

    address wt2 = makeAddr("watchtower-2");
    address wt3 = makeAddr("watchtower-3");
    address wt4 = makeAddr("watchtower-4");
    address lp = makeAddr("lp");
    address payout = makeAddr("payout");
    address relayer = makeAddr("anyone");

    function setUp() public {
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);
        pqc = MockPqcVerify(PQC_VERIFY);
        keys = MockPqcKeyStatus(PQC_KEY_STATUS);
        keys.set(wt2, true, 1, _key(2), true);
        keys.set(wt3, true, 1, _key(3), true);
        keys.set(wt4, true, 1, _key(4), true);
        keys.set(lp, true, 1, _key(9), true);

        vm.chainId(9800);
        vm.warp(1_795_460_000);
        address[] memory m = new address[](3);
        (m[0], m[1], m[2]) = (wt2, wt3, wt4);
        vault = new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 2, lp, 50);
        vm.deal(address(vault), 10 ether);
    }

    // ---------- helpers ----------

    function _key(uint256 seed) internal pure returns (bytes memory k) {
        k = new bytes(2592);
        for (uint256 i = 0; i < 32; i++) k[i] = bytes1(uint8(seed + i));
    }

    function _sig(uint256 seed) internal pure returns (bytes memory s) {
        s = new bytes(4627);
        for (uint256 i = 0; i < 32; i++) s[i] = bytes1(uint8(seed * 7 + i));
    }

    function _exit() internal view returns (InstantExitVault.Exit memory e) {
        e = InstantExitVault.Exit({
            batchIndex: 15,
            stateRoot: keccak256("root-15"),
            withdrawalIndex: 0,
            amountUqor: 100_000, // 0.1 QOR
            payout: payout,
            deadline: uint64(block.timestamp + 3000)
        });
    }

    /// Mark members' signatures valid over `e` and return the call arguments.
    function _signed(InstantExitVault.Exit memory e, uint256[] memory who)
        internal
        returns (uint256[] memory signers, bytes[] memory sigs)
    {
        bytes memory msg_ = vault.exitMessage(e);
        signers = who;
        sigs = new bytes[](who.length);
        for (uint256 k = 0; k < who.length; k++) {
            uint256 seed = who[k] + 2;
            sigs[k] = _sig(seed);
            pqc.markValid(_key(seed), sigs[k], msg_);
        }
    }

    function _pair(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    // ---------- the message ----------

    function test_exitMessageLayout() public view {
        InstantExitVault.Exit memory e = _exit();
        bytes memory expected = abi.encodePacked(
            "vigil/instant-exit/v1/exit",
            uint64(9800),
            address(vault),
            uint64(15),
            "qorechain-diana",
            uint64(11),
            "vigil-pay-1",
            e.batchIndex,
            e.stateRoot,
            e.withdrawalIndex,
            e.amountUqor,
            vault.exitAddressOf(e.payout),
            e.deadline
        );
        assertEq(vault.exitMessage(e), expected);
    }

    // ---------- fronting ----------

    function test_frontPaysPayoutLessFeeAndRecordsDebt() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        uint256 amount = 100_000 * WEI;
        uint256 fee = (amount * 50) / 10_000;
        vm.prank(relayer);
        vault.front(e, s, g);
        assertEq(payout.balance, amount - fee);
        assertEq(vault.owed(payout), amount);
        assertEq(vault.totalOwed(), amount);
        assertTrue(vault.fronted(vault.exitId(e)));
        assertEq(address(vault).balance, 10 ether - (amount - fee));
    }

    function test_anyTwoMembersSuffice() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 2));
        vault.front(e, s, g);
        assertGt(payout.balance, 0);
    }

    function test_refusesOneSigner() public {
        InstantExitVault.Exit memory e = _exit();
        uint256[] memory one = new uint256[](1);
        (uint256[] memory s, bytes[] memory g) = _signed(e, one);
        vm.expectRevert(InstantExitVault.NotEnoughSigners.selector);
        vault.front(e, s, g);
    }

    function test_refusesTheSameMemberTwice() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(1, 1));
        vm.expectRevert(InstantExitVault.SignersNotAscending.selector);
        vault.front(e, s, g);
    }

    function test_refusesTwice() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        vm.expectRevert(InstantExitVault.AlreadyFronted.selector);
        vault.front(e, s, g);
    }

    function test_refusesAfterDeadline() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vm.warp(e.deadline + 1);
        vm.expectRevert(InstantExitVault.Expired.selector);
        vault.front(e, s, g);
    }

    function test_signaturesBindEveryField() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        InstantExitVault.Exit[6] memory changed;
        for (uint256 i = 0; i < 6; i++) changed[i] = e;
        changed[0].batchIndex += 1;
        changed[1].stateRoot = keccak256("other");
        changed[2].withdrawalIndex += 1;
        changed[3].amountUqor += 1;
        changed[4].payout = relayer;
        changed[5].deadline += 1;
        for (uint256 i = 0; i < 6; i++) {
            vm.expectRevert(abi.encodeWithSelector(InstantExitVault.BadSignature.selector, 0));
            vault.front(changed[i], s, g);
        }
    }

    function test_refusesAMemberWithoutAUsableKey() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        keys.set(wt3, true, 1, _key(3), false); // no proof of possession
        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.KeyNotUsable.selector, wt3));
        vault.front(e, s, g);
    }

    function test_refusesWithoutLiquidity() public {
        InstantExitVault.Exit memory e = _exit();
        e.amountUqor = 20_000_000; // 20 QOR
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vm.expectRevert();
        vault.front(e, s, g);
        assertFalse(vault.fronted(vault.exitId(e)));
    }

    function test_aRolledBackBatchIndexIsAnotherExit() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        e.stateRoot = keccak256("root-15-after-rollback");
        (s, g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        assertEq(vault.owed(payout), 2 * 100_000 * WEI);
    }

    // ---------- exit addresses ----------

    function test_sweepRepaysTheVaultThenForwardsTheRest() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        uint256 afterFront = payout.balance;
        address ea = vault.exitAddressOf(payout);
        assertEq(ea.code.length, 0);
        // The chain pays the finalized withdrawal to the exit address (a bank send), plus 0.05 QOR more.
        vm.deal(ea, 150_000 * WEI);
        vm.prank(relayer);
        vault.sweep(payout);
        assertGt(ea.code.length, 0);
        assertEq(vault.owed(payout), 0);
        assertEq(vault.totalOwed(), 0);
        assertEq(payout.balance, afterFront + 50_000 * WEI);
        assertEq(ea.balance, 0);
        assertEq(ExitAddress(payable(ea)).payout(), payout);
    }

    function test_withoutFrontingTheUserGetsEverything() public {
        address ea = vault.exitAddressOf(payout);
        vm.deal(ea, 100_000 * WEI);
        vault.sweep(payout);
        assertEq(payout.balance, 100_000 * WEI);
        assertEq(address(vault).balance, 10 ether);
    }

    function test_partialRepaymentCarriesTheRest() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        address ea = vault.exitAddressOf(payout);
        vm.deal(ea, 40_000 * WEI);
        vault.sweep(payout);
        assertEq(vault.owed(payout), 60_000 * WEI);
        vm.deal(ea, 60_000 * WEI); // a second sweep through the deployed exit address
        vault.sweep(payout);
        assertEq(vault.owed(payout), 0);
    }

    function test_onlyTheExitAddressSettles() public {
        vm.deal(relayer, 1 ether);
        vm.prank(relayer);
        vm.expectRevert(InstantExitVault.NotExitAddress.selector);
        vault.settle{value: 1 ether}(payout);
    }

    function test_exitAddressesDifferPerPayoutAndVault() public {
        assertTrue(vault.exitAddressOf(payout) != vault.exitAddressOf(relayer));
        address[] memory m = new address[](1);
        m[0] = wt2;
        InstantExitVault other = new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 1, lp, 0);
        assertTrue(vault.exitAddressOf(payout) != other.exitAddressOf(payout));
    }

    // ---------- liquidity ----------

    function test_lpWithdrawsWithItsSignature() public {
        address to = makeAddr("lp-wallet");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory m = vault.withdrawMessage(to, 1 ether, 0, deadline);
        pqc.markValid(_key(9), _sig(9), m);
        vm.prank(relayer);
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, _sig(9));
        assertEq(to.balance, 1 ether);
        assertEq(vault.withdrawNonce(), 1);
        vm.expectRevert(InstantExitVault.BadNonce.selector);
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, _sig(9));
    }

    function test_aQuorumSignatureCannotWithdrawLiquidity() public {
        address to = makeAddr("thief");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory m = vault.withdrawMessage(to, 1 ether, 0, deadline);
        pqc.markValid(_key(2), _sig(2), m); // watchtower-2 signs it
        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.BadSignature.selector, type(uint256).max));
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, _sig(2));
    }

    // ---------- configuration ----------

    function test_constructorRefusesBadConfig() public {
        address[] memory m = new address[](2);
        (m[0], m[1]) = (wt2, wt3);
        vm.expectRevert(InstantExitVault.BadConfig.selector);
        new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 3, lp, 50); // threshold > members
        vm.expectRevert(InstantExitVault.BadConfig.selector);
        new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 0, lp, 50);
        vm.expectRevert(InstantExitVault.BadConfig.selector);
        new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 2, lp, 1001);
        m[1] = wt2;
        vm.expectRevert(InstantExitVault.BadConfig.selector);
        new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 2, lp, 50); // duplicate member
        vm.chainId(1);
        m[1] = wt3;
        vm.expectRevert(InstantExitVault.UnknownChain.selector);
        new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 2, lp, 50);
    }
}
