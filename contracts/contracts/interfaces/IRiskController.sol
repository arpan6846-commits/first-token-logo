// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRiskController {
    function isAllowedToken(address token) external view returns (bool);
    function minReserveBps() external view returns (uint16);
    function maxAllocationBps(address adapter) external view returns (uint16);
    function riskScore(address adapter) external view returns (uint8);
    function canReceiveDeposits(address adapter) external view returns (bool);
    function checkAllocation(address adapter, uint256 newBookValue, uint256 vaultTotalAssets) external view;
}
