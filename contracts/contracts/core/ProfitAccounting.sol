// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IProfitAccounting} from "../interfaces/IProfitAccounting.sol";

/// @title ProfitAccounting
/// @notice Transparent ledger of realized income, recognized losses, execution costs, fees and the
///         high-water mark that decides how much (if any) realized profit may be distributed.
/// @dev Rules enforced here:
///      1. Only REALIZED gains that have physically arrived in the vault as cash can be distributed.
///         Deposits never pass through this contract, so they can never be counted as revenue.
///      2. Distribution only happens above the high-water mark (HWM) of price-per-share. Any loss first
///         has to be earned back (loss carryforward) before rewards resume.
///      3. Distributable profit is additionally capped by this harvest's net realized gain, so principal
///         (or an external donation) can never be paid out as rewards.
contract ProfitAccounting is IProfitAccounting {
    uint256 public constant PPS_SCALE = 1e18;

    address public immutable vault;

    /// @notice High-water mark of the vault's price per share, scaled by 1e18.
    uint256 public override highWaterMark;

    uint256 public cumulativeRealizedGain;
    uint256 public cumulativeRecognizedLoss;
    uint256 public cumulativeExecutionCost;
    uint256 public cumulativeRecovered; // net gains retained to rebuild NAV after losses
    uint256 public cumulativeDistributable;
    uint256 public cumulativeFees;
    uint256 public cumulativeRewards;
    uint256 public settlements;

    struct StrategyPnl {
        uint256 realizedGain;
        uint256 recognizedLoss;
        uint64 lastHarvest;
    }

    mapping(uint256 => StrategyPnl) public strategyPnl;

    event StrategyResult(uint256 indexed strategyId, uint256 realizedGain, uint256 recognizedLoss);
    event Settled(
        uint256 indexed settlementId,
        uint256 realizedGain,
        uint256 executionCost,
        uint256 recovered,
        uint256 distributable,
        uint256 pricePerShare,
        uint256 highWaterMark,
        uint256 lossCarryforward
    );
    event Distributed(uint256 fee, uint256 rewards);

    error OnlyVault();
    error CostExceedsGain();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address vault_) {
        vault = vault_;
        highWaterMark = PPS_SCALE;
    }

    function recordStrategyResult(uint256 strategyId, uint256 realizedGain, uint256 recognizedLoss)
        external
        override
        onlyVault
    {
        StrategyPnl storage p = strategyPnl[strategyId];
        p.realizedGain += realizedGain;
        p.recognizedLoss += recognizedLoss;
        p.lastHarvest = uint64(block.timestamp);
        cumulativeRecognizedLoss += recognizedLoss;
        emit StrategyResult(strategyId, realizedGain, recognizedLoss);
    }

    /// @param realizedGain gross cash gain received by the vault in this harvest
    /// @param executionCost keeper reimbursement already paid out of `realizedGain`
    /// @param totalAssets vault book NAV after gains landed, losses recognized and costs paid
    /// @param totalSupply vault share supply
    /// @return distributable amount of cash that may leave NAV as fees + rewards
    function settle(uint256 realizedGain, uint256 executionCost, uint256 totalAssets, uint256 totalSupply)
        external
        override
        onlyVault
        returns (uint256 distributable)
    {
        if (executionCost > realizedGain) revert CostExceedsGain();
        uint256 netGain = realizedGain - executionCost;
        cumulativeRealizedGain += realizedGain;
        cumulativeExecutionCost += executionCost;

        uint256 hwm = highWaterMark;
        uint256 pps = _pps(totalAssets, totalSupply);

        if (totalSupply > 0 && pps > hwm) {
            uint256 aboveHwm = totalAssets - (hwm * totalSupply) / PPS_SCALE;
            distributable = aboveHwm < netGain ? aboveHwm : netGain;
        }
        uint256 recovered = netGain - distributable;
        cumulativeRecovered += recovered;
        cumulativeDistributable += distributable;

        uint256 ppsAfter = _pps(totalAssets - distributable, totalSupply);
        if (ppsAfter > hwm) highWaterMark = ppsAfter;

        uint256 id = ++settlements;
        emit Settled(
            id,
            realizedGain,
            executionCost,
            recovered,
            distributable,
            ppsAfter,
            highWaterMark,
            _lossCarryforward(totalAssets - distributable, totalSupply)
        );
    }

    function recordDistribution(uint256 fee, uint256 rewards) external override onlyVault {
        cumulativeFees += fee;
        cumulativeRewards += rewards;
        emit Distributed(fee, rewards);
    }

    /// @notice Amount of NAV that has to be earned back before any new rewards are distributed.
    function lossCarryforward(uint256 totalAssets, uint256 totalSupply) external view returns (uint256) {
        return _lossCarryforward(totalAssets, totalSupply);
    }

    function _lossCarryforward(uint256 totalAssets, uint256 totalSupply) internal view returns (uint256) {
        if (totalSupply == 0) return 0;
        uint256 hwmAssets = (highWaterMark * totalSupply) / PPS_SCALE;
        return hwmAssets > totalAssets ? hwmAssets - totalAssets : 0;
    }

    function _pps(uint256 totalAssets, uint256 totalSupply) internal pure returns (uint256) {
        if (totalSupply == 0) return PPS_SCALE;
        return (totalAssets * PPS_SCALE) / totalSupply;
    }
}
