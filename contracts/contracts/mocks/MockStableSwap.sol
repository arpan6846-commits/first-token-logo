// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Simplified two-coin stable pool for tests: 1 LP == virtualPrice units of coin0.
contract MockStableSwap {
    address[2] public coinList;
    MockERC20 public immutable lp;
    uint256 public virtualPrice = 1e18;

    constructor(address coin0, address coin1) {
        coinList = [coin0, coin1];
        lp = new MockERC20("Mock LP", "MLP");
    }

    function coins(uint256 i) external view returns (address) {
        return coinList[i];
    }

    function token() external view returns (address) {
        return address(lp);
    }

    function get_virtual_price() external view returns (uint256) {
        return virtualPrice;
    }

    function calc_withdraw_one_coin(uint256 amount, uint256) public view returns (uint256) {
        return (amount * virtualPrice) / 1e18;
    }

    function add_liquidity(uint256[2] calldata amounts, uint256 minMint) external {
        uint256 total;
        for (uint256 i; i < 2; ++i) {
            if (amounts[i] > 0) {
                IERC20(coinList[i]).transferFrom(msg.sender, address(this), amounts[i]);
                total += amounts[i];
            }
        }
        uint256 minted = (total * 1e18) / virtualPrice;
        require(minted >= minMint, "slippage");
        lp.mint(msg.sender, minted);
    }

    function remove_liquidity_one_coin(uint256 amount, uint256 i, uint256 minAmount) external {
        uint256 out = calc_withdraw_one_coin(amount, i);
        require(out >= minAmount, "slippage");
        lp.burn(msg.sender, amount);
        IERC20(coinList[i]).transfer(msg.sender, out);
    }

    /// @dev Test helper: trading fees accrue as real coin balance and a higher virtual price.
    function accrueFees(uint256 amount) external {
        MockERC20(coinList[0]).mint(address(this), amount);
        uint256 supply = lp.totalSupply();
        uint256 value = (supply * virtualPrice) / 1e18;
        virtualPrice = ((value + amount) * 1e18) / supply;
    }
}
