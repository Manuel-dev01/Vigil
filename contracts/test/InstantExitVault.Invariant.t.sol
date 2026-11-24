// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {InstantExitVault, ExitAddress} from "../src/InstantExitVault.sol";
import {MockPqcVerify} from "./mocks/PqcMocks.sol";
import {TogglePayout} from "./mocks/TestActors.sol";
import {ExitVaultFixture} from "./helpers/ExitVaultFixture.sol";

/// Drives the vault through random sequences of fronts, L1 payments to exit addresses, sweeps (through the
/// vault or the exit address directly), deposits, LP withdrawals, payouts that start or stop refusing money,
/// and strangers calling settle. It keeps ghost totals and checks every sweep's split as it happens; the
/// invariants then compare the vault's books with them. No handler call is expected to revert, so the
/// campaign runs with fail_on_revert: a revert on a path the handler thinks is valid fails the test.
contract ExitVaultHandler is Test {
    uint256 constant WEI = 1e12;

    InstantExitVault public immutable vault;
    MockPqcVerify public immutable pqc;
    TogglePayout public immutable toggle;
    address public immutable lpWallet;
    address[] internal payoutList;

    uint64 internal nextBatch = 100;

    // Ghost totals.
    uint256 public ghostFronted; // wei recorded as owed by front
    uint256 public ghostPaidOut; // wei the vault paid payouts in front
    uint256 public ghostRepaid; // wei the vault received through settle (from exit addresses)
    uint256 public ghostDeposited; // wei sent to the vault's receive()
    uint256 public ghostWithdrawn; // wei the LP took out
    uint256 public ghostL1Paid; // wei "the chain" paid into exit addresses
    uint256 public ghostForwarded; // wei exit addresses forwarded to payouts

    // Violations seen while acting (each must stay 0).
    uint256 public overRepaid; // a sweep handed the vault more than the payout owed
    uint256 public badSplit; // a sweep's split differed from (repay = min(balance, owed), rest to payout)
    uint256 public strangerSettled; // settle accepted from an address that is not the payout's exit address
    uint256 public refusedFrontPaid; // front succeeded although the payout refused the money

    uint256 public fronts;
    uint256 public sweeps;

    constructor(InstantExitVault vault_, MockPqcVerify pqc_) {
        vault = vault_;
        pqc = pqc_;
        toggle = new TogglePayout(true);
        lpWallet = makeAddr("lp-wallet");
        payoutList.push(makeAddr("payout-a"));
        payoutList.push(makeAddr("payout-b"));
        payoutList.push(address(toggle));
    }

    function payouts() external view returns (address[] memory) {
        return payoutList;
    }

    function _payout(uint256 seed) internal view returns (address) {
        return payoutList[seed % payoutList.length];
    }

    function _key(uint256 seed) internal pure returns (bytes memory k) {
        k = new bytes(2592);
        for (uint256 i = 0; i < 32; i++) k[i] = bytes1(uint8(seed + i));
    }

    function _sig(uint256 seed) internal pure returns (bytes memory s) {
        s = new bytes(4627);
        for (uint256 i = 0; i < 32; i++) s[i] = bytes1(uint8(seed * 7 + i));
    }

    // ------------------------------------------------------------------ actions

    /// A quorum-signed exit for one of the payouts, fronted if there is liquidity and the payout accepts.
    function front(uint256 payoutSeed, uint64 amountUqor, uint256 pairSeed) external {
        address p = _payout(payoutSeed);
        amountUqor = uint64(bound(amountUqor, 0, 3_000_000)); // up to 3 QOR
        uint64 batch = nextBatch++;
        InstantExitVault.Exit memory e = InstantExitVault.Exit({
            batchIndex: batch,
            stateRoot: keccak256(abi.encode("root", batch)),
            withdrawalIndex: uint64(pairSeed % 4),
            amountUqor: amountUqor,
            payout: p,
            deadline: uint64(block.timestamp + 3000)
        });
        uint256[] memory s = new uint256[](2);
        uint256 pick = pairSeed % 3; // (0,1), (0,2) or (1,2)
        (s[0], s[1]) = pick == 0 ? (uint256(0), uint256(1)) : pick == 1 ? (uint256(0), uint256(2)) : (uint256(1), uint256(2));
        bytes[] memory g = new bytes[](2);
        bytes memory m = vault.exitMessage(e);
        for (uint256 k = 0; k < 2; k++) {
            g[k] = _sig(s[k] + 2);
            pqc.markValid(_key(s[k] + 2), g[k], m);
        }

        uint256 amount = uint256(amountUqor) * WEI;
        uint256 pay = amount - (amount * vault.feeBps()) / 10_000;
        bool refuses = p == address(toggle) && !toggle.accept();
        uint256 owedBefore = vault.owed(p);
        uint256 balBefore = address(vault).balance;

        if (address(vault).balance < pay || refuses) {
            try vault.front(e, s, g) {
                if (refuses) refusedFrontPaid += 1;
                else revert("fronted without liquidity");
            } catch {}
            if (vault.owed(p) != owedBefore || address(vault).balance != balBefore) badSplit += 1;
            return;
        }
        vault.front(e, s, g);
        ghostFronted += amount;
        ghostPaidOut += pay;
        fronts += 1;
    }

    /// The chain pays a finalized withdrawal (or any amount) to a payout's exit address.
    function payL1(uint256 payoutSeed, uint256 amount) external {
        address ea = vault.exitAddressOf(_payout(payoutSeed));
        amount = bound(amount, 0, 3 ether);
        vm.deal(ea, ea.balance + amount);
        ghostL1Paid += amount;
    }

    /// Sweep a payout's exit address, through the vault or (once deployed) the exit address itself, and
    /// check the split: the vault gets min(balance, owed), the payout the rest (or it stays if refused).
    function sweep(uint256 payoutSeed, bool direct) external {
        address p = _payout(payoutSeed);
        address ea = vault.exitAddressOf(p);
        uint256 bal = ea.balance;
        uint256 o = vault.owed(p);
        uint256 vaultBefore = address(vault).balance;
        uint256 payoutBefore = p.balance;
        bool refuses = p == address(toggle) && !toggle.accept();

        if (direct && ea.code.length > 0) ExitAddress(payable(ea)).sweep();
        else vault.sweep(p);

        uint256 repaid = address(vault).balance - vaultBefore;
        uint256 expectRepay = bal < o ? bal : o;
        if (repaid > o) overRepaid += 1;
        if (repaid != expectRepay || vault.owed(p) != o - repaid) badSplit += 1;
        uint256 rest = bal - expectRepay;
        if (refuses) {
            if (p.balance != payoutBefore || ea.balance != rest) badSplit += 1;
        } else {
            if (p.balance - payoutBefore != rest || ea.balance != 0) badSplit += 1;
            ghostForwarded += rest;
        }
        ghostRepaid += repaid;
        sweeps += 1;
    }

    function setToggleAccepts(bool accept) external {
        toggle.setAccept(accept);
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 0, 2 ether);
        vm.deal(address(this), amount);
        (bool ok,) = address(vault).call{value: amount}("");
        require(ok, "deposit");
        ghostDeposited += amount;
    }

    /// The LP takes out up to everything the vault holds, with a valid signature at the current nonce.
    function lpWithdraw(uint256 amount) external {
        amount = bound(amount, 0, address(vault).balance);
        uint256 nonce = vault.withdrawNonce();
        uint64 deadline = uint64(block.timestamp + 600);
        pqc.markValid(_key(9), _sig(9), vault.withdrawMessage(lpWallet, amount, nonce, deadline));
        vault.withdrawLiquidity(lpWallet, amount, nonce, deadline, _sig(9));
        ghostWithdrawn += amount;
    }

    /// Someone who is not the payout's exit address tries to settle (and so to pay down) its debt.
    function strangerSettle(uint256 strangerSeed, uint256 payoutSeed, uint256 value) external {
        address p = _payout(payoutSeed);
        address who = address(uint160(uint256(keccak256(abi.encode("stranger", strangerSeed)))));
        value = bound(value, 0, 1 ether);
        vm.deal(who, value);
        vm.prank(who);
        try vault.settle{value: value}(p) {
            strangerSettled += 1;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 600));
    }
}

contract InstantExitVaultInvariantTest is ExitVaultFixture {
    ExitVaultHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new ExitVaultHandler(vault, pqc);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = ExitVaultHandler.front.selector;
        sel[1] = ExitVaultHandler.payL1.selector;
        sel[2] = ExitVaultHandler.sweep.selector;
        sel[3] = ExitVaultHandler.setToggleAccepts.selector;
        sel[4] = ExitVaultHandler.deposit.selector;
        sel[5] = ExitVaultHandler.lpWithdraw.selector;
        sel[6] = ExitVaultHandler.strangerSettle.selector;
        sel[7] = ExitVaultHandler.warp.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_totalOwedIsTheSumOfOwed() public view {
        address[] memory ps = handler.payouts();
        uint256 sum;
        for (uint256 i = 0; i < ps.length; i++) sum += vault.owed(ps[i]);
        assertEq(vault.totalOwed(), sum);
        assertEq(vault.totalOwed(), handler.ghostFronted() - handler.ghostRepaid());
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_settleNeverTakesMoreThanOwedAndOnlyFromExitAddresses() public view {
        assertEq(handler.overRepaid(), 0, "a sweep repaid more than was owed");
        assertEq(handler.strangerSettled(), 0, "settle accepted from a stranger");
        assertLe(handler.ghostRepaid(), handler.ghostFronted());
    }

    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_sweepPaysThePayoutBalanceLessRepay() public view {
        assertEq(handler.badSplit(), 0, "a sweep split the exit address's balance wrongly");
        assertEq(handler.refusedFrontPaid(), 0, "front succeeded although the payout refused");
    }

    /// Every wei is accounted for: the vault holds what it started with, plus deposits and repayments, less
    /// what it paid out and what the LP withdrew; exit addresses hold what L1 paid them less what they swept.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_moneyIsConserved() public view {
        assertEq(
            address(vault).balance,
            LIQUIDITY + handler.ghostDeposited() + handler.ghostRepaid() - handler.ghostPaidOut()
                - handler.ghostWithdrawn()
        );
        address[] memory ps = handler.payouts();
        uint256 inExitAddresses;
        for (uint256 i = 0; i < ps.length; i++) inExitAddresses += vault.exitAddressOf(ps[i]).balance;
        assertEq(inExitAddresses, handler.ghostL1Paid() - handler.ghostRepaid() - handler.ghostForwarded());
    }
}

/// Stateless fuzz: a single front and a single L1 payment of any size, then a sweep.
contract InstantExitVaultSweepFuzzTest is ExitVaultFixture {
    function testFuzz_sweepRepaysMinOfBalanceAndOwedAndForwardsTheRest(uint64 frontedUqor, uint96 l1Paid) public {
        frontedUqor = uint64(bound(frontedUqor, 0, 5_000_000));
        InstantExitVault.Exit memory e = _exit();
        e.amountUqor = frontedUqor;
        uint256[] memory who = new uint256[](2);
        (who[0], who[1]) = (0, 1);
        (uint256[] memory s, bytes[] memory g) = _signed(e, who);
        vault.front(e, s, g);
        uint256 owedBefore = vault.owed(payout);
        uint256 payoutBefore = payout.balance;
        uint256 vaultBefore = address(vault).balance;

        address ea = vault.exitAddressOf(payout);
        vm.deal(ea, l1Paid);
        vault.sweep(payout);

        uint256 repay = l1Paid < owedBefore ? l1Paid : owedBefore;
        assertEq(address(vault).balance - vaultBefore, repay);
        assertEq(payout.balance - payoutBefore, uint256(l1Paid) - repay);
        assertEq(vault.owed(payout), owedBefore - repay);
        assertEq(vault.totalOwed(), owedBefore - repay);
        assertEq(ea.balance, 0);
    }
}
