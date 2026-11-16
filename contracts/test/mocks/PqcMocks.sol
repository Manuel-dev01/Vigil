// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @notice Test stand-in for pqcVerify (0x…0a01). It returns true only for (pubkey, signature, message)
///         triples a test has explicitly marked valid, so any change to any byte fails, as a real
///         signature check would. Etched at the precompile address with vm.etch.
contract MockPqcVerify {
    mapping(bytes32 => bool) public valid;

    function markValid(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external {
        valid[keccak256(abi.encode(pubkey, signature, message))] = true;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        return valid[keccak256(abi.encode(pubkey, signature, message))];
    }
}

/// @notice Test stand-in for pqcKeyStatus (0x…0a02), configurable per account.
contract MockPqcKeyStatus {
    struct Status {
        bool registered;
        uint8 alg;
        bytes pubkey;
        bool proven;
    }

    mapping(address => Status) internal statuses;

    function set(address account, bool registered, uint8 alg, bytes calldata pubkey, bool proven) external {
        statuses[account] = Status(registered, alg, pubkey, proven);
    }

    function pqcKeyStatus(address account) external view returns (bool, uint8, bytes memory, bool) {
        Status storage s = statuses[account];
        return (s.registered, s.alg, s.pubkey, s.proven);
    }
}

/// @notice A minimal ERC-20 for vault tests.
contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}
