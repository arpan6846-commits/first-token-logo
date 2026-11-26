// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRewardDistributor {
    function beforeBalanceChange(address from, address to) external;
    function afterBalanceChange(address from, address to) external;
    function notifyReward(uint256 amount) external;
}
