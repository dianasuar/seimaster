// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * Minimal Paymaster (for ERC-4337)
 * - stores ETH for gas sponsorship
 * - only sponsors allowed target contracts
 * - can be extended for signature-based policies
 */

interface IEntryPoint {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 amount) external;
}

contract SimplePaymaster {
    address public owner;
    IEntryPoint public entryPoint;

    mapping(address => bool) public allowedTargets;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _owner, address _entryPoint) {
        owner = _owner;
        entryPoint = IEntryPoint(_entryPoint);
    }

    /// @notice deposit ETH into EntryPoint for sponsorship
    function deposit() external payable onlyOwner {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice withdraw ETH from EntryPoint back to owner
    function withdraw(uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(payable(owner), amount);
    }

    /// @notice add/remove whitelisted targets
    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
    }

    /// @notice check if a target is allowed
    function isAllowed(address target) external view returns (bool) {
        return allowedTargets[target];
    }

    receive() external payable {}
}
