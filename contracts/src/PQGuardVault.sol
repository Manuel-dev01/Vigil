// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IQorePQC} from "./interfaces/IQorePQC.sol";

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title PQGuardVault
/// @notice A vault whose funds move only with an ML-DSA-87 signature from one account's registered
///         post-quantum key. It has no owner and never looks at msg.sender: a classical (ECDSA) key,
///         including the guardian account's own, can call it but cannot move anything.
/// @dev    The guardian's key is read live from the pqcKeyStatus precompile and must carry a proof
///         of possession. The signed message is domain-separated and bound to this chain, this vault,
///         a nonce, the token, the recipient, the amount and a deadline, so a signature cannot be
///         replayed, redirected or reused on another vault or chain. Anyone may submit a signed
///         release (a relayer pays the gas); the signature is the only authority.
contract PQGuardVault {
    address public constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address public constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    /// @notice Domain tag of every release message (exactly 16 bytes).
    bytes16 public constant DOMAIN = "vigil/pqguard/v1";
    uint8 public constant ALG_ML_DSA_87 = 1;
    uint256 public constant ML_DSA_87_PUBKEY_LEN = 2592;
    uint256 public constant ML_DSA_87_SIG_LEN = 4627;
    /// @notice token == address(0) means the chain's native coin.
    address public constant NATIVE = address(0);

    /// @notice The account whose registered ML-DSA-87 key authorises releases.
    address public immutable guardian;
    /// @notice The nonce the next release must sign.
    uint256 public nonce;

    event Deposited(address indexed from, uint256 amount);
    event Released(uint256 indexed nonce, address indexed token, address indexed recipient, uint256 amount);

    error ZeroGuardian();
    error Expired();
    error KeyNotUsable();
    error BadSignature();
    error PrecompileUnavailable();
    error TransferFailed();

    constructor(address guardian_) {
        if (guardian_ == address(0)) revert ZeroGuardian();
        guardian = guardian_;
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice The exact bytes the guardian signs (FIPS 204 pure ML-DSA-87, empty context):
    ///         DOMAIN(16) | chainid(32) | vault(20) | nonce(32) | token(20) | recipient(20) | amount(32) | deadline(32)
    function releaseMessage(address token, address recipient, uint256 amount, uint256 deadline, uint256 nonce_)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(DOMAIN, block.chainid, address(this), nonce_, token, recipient, amount, deadline);
    }

    /// @notice The guardian's current ML-DSA-87 public key. Reverts unless it is registered, is ML-DSA-87,
    ///         has the right length and was registered with a verified proof of possession.
    function guardianKey() public view returns (bytes memory pubkey) {
        (bool ok, bytes memory ret) =
            PQC_KEY_STATUS.staticcall(abi.encodeCall(IQorePQC.pqcKeyStatus, (guardian)));
        // (bool, uint8, bytes, bool) encodes to at least 5 words even for an empty key.
        if (!ok || ret.length < 160) revert PrecompileUnavailable();
        (bool registered, uint8 alg, bytes memory pk, bool proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != ALG_ML_DSA_87 || !proven || pk.length != ML_DSA_87_PUBKEY_LEN) {
            revert KeyNotUsable();
        }
        return pk;
    }

    /// @notice Whether `signature` authorises this release at the current nonce. A free read for
    ///         clients to check a signature before sending it.
    function isValidRelease(
        address token,
        address recipient,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external view returns (bool) {
        if (block.timestamp > deadline) return false;
        return _verify(guardianKey(), signature, releaseMessage(token, recipient, amount, deadline, nonce));
    }

    /// @notice Move `amount` of `token` (address(0) = native) to `recipient`, authorised by the
    ///         guardian's ML-DSA-87 signature over releaseMessage(...) at the current nonce.
    function release(
        address token,
        address payable recipient,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert Expired();
        uint256 n = nonce;
        if (!_verify(guardianKey(), signature, releaseMessage(token, recipient, amount, deadline, n))) {
            revert BadSignature();
        }
        nonce = n + 1; // effects before interactions: a re-entrant call needs a new signature

        if (token == NATIVE) {
            (bool sent,) = recipient.call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20Transfer.transfer, (recipient, amount)));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && token.code.length == 0)) {
                revert TransferFailed();
            }
        }
        emit Released(n, token, recipient, amount);
    }

    function _verify(bytes memory pubkey, bytes calldata signature, bytes memory message)
        internal
        view
        returns (bool)
    {
        if (signature.length != ML_DSA_87_SIG_LEN) return false;
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeCall(IQorePQC.pqcVerify, (pubkey, signature, message)));
        // An inactive precompile returns success with empty data: never read that as an answer.
        if (!ok || ret.length != 32) revert PrecompileUnavailable();
        return abi.decode(ret, (bool));
    }
}
