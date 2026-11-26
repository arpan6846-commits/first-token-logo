// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BaseAdapter} from "./BaseAdapter.sol";
import {IStableSwap} from "../interfaces/IStableSwap.sol";

/// @title LiquidityAdapter
/// @notice Provides single-sided USDT liquidity to a two-coin stablecoin StableSwap pool.
/// @dev Valuation is the MINIMUM of (LP * virtual price) and the pool's own single-coin withdrawal quote.
///      This is conservative against depegs; a manipulated quote can only make the position look smaller.
///      Exposure to the paired stablecoin is tracked as "stablecoin risk" in the RiskController.
contract LiquidityAdapter is BaseAdapter {
    using SafeERC20 for IERC20;

    IStableSwap public immutable pool;
    IERC20 public immutable lpToken;
    uint256 public immutable coinIndex;
    uint16 public immutable maxSlippageBps;

    error PoolMismatch();

    constructor(address asset_, address router_, address pool_, uint16 maxSlippageBps_) BaseAdapter(asset_, router_) {
        IStableSwap p = IStableSwap(pool_);
        uint256 idx;
        if (p.coins(0) == asset_) idx = 0;
        else if (p.coins(1) == asset_) idx = 1;
        else revert PoolMismatch();
        require(maxSlippageBps_ <= 200, "slippage too high");
        pool = p;
        lpToken = IERC20(p.token());
        coinIndex = idx;
        maxSlippageBps = maxSlippageBps_;
    }

    function protocol() external view override returns (address) {
        return address(pool);
    }

    function totalAssets() public view override returns (uint256) {
        uint256 lp = lpToken.balanceOf(address(this));
        if (lp == 0) return 0;
        uint256 byVirtual = (lp * pool.get_virtual_price()) / 1e18;
        uint256 byQuote = pool.calc_withdraw_one_coin(lp, coinIndex);
        return byVirtual < byQuote ? byVirtual : byQuote;
    }

    function availableProtocolCash() public view override returns (uint256) {
        return _asset.balanceOf(address(pool));
    }

    function _supply(uint256 amount) internal override {
        _asset.forceApprove(address(pool), amount);
        uint256[2] memory amounts;
        amounts[coinIndex] = amount;
        uint256 minLp = (amount * 1e18 / pool.get_virtual_price()) * (10_000 - maxSlippageBps) / 10_000;
        pool.add_liquidity(amounts, minLp);
    }

    function _redeem(uint256 amount) internal override returns (uint256 received) {
        uint256 lpBal = lpToken.balanceOf(address(this));
        uint256 value = totalAssets();
        if (value == 0) return 0;
        uint256 lpNeeded = (lpBal * amount + value - 1) / value; // round up
        if (lpNeeded > lpBal) lpNeeded = lpBal;
        uint256 before = _asset.balanceOf(address(this));
        pool.remove_liquidity_one_coin(lpNeeded, coinIndex, amount * (10_000 - maxSlippageBps) / 10_000);
        received = _asset.balanceOf(address(this)) - before;
    }

    function _redeemAll() internal override returns (uint256 received) {
        uint256 lpBal = lpToken.balanceOf(address(this));
        if (lpBal > 0) {
            uint256 quote = pool.calc_withdraw_one_coin(lpBal, coinIndex);
            pool.remove_liquidity_one_coin(lpBal, coinIndex, quote * (10_000 - maxSlippageBps) / 10_000);
        }
        received = _asset.balanceOf(address(this));
    }
}
