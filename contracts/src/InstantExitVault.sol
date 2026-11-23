// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IQorePQC} from "./interfaces/IQorePQC.sol";

/// @title InstantExitVault
/// @notice Instant exits for a qledger-v1 rollup. A withdrawal from the rollup is paid on L1 only once its
///         batch is final (after the challenge window). This vault pays it at once, from liquidity, when a
///         quorum of watchtowers has re-executed the batch and signed for the withdrawal with ML-DSA-87.
///
///         How a user exits:
///         1. On L2, withdraw to `exitAddressOf(payout)`. That address is derived from `payout`, and the L2
///            signature covers it, so whoever posts or copies the transaction cannot redirect the money.
///         2. When `threshold` quorum members sign the exit, anyone may call `front`: the vault pays
///            `payout` the amount less the fee, and records that `payout`'s exit address owes it the amount.
///         3. Once the batch is final, anyone executes the withdrawal on L1. The chain pays the exit address,
///            and `sweep(payout)` repays the vault first and forwards the rest to `payout`.
///
///         If nobody fronts the exit (no liquidity, quorum offline, deadline passed), step 3 alone pays the
///         user in full after the challenge window. The quorum can never take a user's withdrawal.
///
/// @dev    No owner and no msg.sender authority. Authority is ML-DSA-87 only, checked with the pqcVerify
///         precompile against keys read live from pqcKeyStatus (registered, ML-DSA-87, proof of possession):
///         the quorum's keys for fronting, the LP's key for taking liquidity out.
///         What the quorum attests, and what the vault therefore trusts, is that the withdrawal (batch,
///         index, state root, amount, exit address of `payout`) is in a batch that re-executes correctly
///         from an honest parent, so no challenge can remove it, and that `deadline` is before the batch can
///         be final. Fronting stops at `deadline`, so a withdrawal already paid on L1 cannot be fronted too.
///         The LP bears the risk of a quorum that signs a bad batch; the user bears none beyond the fee.
contract InstantExitVault {
    address public constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address public constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    /// @notice Domain tags of the two signed messages (raw ASCII at the start of each message).
    string public constant EXIT_DOMAIN = "vigil/instant-exit/v1/exit";
    string public constant WITHDRAW_DOMAIN = "vigil/instant-exit/v1/withdraw";
    uint8 public constant ALG_ML_DSA_87 = 1;
    uint256 public constant ML_DSA_87_PUBKEY_LEN = 2592;
    uint256 public constant ML_DSA_87_SIG_LEN = 4627;
    /// @notice 1 uqor (the rollup's withdrawal unit) is 10^12 wei on the EVM side of the same balance.
    uint256 public constant WEI_PER_UQOR = 1e12;
    uint16 public constant MAX_FEE_BPS = 1000;

    /// @notice The chain and rollup this vault fronts exits for. Both are part of every signed exit.
    string public chainId;
    string public rollupId;
    /// @notice The account whose registered ML-DSA-87 key authorises taking liquidity out.
    address public immutable lp;
    /// @notice The quorum fee, in basis points of the withdrawal, kept by the vault.
    uint16 public immutable feeBps;
    /// @notice How many distinct quorum members must sign an exit.
    uint256 public immutable threshold;
    address[] internal members;

    /// @notice Exits already fronted, by `exitId`.
    mapping(bytes32 => bool) public fronted;
    /// @notice Wei that each payout's exit address owes the vault (fronted and not yet swept back).
    mapping(address => uint256) public owed;
    uint256 public totalOwed;
    /// @notice The nonce the next liquidity withdrawal must sign.
    uint256 public withdrawNonce;

    bytes internal exitPrefix;

    struct Exit {
        uint64 batchIndex;
        bytes32 stateRoot;
        uint64 withdrawalIndex;
        uint64 amountUqor;
        address payout;
        uint64 deadline;
    }

    event Fronted(bytes32 indexed exitId, address indexed payout, uint64 batchIndex, uint64 withdrawalIndex, uint256 paid, uint256 fee);
    event Settled(address indexed payout, uint256 repaid, uint256 stillOwed);
    event Deposited(address indexed from, uint256 amount);
    event LiquidityWithdrawn(uint256 indexed nonce, address indexed to, uint256 amount);

    error BadConfig();
    error UnknownChain();
    error Expired();
    error AlreadyFronted();
    error NotEnoughSigners();
    error SignersNotAscending();
    error BadSignature(uint256 member);
    error KeyNotUsable(address member);
    error NotEnoughLiquidity(uint256 available, uint256 needed);
    error NotExitAddress();
    error BadNonce();
    error PrecompileUnavailable();
    error TransferFailed();

    constructor(
        string memory chainId_,
        string memory rollupId_,
        address[] memory members_,
        uint256 threshold_,
        address lp_,
        uint16 feeBps_
    ) {
        bytes32 c = keccak256(bytes(chainId_));
        bool known = (block.chainid == 9800 && c == keccak256("qorechain-diana"))
            || (block.chainid == 9801 && c == keccak256("qorechain-vladi"));
        if (!known) revert UnknownChain();
        if (bytes(rollupId_).length == 0 || lp_ == address(0) || feeBps_ > MAX_FEE_BPS) revert BadConfig();
        if (threshold_ == 0 || threshold_ > members_.length) revert BadConfig();
        for (uint256 i = 0; i < members_.length; i++) {
            if (members_[i] == address(0)) revert BadConfig();
            for (uint256 j = 0; j < i; j++) {
                if (members_[j] == members_[i]) revert BadConfig();
            }
        }
        chainId = chainId_;
        rollupId = rollupId_;
        members = members_;
        threshold = threshold_;
        lp = lp_;
        feeBps = feeBps_;
        exitPrefix = abi.encodePacked(
            EXIT_DOMAIN,
            uint64(block.chainid),
            address(this),
            uint64(bytes(chainId_).length),
            chainId_,
            uint64(bytes(rollupId_).length),
            rollupId_
        );
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------ views

    function quorum() external view returns (address[] memory) {
        return members;
    }

    /// @notice The bytes each quorum member signs for an exit:
    ///         EXIT_DOMAIN | u64be evmChainId | vault | u64be(len) chainId | chainId | u64be(len) rollupId
    ///         | rollupId | u64be batchIndex | stateRoot | u64be withdrawalIndex | u64be amountUqor
    ///         | recipient | u64be deadline
    ///         `recipient` is the withdrawal's L1 recipient (20 bytes) as the batch records it, which for an
    ///         instant exit is `exitAddressOf(payout)`. Members sign what they read from the batch and need not
    ///         know `payout`; the vault derives the recipient from the `payout` it is given, so a signature
    ///         pays only the payout whose exit address the user withdrew to.
    function exitMessage(Exit calldata e) public view returns (bytes memory) {
        return abi.encodePacked(
            exitPrefix,
            e.batchIndex,
            e.stateRoot,
            e.withdrawalIndex,
            e.amountUqor,
            exitAddressOf(e.payout),
            e.deadline
        );
    }

    /// @notice An exit's identity: the withdrawal (batch, index) under that batch's state root, so a batch
    ///         index reused after a rollback is a different exit.
    function exitId(Exit calldata e) public pure returns (bytes32) {
        return keccak256(abi.encode(e.batchIndex, e.stateRoot, e.withdrawalIndex));
    }

    /// @notice The L2 withdrawal recipient for `payout`: an ExitAddress created at this CREATE2 address on
    ///         its first sweep. Its qor1 form is what the user writes into the L2 withdrawal.
    function exitAddressOf(address payout) public view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), bytes32(uint256(uint160(payout))), _exitInitHash(payout))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Liquidity free to front exits now.
    function available() public view returns (uint256) {
        return address(this).balance;
    }

    /// @notice The bytes the LP signs to take `amount` wei to `to`:
    ///         WITHDRAW_DOMAIN | u64be evmChainId | vault | to | u256 amount | u256 nonce | u64be deadline
    function withdrawMessage(address to, uint256 amount, uint256 nonce, uint64 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(WITHDRAW_DOMAIN, uint64(block.chainid), address(this), to, amount, nonce, deadline);
    }

    /// @notice A member's (or the LP's) ML-DSA-87 key as the chain holds it now, or empty if not usable.
    function keyOf(address account) public view returns (bytes memory pubkey) {
        (bool ok, bytes memory ret) = PQC_KEY_STATUS.staticcall(abi.encodeCall(IQorePQC.pqcKeyStatus, (account)));
        if (!ok || ret.length < 160) revert PrecompileUnavailable();
        (bool registered, uint8 alg, bytes memory pk, bool proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != ALG_ML_DSA_87 || !proven || pk.length != ML_DSA_87_PUBKEY_LEN) return "";
        return pk;
    }

    // -------------------------------------------------------------- actions

    /// @notice Pay an exit now. `signers` are indices into `quorum()`, strictly ascending; `sigs[k]` is
    ///         member `signers[k]`'s ML-DSA-87 signature over `exitMessage(e)`. Anyone may call this; the
    ///         money goes to `e.payout` only.
    function front(Exit calldata e, uint256[] calldata signers, bytes[] calldata sigs) external {
        bytes32 id = verifyExit(e, signers, sigs);
        uint256 amount = uint256(e.amountUqor) * WEI_PER_UQOR;
        uint256 fee = (amount * feeBps) / 10_000;
        uint256 pay = amount - fee;
        if (address(this).balance < pay) revert NotEnoughLiquidity(address(this).balance, pay);

        fronted[id] = true;
        owed[e.payout] += amount;
        totalOwed += amount;
        emit Fronted(id, e.payout, e.batchIndex, e.withdrawalIndex, pay, fee);
        (bool ok,) = payable(e.payout).call{value: pay}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Every check `front` makes except liquidity, as a view: reverts with the reason `front` would,
    ///         or returns the exit's id. Relayers call it with eth_call before paying gas.
    function verifyExit(Exit calldata e, uint256[] calldata signers, bytes[] calldata sigs)
        public
        view
        returns (bytes32 id)
    {
        if (block.timestamp > e.deadline) revert Expired();
        if (e.payout == address(0)) revert BadConfig();
        id = exitId(e);
        if (fronted[id]) revert AlreadyFronted();
        if (signers.length < threshold || sigs.length != signers.length) revert NotEnoughSigners();
        bytes memory message = exitMessage(e);
        for (uint256 k = 0; k < signers.length; k++) {
            if (k > 0 && signers[k] <= signers[k - 1]) revert SignersNotAscending();
            _requireSigned(members[signers[k]], sigs[k], message, signers[k]);
        }
    }

    /// @notice Create `payout`'s exit address if needed and sweep it: the vault is repaid first, the rest
    ///         goes to `payout`. Anyone may call this.
    function sweep(address payout) external {
        address a = exitAddressOf(payout);
        if (a.code.length == 0) {
            new ExitAddress{salt: bytes32(uint256(uint160(payout)))}(payable(address(this)), payable(payout));
        }
        ExitAddress(payable(a)).sweep();
    }

    /// @notice Repayment from `payout`'s exit address. Only that address may call it.
    function settle(address payout) external payable {
        if (msg.sender != exitAddressOf(payout)) revert NotExitAddress();
        uint256 o = owed[payout];
        uint256 repaid = msg.value > o ? o : msg.value;
        owed[payout] = o - repaid;
        totalOwed -= repaid;
        emit Settled(payout, msg.value, owed[payout]);
    }

    /// @notice Take liquidity out, authorised by the LP's ML-DSA-87 signature over
    ///         `withdrawMessage(to, amount, nonce, deadline)`. Anyone may submit it.
    function withdrawLiquidity(address to, uint256 amount, uint256 nonce, uint64 deadline, bytes calldata sig)
        external
    {
        if (block.timestamp > deadline) revert Expired();
        if (nonce != withdrawNonce) revert BadNonce();
        _requireSigned(lp, sig, withdrawMessage(to, amount, nonce, deadline), type(uint256).max);
        withdrawNonce = nonce + 1;
        emit LiquidityWithdrawn(nonce, to, amount);
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------- internals

    function _exitInitHash(address payout) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(type(ExitAddress).creationCode, abi.encode(address(this), payout)));
    }

    function _requireSigned(address account, bytes calldata sig, bytes memory message, uint256 member)
        internal
        view
    {
        if (sig.length != ML_DSA_87_SIG_LEN) revert BadSignature(member);
        bytes memory pk = keyOf(account);
        if (pk.length == 0) revert KeyNotUsable(account);
        (bool ok, bytes memory ret) = PQC_VERIFY.staticcall(abi.encodeCall(IQorePQC.pqcVerify, (pk, sig, message)));
        if (!ok || ret.length != 32) revert PrecompileUnavailable();
        if (!abi.decode(ret, (bool))) revert BadSignature(member);
    }
}

/// @title ExitAddress
/// @notice One per payout address, at a CREATE2 address the vault derives from it. The rollup pays a
///         user's L2 withdrawal here; `sweep` repays what the vault fronted and forwards the rest. It has no
///         owner and can send money only to the vault (up to what is owed) and to its payout address.
contract ExitAddress {
    InstantExitVault public immutable vault;
    address payable public immutable payout;

    constructor(address payable vault_, address payable payout_) {
        vault = InstantExitVault(vault_);
        payout = payout_;
    }

    receive() external payable {}

    /// @notice Repay the vault what `payout` owes it, then forward the rest to `payout`. Anyone may call
    ///         it. If `payout` refuses the transfer, the rest stays here for a later sweep.
    function sweep() external {
        uint256 bal = address(this).balance;
        uint256 o = vault.owed(payout);
        uint256 repay = bal < o ? bal : o;
        if (repay > 0) vault.settle{value: repay}(payout);
        uint256 rest = bal - repay;
        if (rest > 0) {
            (bool ok,) = payout.call{value: rest}("");
            ok; // a refusing payout keeps its money here until it accepts
        }
    }
}
