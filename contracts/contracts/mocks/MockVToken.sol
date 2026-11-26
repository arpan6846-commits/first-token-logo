// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Simplified Compound-v2 market for tests. Interest is simulated by minting underlying into
///         the market and raising the exchange rate (i.e. real cash backs every unit of yield).
contract MockVToken {
    MockERC20 public immutable underlyingToken;
    uint256 public exchangeRateStored = 1e18;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    uint256 public cashLock; // simulate high utilization: cash that cannot be withdrawn

    constructor(address underlying_) {
        underlyingToken = MockERC20(underlying_);
    }

    function underlying() external view returns (address) {
        return address(underlyingToken);
    }

    function getCash() public view returns (uint256) {
        uint256 bal = underlyingToken.balanceOf(address(this));
        return bal > cashLock ? bal - cashLock : 0;
    }

    function exchangeRateCurrent() external view returns (uint256) {
        return exchangeRateStored;
    }

    function mint(uint256 amount) external returns (uint256) {
        IERC20(address(underlyingToken)).transferFrom(msg.sender, address(this), amount);
        uint256 v = (amount * 1e18) / exchangeRateStored;
        balanceOf[msg.sender] += v;
        totalSupply += v;
        return 0;
    }

    function redeemUnderlying(uint256 amount) external returns (uint256) {
        if (amount > getCash()) return 14; // INSUFFICIENT_CASH style error code
        uint256 v = (amount * 1e18 + exchangeRateStored - 1) / exchangeRateStored;
        if (v > balanceOf[msg.sender]) v = balanceOf[msg.sender];
        balanceOf[msg.sender] -= v;
        totalSupply -= v;
        IERC20(address(underlyingToken)).transfer(msg.sender, amount);
        return 0;
    }

    /// @dev Test helper: accrue `interest` of real underlying to all suppliers.
    function accrueInterest(uint256 interest) external {
        underlyingToken.mint(address(this), interest);
        uint256 total = (totalSupply * exchangeRateStored) / 1e18;
        exchangeRateStored = ((total + interest) * 1e18) / totalSupply;
    }

    /// @dev Test helper: simulate bad debt / exploit loss.
    function realizeLoss(uint256 loss) external {
        underlyingToken.burn(address(this), loss);
        uint256 total = (totalSupply * exchangeRateStored) / 1e18;
        exchangeRateStored = ((total - loss) * 1e18) / totalSupply;
    }

    function setCashLock(uint256 lock) external {
        cashLock = lock;
    }
}
