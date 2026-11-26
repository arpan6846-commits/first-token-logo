// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IProfitAccounting {
    function recordStrategyResult(uint256 strategyId, uint256 realizedGain, uint256 recognizedLoss) external;
    function settle(uint256 realizedGain, uint256 executionCost, uint256 totalAssets, uint256 totalSupply)
        external
        returns (uint256 distributable);
    function recordDistribution(uint256 fee, uint256 rewards) external;
    function highWaterMark() external view returns (uint256);
}
