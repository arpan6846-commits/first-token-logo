// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseAdapter} from "./BaseAdapter.sol";
import {IVToken} from "../interfaces/IVToken.sol";

/// @title LendingAdapter
/// @notice Supplies USDT to one Compound-v2 style lending market on BNB Smart Chain (e.g. Venus).
///         Deploy one instance per market ("BNB lending market A", "BNB lending market B").
/// @dev Protocol incentive tokens (e.g. XVS) are NOT counted as income here. Converting them would need
///      a separately reviewed swap adapter with oracle-checked slippage.
contract LendingAdapter is BaseAdapter {
    using SafeERC20 for IERC20;

    IVToken public immutable market;

    error MarketMismatch();
    error MarketError(uint256 code);

    constructor(address asset_, address router_, address market_) BaseAdapter(asset_, router_) {
        if (IVToken(market_).underlying() != asset_) revert MarketMismatch();
        market = IVToken(market_);
    }

    function protocol() external view override returns (address) {
        return address(market);
    }

    function totalAssets() public view override returns (uint256) {
        return (market.balanceOf(address(this)) * market.exchangeRateStored()) / 1e18;
    }

    function availableProtocolCash() public view override returns (uint256) {
        return market.getCash();
    }

    function _accrue() internal override {
        market.exchangeRateCurrent();
    }

    function _supply(uint256 amount) internal override {
        _asset.forceApprove(address(market), amount);
        uint256 code = market.mint(amount);
        if (code != 0) revert MarketError(code);
    }

    function _redeem(uint256 amount) internal override returns (uint256 received) {
        uint256 before = _asset.balanceOf(address(this));
        uint256 code = market.redeemUnderlying(amount);
        if (code != 0) revert MarketError(code);
        received = _asset.balanceOf(address(this)) - before;
    }

    function _redeemAll() internal override returns (uint256 received) {
        _accrue();
        uint256 amt = totalAssets();
        uint256 cash = market.getCash();
        if (amt > cash) amt = cash;
        if (amt == 0) return _asset.balanceOf(address(this));
        _redeem(amt);
        received = _asset.balanceOf(address(this));
    }
}
