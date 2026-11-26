// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal two-coin StableSwap pool interface (PancakeSwap StableSwap / Curve style).
interface IStableSwap {
    function coins(uint256 i) external view returns (address);
    function token() external view returns (address);
    function get_virtual_price() external view returns (uint256);
    function calc_withdraw_one_coin(uint256 tokenAmount, uint256 i) external view returns (uint256);
    function add_liquidity(uint256[2] calldata amounts, uint256 minMintAmount) external;
    function remove_liquidity_one_coin(uint256 tokenAmount, uint256 i, uint256 minAmount) external;
}
