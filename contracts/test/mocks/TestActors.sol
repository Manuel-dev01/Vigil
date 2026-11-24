// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice A payout or recipient that can be told to refuse native coin, to test what the vaults do when
///         a transfer to it fails.
contract TogglePayout {
    bool public accept;

    constructor(bool accept_) {
        accept = accept_;
    }

    function setAccept(bool accept_) external {
        accept = accept_;
    }

    receive() external payable {
        require(accept, "refused");
    }
}

/// @notice A payout or recipient that, when paid, calls back into a target once with calldata a test set
///         beforehand, records whether that call succeeded and what it returned, and then accepts the
///         payment whatever the outcome (so the outer call is not undone by the inner one failing).
contract Reenterer {
    address public target;
    bytes public data;
    bool public armed;
    bool public attempted;
    bool public innerOk;
    bytes public innerRet;
    uint256 public received;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
        attempted = false;
    }

    receive() external payable {
        received += msg.value;
        if (!armed) return;
        armed = false;
        attempted = true;
        (innerOk, innerRet) = target.call(data);
    }
}

// ------------------------------------------------------------------ ERC-20 stand-ins with odd behaviour

/// @notice transfer() returns false instead of reverting (allowed by ERC-20).
contract FalseToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice transfer() moves the balance and returns nothing (USDT-style, pre-ERC-20-final tokens).
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice transfer() moves the balance and then returns whatever raw bytes the test configured, so a test
///         can feed the vault a 1-byte answer, a non-boolean word, or a longer-than-one-word answer.
contract RawReturnToken {
    mapping(address => uint256) public balanceOf;
    bytes public answer;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setAnswer(bytes calldata answer_) external {
        answer = answer_;
    }

    fallback() external {
        // Only transfer(address,uint256) is ever called on it by the vault.
        require(msg.sig == bytes4(keccak256("transfer(address,uint256)")), "unknown");
        (address to, uint256 amount) = abi.decode(msg.data[4:], (address, uint256));
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        bytes memory a = answer;
        assembly {
            return(add(a, 32), mload(a))
        }
    }
}

/// @notice transfer() always reverts.
contract RevertingToken {
    function transfer(address, uint256) external pure returns (bool) {
        revert("paused");
    }
}

/// @notice A precompile stand-in that reverts on every call (a precompile that errors rather than being
///         inactive).
contract RevertingPrecompile {
    fallback() external {
        revert("precompile error");
    }
}

/// @notice A precompile stand-in that succeeds and returns a single byte: neither empty (inactive) nor a
///         well-formed answer.
contract ShortAnswerPrecompile {
    fallback() external {
        assembly {
            mstore(0, 0x0100000000000000000000000000000000000000000000000000000000000000)
            return(0, 1)
        }
    }
}
