// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Compound-v2 style market interface (Venus and its forks on BNB Smart Chain).
interface IVToken {
    function underlying() external view returns (address);
    function mint(uint256 mintAmount) external returns (uint256);
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
    function exchangeRateCurrent() external returns (uint256);
    function getCash() external view returns (uint256);
}
