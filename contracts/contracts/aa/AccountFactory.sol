// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/proxy/Clones.sol";

interface IMinimalAccount {
    function initialize(address _owner) external;
}

contract AccountFactory {
    using Clones for address;

    address public immutable implementation;

    event AccountDeployed(address indexed account, bytes32 salt, address owner);

    constructor(address _implementation) {
        implementation = _implementation;
    }

    /// @notice deterministic address from a user-supplied string (no deploy)
    function getAddress(string calldata userId) external view returns (address predicted) {
        bytes32 salt = keccak256(abi.encodePacked(userId));
        predicted = Clones.predictDeterministicAddress(implementation, salt, address(this));
    }

    /// @notice deploys if not already, initializes owner; returns the account address
    function createAccount(string calldata userId, address owner) external returns (address account) {
        bytes32 salt = keccak256(abi.encodePacked(userId));
        account = Clones.predictDeterministicAddress(implementation, salt, address(this));

        if (account.code.length == 0) {
            account = implementation.cloneDeterministic(salt);
            IMinimalAccount(account).initialize(owner);
            emit AccountDeployed(account, salt, owner);
        }
    }
}
