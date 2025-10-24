// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * ERC20 with:
 * - unlimited supply
 * - owner-set pricePerTokenWei (defaults to 0)
 * - buy(to, amount) payable (mints to any address)
 * - minter allowances (type(uint256).max = unlimited)
 * - owner can withdraw ETH
 */
contract RewardToken is ERC20, Ownable {
    uint256 public pricePerTokenWei; // default 0 = free
    mapping(address => uint256) public minterAllowance; // minter -> remaining

    event PriceUpdated(uint256 priceWei);
    event MinterAllowanceUpdated(address indexed minter, uint256 allowance);
    event TokensPurchased(address indexed payer, address indexed to, uint256 amount, uint256 value);
    event TokensMinted(address indexed minter, address indexed to, uint256 amount);
    event EthWithdrawn(address indexed to, uint256 amount);

    constructor(string memory name_, string memory symbol_, address initialOwner)
        ERC20(name_, symbol_) 
        Ownable(initialOwner)
    {
        pricePerTokenWei = 0;
    }

    // ----- owner controls -----
    function setPricePerTokenWei(uint256 newPrice) external onlyOwner {
        pricePerTokenWei = newPrice;
        emit PriceUpdated(newPrice);
    }

    function setMinterAllowance(address minter, uint256 allowance) external onlyOwner {
        minterAllowance[minter] = allowance;
        emit MinterAllowanceUpdated(minter, allowance);
    }

    function withdrawETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad to");
        require(amount <= address(this).balance, "insufficient");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "withdraw failed");
        emit EthWithdrawn(to, amount);
    }

    // ----- public flows -----
    function buy(address to, uint256 amount) external payable {
        require(to != address(0), "bad to");
        require(amount > 0, "amount>0");
        uint256 required = pricePerTokenWei * amount;
        require(msg.value == required, "wrong ETH");
        _mint(to, amount);
        emit TokensPurchased(msg.sender, to, amount, msg.value);
    }

    function mintTo(address to, uint256 amount) external {
        require(to != address(0), "bad to");
        require(amount > 0, "amount>0");
        uint256 a = minterAllowance[msg.sender];
        require(a > 0, "not minter");
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            unchecked { minterAllowance[msg.sender] = a - amount; }
        }
        _mint(to, amount);
        emit TokensMinted(msg.sender, to, amount);
    }

    receive() external payable {}
}
