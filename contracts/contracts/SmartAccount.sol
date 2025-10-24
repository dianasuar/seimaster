// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * Minimal ERC-4337 Smart Account
 * - Has an `execute()` function that EntryPoint calls
 * - Accepts ETH deposits
 */

interface IEntryPoint {
    function depositTo(address account) external payable;
}

contract SmartAccount {
    address public owner;
    IEntryPoint public entryPoint;

    constructor(address _owner, address _entryPoint) {
        owner = _owner;
        entryPoint = IEntryPoint(_entryPoint);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // basic call execution
    function execute(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (bytes memory)
    {
        (bool success, bytes memory result) = target.call{value: value}(data);
        require(success, "call failed");
        return result;
    }

    // deposit ETH to EntryPoint for gas sponsorship
    function depositToEntryPoint() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    receive() external payable {}
}
