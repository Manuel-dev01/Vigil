// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {stdError} from "forge-std/StdError.sol";
import {InstantExitVault, ExitAddress} from "../src/InstantExitVault.sol";
import {ExitVaultFixture} from "./helpers/ExitVaultFixture.sol";
import {
    TogglePayout, Reenterer, RevertingPrecompile, ShortAnswerPrecompile
} from "./mocks/TestActors.sol";

/// Edge cases of InstantExitVault and ExitAddress that InstantExitVault.t.sol does not cover: unavailable
/// precompiles, payouts and recipients that refuse money or call back in, every input check of `front`,
/// liquidity withdrawals that fail, fee arithmetic at the extremes, key rotation, and the two behaviours
/// documented as known limitations (an out-of-range signer index panics; one withdrawal can be fronted
/// once per state root it is attested under).
contract InstantExitVaultEdgesTest is ExitVaultFixture {
    uint256 constant AMOUNT = 100_000 * WEI; // _exit().amountUqor in wei
    uint256 constant FEE = (AMOUNT * FEE_BPS) / 10_000;
    uint256 constant PAY = AMOUNT - FEE;

    // =====================================================================================================
    // Precompiles: an inactive precompile answers with success and empty data; never read that as an answer.
    // =====================================================================================================

    function test_inactiveKeyStatusPrecompile_frontAndViewsRevert() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vm.etch(PQC_KEY_STATUS, "");

        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.front(e, s, g);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.verifyExit(e, s, g);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.keyOf(wt2);

        assertFalse(vault.fronted(vault.exitId(e)));
        assertEq(payout.balance, 0);
        assertEq(vault.totalOwed(), 0);
    }

    function test_inactiveVerifyPrecompile_frontReverts() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vm.etch(PQC_VERIFY, "");

        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.front(e, s, g);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.verifyExit(e, s, g);
        assertFalse(vault.fronted(vault.exitId(e)));
        assertEq(payout.balance, 0);
    }

    function test_inactivePrecompiles_withdrawLiquidityReverts() public {
        address to = makeAddr("lp-wallet");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _lpSigned(to, 1 ether, 0, deadline);

        vm.etch(PQC_VERIFY, "");
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, sig);

        vm.etch(PQC_KEY_STATUS, "");
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, sig);

        assertEq(vault.withdrawNonce(), 0);
        assertEq(to.balance, 0);
    }

    function test_revertingOrMalformedPrecompileIsUnavailable() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));

        vm.etch(PQC_VERIFY, type(RevertingPrecompile).runtimeCode);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.front(e, s, g);

        vm.etch(PQC_VERIFY, type(ShortAnswerPrecompile).runtimeCode);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.front(e, s, g);

        vm.etch(PQC_KEY_STATUS, type(RevertingPrecompile).runtimeCode);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.keyOf(wt2);

        vm.etch(PQC_KEY_STATUS, type(ShortAnswerPrecompile).runtimeCode);
        vm.expectRevert(InstantExitVault.PrecompileUnavailable.selector);
        vault.keyOf(wt2);
    }

    // =====================================================================================================
    // Payouts that refuse money
    // =====================================================================================================

    function test_frontToAPayoutThatRefusesEthRevertsAndChangesNothing() public {
        TogglePayout p = new TogglePayout(false);
        InstantExitVault.Exit memory e = _exitFor(address(p));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));

        vm.expectRevert(InstantExitVault.TransferFailed.selector);
        vault.front(e, s, g);
        assertFalse(vault.fronted(vault.exitId(e)));
        assertEq(vault.owed(address(p)), 0);
        assertEq(vault.totalOwed(), 0);
        assertEq(address(vault).balance, LIQUIDITY);

        // The same signatures front it once the payout accepts.
        p.setAccept(true);
        vault.front(e, s, g);
        assertEq(address(p).balance, PAY);
        assertEq(vault.owed(address(p)), AMOUNT);
    }

    function test_sweepToARefusingPayoutRepaysTheVaultAndKeepsTheRestForALaterSweep() public {
        TogglePayout p = new TogglePayout(true);
        InstantExitVault.Exit memory e = _exitFor(address(p));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);

        p.setAccept(false);
        address ea = vault.exitAddressOf(address(p));
        uint256 extra = 30_000 * WEI;
        vm.deal(ea, AMOUNT + extra); // L1 pays the finalized withdrawal plus something more
        uint256 vaultBefore = address(vault).balance;

        vault.sweep(address(p)); // does not revert: the refused forward is swallowed
        assertEq(vault.owed(address(p)), 0);
        assertEq(vault.totalOwed(), 0);
        assertEq(address(vault).balance, vaultBefore + AMOUNT, "the vault is repaid first");
        assertEq(ea.balance, extra, "the rest stays in the exit address");
        assertEq(address(p).balance, PAY);

        // A second sweep while it still refuses changes nothing.
        vault.sweep(address(p));
        assertEq(ea.balance, extra);

        p.setAccept(true);
        ExitAddress(payable(ea)).sweep(); // anyone may sweep the exit address directly
        assertEq(ea.balance, 0);
        assertEq(address(p).balance, PAY + extra);
        assertEq(address(vault).balance, vaultBefore + AMOUNT, "the vault takes nothing more");
    }

    // =====================================================================================================
    // Reentrancy: the payout (front, sweep) or `to` (withdrawLiquidity) calling back in while being paid
    // =====================================================================================================

    function test_payoutReenteringFrontWithTheSameExitIsRefused() public {
        Reenterer r = new Reenterer();
        InstantExitVault.Exit memory e = _exitFor(address(r));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        r.arm(address(vault), abi.encodeCall(InstantExitVault.front, (e, s, g)));

        vault.front(e, s, g);
        assertTrue(r.attempted());
        assertFalse(r.innerOk());
        assertEq(r.innerRet(), abi.encodeWithSelector(InstantExitVault.AlreadyFronted.selector));
        assertEq(address(r).balance, PAY, "paid once");
        assertEq(vault.owed(address(r)), AMOUNT);
        assertEq(vault.totalOwed(), AMOUNT);
    }

    function test_payoutReenteringSweepDuringFrontRepaysTheNewDebtFirst() public {
        // Suppose L1 has already paid the exit address when the exit is fronted (the deadline exists to
        // prevent this). The debt is recorded before the payout is paid, so a reentrant sweep repays it.
        Reenterer r = new Reenterer();
        InstantExitVault.Exit memory e = _exitFor(address(r));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        address ea = vault.exitAddressOf(address(r));
        vm.deal(ea, AMOUNT);
        r.arm(address(vault), abi.encodeCall(InstantExitVault.sweep, (address(r))));

        vault.front(e, s, g);
        assertTrue(r.innerOk());
        assertEq(vault.owed(address(r)), 0);
        assertEq(vault.totalOwed(), 0);
        assertEq(ea.balance, 0);
        assertEq(address(r).balance, PAY, "nothing forwarded beyond the fronted payment");
        assertEq(address(vault).balance, LIQUIDITY + FEE);
    }

    function test_payoutReenteringSweepDuringSweepPaysOnce() public {
        Reenterer r = new Reenterer();
        InstantExitVault.Exit memory e = _exitFor(address(r));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);

        address ea = vault.exitAddressOf(address(r));
        uint256 extra = 25_000 * WEI;
        vm.deal(ea, AMOUNT + extra);
        r.arm(address(vault), abi.encodeCall(InstantExitVault.sweep, (address(r))));

        vault.sweep(address(r));
        assertTrue(r.attempted());
        assertTrue(r.innerOk(), "the inner sweep is a harmless no-op");
        assertEq(address(r).balance, PAY + extra);
        assertEq(ea.balance, 0);
        assertEq(vault.owed(address(r)), 0);
        assertEq(address(vault).balance, LIQUIDITY + FEE);
    }

    function test_payoutReenteringExitAddressSweepDirectlyPaysOnce() public {
        Reenterer r = new Reenterer();
        address ea = vault.exitAddressOf(address(r));
        vault.sweep(address(r)); // deploy the exit address
        vm.deal(ea, 1 ether);
        r.arm(ea, abi.encodeCall(ExitAddress.sweep, ()));

        ExitAddress(payable(ea)).sweep();
        assertTrue(r.innerOk());
        assertEq(address(r).balance, 1 ether);
        assertEq(r.received(), 1 ether);
        assertEq(ea.balance, 0);
    }

    function test_payoutReenteringWithdrawLiquidityStillNeedsTheLpSignature() public {
        Reenterer r = new Reenterer();
        InstantExitVault.Exit memory e = _exitFor(address(r));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        uint64 deadline = uint64(block.timestamp + 600);
        r.arm(
            address(vault),
            abi.encodeCall(InstantExitVault.withdrawLiquidity, (address(r), 1 ether, 0, deadline, g[0]))
        );

        vault.front(e, s, g);
        assertFalse(r.innerOk());
        assertEq(
            r.innerRet(), abi.encodeWithSelector(InstantExitVault.BadSignature.selector, type(uint256).max)
        );
        assertEq(vault.withdrawNonce(), 0);
        assertEq(address(r).balance, PAY);
    }

    function test_toReenteringWithdrawLiquidityCannotReplayTheSignature() public {
        Reenterer r = new Reenterer();
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _lpSigned(address(r), 1 ether, 0, deadline);
        r.arm(
            address(vault), abi.encodeCall(InstantExitVault.withdrawLiquidity, (address(r), 1 ether, 0, deadline, sig))
        );

        vault.withdrawLiquidity(address(r), 1 ether, 0, deadline, sig);
        assertFalse(r.innerOk());
        assertEq(r.innerRet(), abi.encodeWithSelector(InstantExitVault.BadNonce.selector));
        assertEq(address(r).balance, 1 ether);
        assertEq(vault.withdrawNonce(), 1);
        assertEq(address(vault).balance, LIQUIDITY - 1 ether);
    }

    function test_toReenteringFrontSeesTheLiquidityAlreadyGone() public {
        Reenterer r = new Reenterer();
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        uint256 left = 50_000 * WEI; // less than the exit pays
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _lpSigned(address(r), LIQUIDITY - left, 0, deadline);
        r.arm(address(vault), abi.encodeCall(InstantExitVault.front, (e, s, g)));

        vault.withdrawLiquidity(address(r), LIQUIDITY - left, 0, deadline, sig);
        assertFalse(r.innerOk());
        assertEq(r.innerRet(), abi.encodeWithSelector(InstantExitVault.NotEnoughLiquidity.selector, left, PAY));
        assertFalse(vault.fronted(vault.exitId(e)));
        assertEq(address(vault).balance, left);
    }

    function test_toReenteringSweepDuringWithdrawLiquidityKeepsTheBooksStraight() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        vm.deal(vault.exitAddressOf(payout), AMOUNT);

        Reenterer r = new Reenterer();
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _lpSigned(address(r), 1 ether, 0, deadline);
        r.arm(address(vault), abi.encodeCall(InstantExitVault.sweep, (payout)));

        vault.withdrawLiquidity(address(r), 1 ether, 0, deadline, sig);
        assertTrue(r.innerOk());
        assertEq(vault.owed(payout), 0);
        assertEq(vault.totalOwed(), 0);
        assertEq(address(vault).balance, LIQUIDITY - PAY + AMOUNT - 1 ether);
        assertEq(address(r).balance, 1 ether);
    }

    // =====================================================================================================
    // withdrawLiquidity failures: none of them consumes the nonce
    // =====================================================================================================

    function test_withdrawLiquidityDeadlineIsInclusive() public {
        address to = makeAddr("lp-wallet");
        uint64 deadline = uint64(block.timestamp + 60);
        bytes memory sig = _lpSigned(to, 1 ether, 0, deadline);

        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(InstantExitVault.Expired.selector);
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, sig);
        assertEq(vault.withdrawNonce(), 0);

        vm.warp(deadline);
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, sig);
        assertEq(to.balance, 1 ether);
        assertEq(vault.withdrawNonce(), 1);
    }

    function test_withdrawLiquidityToARevertingAddressRevertsAndKeepsTheNonce() public {
        TogglePayout to = new TogglePayout(false);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _lpSigned(address(to), 1 ether, 0, deadline);

        vm.expectRevert(InstantExitVault.TransferFailed.selector);
        vault.withdrawLiquidity(address(to), 1 ether, 0, deadline, sig);
        assertEq(vault.withdrawNonce(), 0);
        assertEq(address(vault).balance, LIQUIDITY);

        to.setAccept(true); // the same signature still works
        vault.withdrawLiquidity(address(to), 1 ether, 0, deadline, sig);
        assertEq(address(to).balance, 1 ether);
        assertEq(vault.withdrawNonce(), 1);
    }

    function test_withdrawLiquidityAboveTheBalanceRevertsAndKeepsTheNonce() public {
        address to = makeAddr("lp-wallet");
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory sig = _lpSigned(to, LIQUIDITY + 1, 0, deadline);

        vm.expectRevert(InstantExitVault.TransferFailed.selector);
        vault.withdrawLiquidity(to, LIQUIDITY + 1, 0, deadline, sig);
        assertEq(vault.withdrawNonce(), 0);
        assertEq(address(vault).balance, LIQUIDITY);

        // A fresh signature at the same nonce for what is there goes through.
        sig = _lpSigned(to, LIQUIDITY, 0, deadline);
        vault.withdrawLiquidity(to, LIQUIDITY, 0, deadline, sig);
        assertEq(to.balance, LIQUIDITY);
        assertEq(vault.available(), 0);
    }

    function test_withdrawLiquidityRefusesFutureNonceShortSignatureAndUnusableKey() public {
        address to = makeAddr("lp-wallet");
        uint64 deadline = uint64(block.timestamp + 600);

        bytes memory sig = _lpSigned(to, 1 ether, 1, deadline);
        vm.expectRevert(InstantExitVault.BadNonce.selector);
        vault.withdrawLiquidity(to, 1 ether, 1, deadline, sig);

        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.BadSignature.selector, type(uint256).max));
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, new bytes(4626));

        sig = _lpSigned(to, 1 ether, 0, deadline);
        keys.set(lp, true, 1, _key(9), false); // no proof of possession
        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.KeyNotUsable.selector, lp));
        vault.withdrawLiquidity(to, 1 ether, 0, deadline, sig);
        assertEq(vault.withdrawNonce(), 0);
    }

    // =====================================================================================================
    // front: input checks
    // =====================================================================================================

    function test_wrongLengthSignatureNamesTheMember() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 2));
        uint256[3] memory lens = [uint256(4626), 4628, 0];
        for (uint256 i = 0; i < 3; i++) {
            g[1] = new bytes(lens[i]);
            vm.expectRevert(abi.encodeWithSelector(InstantExitVault.BadSignature.selector, 2));
            vault.front(e, s, g);
        }
    }

    function test_sigsAndSignersOfDifferentLengthAreRefused() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _triple(0, 1, 2));

        bytes[] memory twoSigs = new bytes[](2);
        (twoSigs[0], twoSigs[1]) = (g[0], g[1]);
        vm.expectRevert(InstantExitVault.NotEnoughSigners.selector);
        vault.front(e, s, twoSigs); // 3 signers, 2 signatures

        vm.expectRevert(InstantExitVault.NotEnoughSigners.selector);
        vault.front(e, _pair(0, 1), g); // 2 signers, 3 signatures
    }

    function test_descendingSignersAreRefused() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(1, 0));
        vm.expectRevert(InstantExitVault.SignersNotAscending.selector);
        vault.front(e, s, g);
    }

    /// KNOWN LIMITATION: an out-of-range signer index is an array access past the end of `members`, so
    /// `front` and `verifyExit` revert with Panic(0x32) rather than a typed error. Nothing is paid; a relayer
    /// calling verifyExit sees an opaque panic instead of a reason.
    function test_signerIndexOutOfRangePanics_knownLimitation() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        s[1] = 3; // the quorum has members 0, 1, 2
        vm.expectRevert(stdError.indexOOBError);
        vault.front(e, s, g);
        vm.expectRevert(stdError.indexOOBError);
        vault.verifyExit(e, s, g);
        s[1] = type(uint256).max;
        vm.expectRevert(stdError.indexOOBError);
        vault.front(e, s, g);
        assertFalse(vault.fronted(vault.exitId(e)));
    }

    function test_moreSignersThanThresholdAreAcceptedButEveryOneMustBeValid() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _triple(0, 1, 2));
        vault.front(e, s, g);
        assertEq(payout.balance, PAY);

        // Two valid signatures meet the threshold, but a bad third one still fails the whole call.
        InstantExitVault.Exit memory e2 = _exit();
        e2.withdrawalIndex = 1;
        (s, g) = _signed(e2, _triple(0, 1, 2));
        g[2] = _sig(99);
        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.BadSignature.selector, 2));
        vault.front(e2, s, g);
    }

    function test_zeroPayoutIsRefused() public {
        InstantExitVault.Exit memory e = _exitFor(address(0));
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vm.expectRevert(InstantExitVault.BadConfig.selector);
        vault.front(e, s, g);
    }

    function test_deadlineIsInclusive() public {
        InstantExitVault.Exit memory e = _exit();
        e.deadline = uint64(block.timestamp); // deadline == now is allowed
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        assertEq(payout.balance, PAY);

        InstantExitVault.Exit memory late = _exit();
        late.withdrawalIndex = 1;
        late.deadline = uint64(block.timestamp);
        (s, g) = _signed(late, _pair(0, 1));
        vm.warp(block.timestamp + 1); // one second past
        vm.expectRevert(InstantExitVault.Expired.selector);
        vault.front(late, s, g);
    }

    // =====================================================================================================
    // receive, views
    // =====================================================================================================

    function test_receiveEmitsDeposited() public {
        vm.deal(relayer, 1 ether);
        vm.expectEmit(true, false, false, true, address(vault));
        emit InstantExitVault.Deposited(relayer, 1 ether);
        vm.prank(relayer);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(vault.available(), LIQUIDITY + 1 ether);

        // There is no fallback: value sent with calldata that matches no function is refused.
        vm.prank(relayer);
        (ok,) = address(vault).call{value: 1 wei}(hex"deadbeef");
        assertFalse(ok);
    }

    function test_quorumAndConfigViews() public view {
        address[] memory q = vault.quorum();
        assertEq(q.length, 3);
        assertEq(q[0], wt2);
        assertEq(q[1], wt3);
        assertEq(q[2], wt4);
        assertEq(vault.threshold(), 2);
        assertEq(vault.lp(), lp);
        assertEq(vault.feeBps(), FEE_BPS);
        assertEq(vault.chainId(), "qorechain-diana");
        assertEq(vault.rollupId(), "vigil-pay-1");
        assertEq(vault.keyOf(wt3), _key(3));
        assertEq(vault.keyOf(address(0xBEEF)).length, 0);
    }

    function test_availableTracksTheBalance() public {
        assertEq(vault.available(), LIQUIDITY);
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        assertEq(vault.available(), LIQUIDITY - PAY);
        vm.deal(vault.exitAddressOf(payout), AMOUNT);
        vault.sweep(payout);
        assertEq(vault.available(), LIQUIDITY + FEE, "the vault keeps the fee once repaid");
    }

    // =====================================================================================================
    // Fee arithmetic. 1 uqor is 10^12 wei and 10_000 divides 10^12, so the fee is always exact.
    // =====================================================================================================

    function test_feeAtOneUqor() public {
        InstantExitVault.Exit memory e = _exit();
        e.amountUqor = 1;
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        uint256 fee = 5e9; // 1e12 * 50 / 10_000, no remainder
        vm.expectEmit(true, true, false, true, address(vault));
        emit InstantExitVault.Fronted(vault.exitId(e), payout, e.batchIndex, e.withdrawalIndex, 1e12 - fee, fee);
        vault.front(e, s, g);
        assertEq(payout.balance, 1e12 - fee);
        assertEq(vault.owed(payout), 1e12);
    }

    function test_feeAtMaxUint64Uqor() public {
        InstantExitVault.Exit memory e = _exit();
        e.amountUqor = type(uint64).max;
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        uint256 amount = uint256(type(uint64).max) * WEI;
        uint256 fee = (amount * FEE_BPS) / 10_000;
        assertEq(fee * 10_000, amount * FEE_BPS, "no rounding");
        uint256 pay = amount - fee;

        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.NotEnoughLiquidity.selector, LIQUIDITY, pay));
        vault.front(e, s, g);

        vm.deal(address(vault), pay);
        vault.front(e, s, g);
        assertEq(payout.balance, pay);
        assertEq(vault.owed(payout), amount);
        assertEq(vault.totalOwed(), amount);
        assertEq(address(vault).balance, 0);
    }

    function testFuzz_feeIsExactForEveryAmountAndRate(uint64 amountUqor, uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, 0, 1000));
        address[] memory m = vault.quorum();
        vault = new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 2, lp, feeBps);
        InstantExitVault.Exit memory e = _exit();
        e.amountUqor = amountUqor;
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));

        uint256 amount = uint256(amountUqor) * WEI;
        uint256 fee = uint256(amountUqor) * feeBps * 1e8; // exact: 10^12 / 10^4
        vm.deal(address(vault), amount - fee);
        vault.front(e, s, g);
        assertEq(payout.balance, amount - fee);
        assertEq(payout.balance + fee, amount);
        assertEq(vault.owed(payout), amount);
        assertEq(address(vault).balance, 0);
    }

    // =====================================================================================================
    // Key rotation between signing and fronting
    // =====================================================================================================

    /// Keys are read live, so a member that rotates its key after signing voids its outstanding signatures:
    /// the relayer must collect a fresh one under the new key (or use another member).
    function test_aMemberRotatingItsKeyVoidsSignaturesMadeWithTheOldOne() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        keys.set(wt3, true, 1, _key(33), true); // watchtower-3 rotates

        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.BadSignature.selector, 1));
        vault.front(e, s, g);

        pqc.markValid(_key(33), _sig(33), vault.exitMessage(e));
        g[1] = _sig(33);
        vault.front(e, s, g);
        assertEq(payout.balance, PAY);
    }

    function test_aMemberWhoseKeyIsRevokedCannotCountTowardTheThreshold() public {
        InstantExitVault.Exit memory e = _exit();
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        keys.set(wt2, false, 0, "", false); // watchtower-2's key deregistered
        vm.expectRevert(abi.encodeWithSelector(InstantExitVault.KeyNotUsable.selector, wt2));
        vault.front(e, s, g);
        (s, g) = _signed(e, _pair(1, 2)); // the other two still can
        vault.front(e, s, g);
        assertEq(payout.balance, PAY);
    }

    // =====================================================================================================
    // KNOWN LIMITATION: one withdrawal fronted twice across a rollback
    // =====================================================================================================

    /// The exit id is (batchIndex, stateRoot, withdrawalIndex), so the same L2 withdrawal attested by the
    /// quorum in a batch that a challenge later removes and again in the honest resubmission (another state
    /// root, possibly another batch index) is two exits to the vault, and both can be fronted. L1 pays the
    /// withdrawal once, so the LP is short one withdrawal (less both fees), and the unpaid debt stays on the
    /// payout's exit address: the next withdrawal through that address repays it before the user sees any.
    /// The vault cannot tell the two apart; it relies on the quorum attesting only batches no challenge can
    /// remove (THREAT_MODEL.md section 14). It is the LP's risk; the user is never short.
    function test_sameWithdrawalFrontedTwiceAcrossARollback_knownLimitation() public {
        InstantExitVault.Exit memory a = _exit();
        a.batchIndex = 18;
        a.stateRoot = keccak256("root-18 on a parent that is later challenged");
        a.withdrawalIndex = 4;
        (uint256[] memory s, bytes[] memory g) = _signed(a, _pair(0, 1));
        vault.front(a, s, g);

        InstantExitVault.Exit memory b = _exit(); // the same withdrawal (index, amount, payout) ...
        b.batchIndex = 17; // ... in the honest resubmission at the reused index, under another root
        b.stateRoot = keccak256("honest resubmission");
        b.withdrawalIndex = 4;
        (s, g) = _signed(b, _pair(0, 1));
        vault.front(b, s, g); // possible today
        assertTrue(vault.fronted(vault.exitId(a)) && vault.fronted(vault.exitId(b)));
        assertEq(payout.balance, 2 * PAY, "the user is paid twice");
        assertEq(vault.owed(payout), 2 * AMOUNT);

        address ea = vault.exitAddressOf(payout);
        vm.deal(ea, AMOUNT); // L1 pays the withdrawal once
        vault.sweep(payout);
        assertEq(vault.owed(payout), AMOUNT, "one withdrawal is never repaid");
        assertEq(LIQUIDITY - address(vault).balance, AMOUNT - 2 * FEE, "the LP is short one withdrawal less fees");

        // A later, unfronted withdrawal to the same exit address repays the stale debt first.
        vm.deal(ea, AMOUNT);
        vault.sweep(payout);
        assertEq(vault.owed(payout), 0);
        assertEq(payout.balance, 2 * PAY, "the user receives nothing from it");
    }

    // =====================================================================================================
    // ExitAddress
    // =====================================================================================================

    function test_exitAddressWiringAndSettleOnlyFromIt() public {
        vault.sweep(payout);
        address ea = vault.exitAddressOf(payout);
        assertEq(address(ExitAddress(payable(ea)).vault()), address(vault));
        assertEq(ExitAddress(payable(ea)).payout(), payout);

        // The exit address of one payout cannot settle another payout's debt.
        InstantExitVault.Exit memory e = _exitFor(relayer);
        (uint256[] memory s, bytes[] memory g) = _signed(e, _pair(0, 1));
        vault.front(e, s, g);
        vm.deal(ea, AMOUNT);
        vm.prank(ea);
        vm.expectRevert(InstantExitVault.NotExitAddress.selector);
        vault.settle{value: AMOUNT}(relayer);
        assertEq(vault.owed(relayer), AMOUNT);
    }
}
