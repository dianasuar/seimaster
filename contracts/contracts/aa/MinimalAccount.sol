// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MinimalAccount {
    address public owner;
    bool private _initialized;

    event Executed(address indexed to, uint256 value, bytes data);
    event OwnerChanged(address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function initialize(address _owner) external {
        require(!_initialized, "initialized");
        require(_owner != address(0), "bad owner");
        owner = _owner;
        _initialized = true;
        emit OwnerChanged(_owner);
    }

    /// @notice simple execute (EOA-like). Later we can swap to EntryPoint flow.
    function execute(address to, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        require(ok, "exec failed");
        emit Executed(to, value, data);
        return ret;
    }

    receive() external payable {}
}
