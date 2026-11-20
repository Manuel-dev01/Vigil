// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IQorePQC} from "./interfaces/IQorePQC.sol";

/// @title SettlementReceiptVerifier
/// @notice Checks a rollup's settlement anchors inside the EVM, and keeps a public record of the
///         ones it has checked, so other contracts can use a rollup state root without trusting
///         anyone who relays it.
///
///         An anchor is what the QoreChain multilayer module stores when the rollup's creator
///         submits a batch: the creator's ML-DSA-87 signature over (chain id, layer id, layer
///         height, state root, validator-set hash, transaction count, compressed state proof).
///         This contract rebuilds that message byte for byte (the chain's v2 anchor format), reads
///         the creator's key from the chain's post-quantum key registry (pqcKeyStatus, which must
///         report a proof of possession), and verifies the signature with the pqcVerify precompile.
///
/// @dev    What a check here proves, and what it does not:
///         - It proves the rollup creator's chain-registered ML-DSA-87 key signed this state root
///           for this chain, this layer and this layer height. No relayer, committee or classical
///           key is trusted; anyone may submit an anchor and pay the gas.
///         - It does NOT prove the anchor was accepted on chain or that the batch is final: EVM code
///           cannot read the rollup module's state. Check those with a QoreChain node (the CLI or
///           the browser verifier), or wait the rollup's challenge window and watch for conflicts.
///         - If the creator's key has signed two different state roots for one layer height, that
///           height is marked conflicted for good and never reported as attested. Only the creator's
///           own key can cause this.
///         The rollup, its layer and its creator are fixed at deployment, and there is no owner:
///         nothing about this contract can be changed after it is created.
contract SettlementReceiptVerifier {
    address public constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address public constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    /// @notice Domain tag that starts every v2 anchor message (30 bytes, no length prefix).
    bytes30 public constant ANCHOR_DOMAIN_V2 = "qorechain-multilayer-anchor-v2";
    uint8 public constant ALG_ML_DSA_87 = 1;
    uint256 public constant ML_DSA_87_PUBKEY_LEN = 2592;
    uint256 public constant ML_DSA_87_SIG_LEN = 4627;

    /// @notice The account whose registered ML-DSA-87 key signs this layer's anchors: the rollup creator.
    address public immutable creator;
    /// @notice The EVM chain id this contract was deployed on (9800 testnet, 9801 mainnet).
    uint256 public immutable evmChainId;
    /// @notice QoreChain chain id bound into every anchor message ("qorechain-diana" on testnet).
    string public chainId;
    /// @notice The multilayer layer id the rollup settles to (for an RDK rollup, its rollup id).
    string public layerId;

    /// @dev ANCHOR_DOMAIN_V2 | u64be(len chainId) | chainId | u64be(len layerId) | layerId, fixed at deployment.
    bytes internal signPrefix;

    /// @notice The fields of an anchor that its signature covers.
    struct Anchor {
        uint64 layerHeight;
        bytes32 stateRoot;
        bytes validatorSetHash; // empty when the chain stores none
        uint64 transactionCount;
        bytes compressedStateProof; // empty when the chain stores none
        bytes signature; // ML-DSA-87, FIPS 204 pure mode, empty context
    }

    enum Result {
        Valid,
        BadSignatureLength,
        KeyNotUsable,
        BadSignature
    }

    struct Record {
        bytes32 stateRoot; // the first root a valid anchor showed for this height
        uint64 attestedAt; // block timestamp of that attestation
        uint64 attestedBlock;
        bool conflicted; // the creator's key also signed a different root for this height
    }

    /// @notice Attested anchors, by layer height.
    mapping(uint64 layerHeight => Record) public records;
    /// @notice For a conflicted height, the second root that was shown.
    mapping(uint64 layerHeight => bytes32) public conflictingRoot;
    uint64 public attestedCount;
    uint64 public conflictCount;
    /// @notice The highest layer height attested so far (0 when nothing is attested; see attestedCount).
    uint64 public highestHeight;

    event Attested(uint64 indexed layerHeight, bytes32 indexed stateRoot, address indexed by);
    event Conflict(uint64 indexed layerHeight, bytes32 firstRoot, bytes32 secondRoot, address indexed by);

    error UnknownChain();
    error ZeroCreator();
    error PrecompileUnavailable();
    error InvalidAnchor(Result result);

    /// @param creator_ the rollup creator's address (its qor1 bech32 bytes)
    /// @param chainId_ QoreChain chain id; must match the EVM chain this is deployed on
    /// @param layerId_ the layer id the rollup's anchors name
    constructor(address creator_, string memory chainId_, string memory layerId_) {
        if (creator_ == address(0)) revert ZeroCreator();
        bytes32 c = keccak256(bytes(chainId_));
        bool known = (block.chainid == 9800 && c == keccak256("qorechain-diana"))
            || (block.chainid == 9801 && c == keccak256("qorechain-vladi"));
        if (!known || bytes(layerId_).length == 0) revert UnknownChain();
        creator = creator_;
        evmChainId = block.chainid;
        chainId = chainId_;
        layerId = layerId_;
        signPrefix = abi.encodePacked(
            ANCHOR_DOMAIN_V2,
            uint64(bytes(chainId_).length),
            chainId_,
            uint64(bytes(layerId_).length),
            layerId_
        );
    }

    /// @notice The exact bytes the creator signed for this anchor (QoreChain's v2 anchor message):
    ///         ANCHOR_DOMAIN_V2 | u64be(len) chainId | u64be(len) layerId | u64be layerHeight
    ///         | u64be(32) stateRoot | u64be(len) validatorSetHash | u64be transactionCount
    ///         | u64be(len) compressedStateProof
    function anchorMessage(Anchor calldata a) public view returns (bytes memory) {
        // Built in three parts to stay within the legacy code generator's stack limit.
        bytes memory head = abi.encodePacked(signPrefix, a.layerHeight, uint64(32), a.stateRoot);
        bytes memory mid = abi.encodePacked(uint64(a.validatorSetHash.length), a.validatorSetHash, a.transactionCount);
        return abi.encodePacked(head, mid, uint64(a.compressedStateProof.length), a.compressedStateProof);
    }

    /// @notice The creator's ML-DSA-87 public key as the chain holds it now, or empty if it is not usable
    ///         (not registered, another algorithm, no proof of possession, or the wrong length).
    function creatorKey() public view returns (bytes memory pubkey) {
        (bool ok, bytes memory ret) = PQC_KEY_STATUS.staticcall(abi.encodeCall(IQorePQC.pqcKeyStatus, (creator)));
        // (bool, uint8, bytes, bool) encodes to at least 5 words; an inactive precompile returns nothing.
        if (!ok || ret.length < 160) revert PrecompileUnavailable();
        (bool registered, uint8 alg, bytes memory pk, bool proven) = abi.decode(ret, (bool, uint8, bytes, bool));
        if (!registered || alg != ALG_ML_DSA_87 || !proven || pk.length != ML_DSA_87_PUBKEY_LEN) return "";
        return pk;
    }

    /// @notice Check an anchor without recording it (free with eth_call).
    function check(Anchor calldata a) public view returns (Result) {
        if (a.signature.length != ML_DSA_87_SIG_LEN) return Result.BadSignatureLength;
        bytes memory pk = creatorKey();
        if (pk.length == 0) return Result.KeyNotUsable;
        (bool ok, bytes memory ret) =
            PQC_VERIFY.staticcall(abi.encodeCall(IQorePQC.pqcVerify, (pk, a.signature, anchorMessage(a))));
        if (!ok || ret.length != 32) revert PrecompileUnavailable();
        return abi.decode(ret, (bool)) ? Result.Valid : Result.BadSignature;
    }

    /// @notice Check an anchor and record its state root under its layer height. Anyone may call this.
    /// @return recorded true if this call recorded a new height; false if the same root was already
    ///         recorded, or if this anchor conflicts with the recorded one (the height is then marked).
    function attest(Anchor calldata a) public returns (bool recorded) {
        Result r = check(a);
        if (r != Result.Valid) revert InvalidAnchor(r);

        Record storage rec = records[a.layerHeight];
        if (rec.attestedAt == 0) {
            rec.stateRoot = a.stateRoot;
            rec.attestedAt = uint64(block.timestamp);
            rec.attestedBlock = uint64(block.number);
            if (attestedCount == 0 || a.layerHeight > highestHeight) highestHeight = a.layerHeight;
            attestedCount += 1;
            emit Attested(a.layerHeight, a.stateRoot, msg.sender);
            return true;
        }
        if (rec.stateRoot == a.stateRoot || rec.conflicted) return false;
        rec.conflicted = true;
        conflictingRoot[a.layerHeight] = a.stateRoot;
        conflictCount += 1;
        emit Conflict(a.layerHeight, rec.stateRoot, a.stateRoot, msg.sender);
        return false;
    }

    /// @notice Attest several anchors in one transaction; skips nothing silently (any invalid one reverts all).
    function attestMany(Anchor[] calldata anchors) external returns (uint256 newlyRecorded) {
        for (uint256 i = 0; i < anchors.length; i++) {
            if (attest(anchors[i])) newlyRecorded += 1;
        }
    }

    /// @notice Whether `stateRoot` is the attested, unconflicted root for `layerHeight`.
    function isAttested(uint64 layerHeight, bytes32 stateRoot) external view returns (bool) {
        Record storage rec = records[layerHeight];
        return rec.attestedAt != 0 && !rec.conflicted && rec.stateRoot == stateRoot;
    }
}
