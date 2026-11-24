// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InstantExitVault} from "../../src/InstantExitVault.sol";
import {MockPqcKeyStatus, MockPqcVerify} from "../mocks/PqcMocks.sol";

/// Shared set-up for the InstantExitVault edge-case and invariant suites: the same mocked precompiles,
/// quorum (3 members, threshold 2), LP, fee (50 bps) and liquidity (10 QOR) as InstantExitVault.t.sol.
/// The mock pqcVerify accepts exactly the (key, signature, message) triples a test marks valid.
abstract contract ExitVaultFixture is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 constant WEI = 1e12; // per uqor
    uint16 constant FEE_BPS = 50;
    uint256 constant LIQUIDITY = 10 ether;

    MockPqcVerify pqc;
    MockPqcKeyStatus keys;
    InstantExitVault vault;

    address wt2 = makeAddr("watchtower-2");
    address wt3 = makeAddr("watchtower-3");
    address wt4 = makeAddr("watchtower-4");
    address lp = makeAddr("lp");
    address payout = makeAddr("payout");
    address relayer = makeAddr("anyone");

    function setUp() public virtual {
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
        vault = new InstantExitVault("qorechain-diana", "vigil-pay-1", m, 2, lp, FEE_BPS);
        vm.deal(address(vault), LIQUIDITY);
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

    function _exitFor(address p) internal view returns (InstantExitVault.Exit memory e) {
        e = InstantExitVault.Exit({
            batchIndex: 15,
            stateRoot: keccak256("root-15"),
            withdrawalIndex: 0,
            amountUqor: 100_000, // 0.1 QOR
            payout: p,
            deadline: uint64(block.timestamp + 3000)
        });
    }

    function _exit() internal view returns (InstantExitVault.Exit memory) {
        return _exitFor(payout);
    }

    /// Mark members' signatures valid over `e` (member i signs with key seed i + 2) and return the call
    /// arguments.
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

    function _triple(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _fee(uint256 amountWei) internal pure returns (uint256) {
        return (amountWei * FEE_BPS) / 10_000;
    }

    /// An LP signature (as the mock accepts it) over withdrawMessage(to, amount, nonce, deadline).
    function _lpSigned(address to, uint256 amount, uint256 nonce, uint64 deadline) internal returns (bytes memory) {
        pqc.markValid(_key(9), _sig(9), vault.withdrawMessage(to, amount, nonce, deadline));
        return _sig(9);
    }
}
