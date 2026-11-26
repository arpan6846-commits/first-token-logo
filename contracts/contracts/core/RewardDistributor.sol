// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRewardDistributor} from "../interfaces/IRewardDistributor.sol";

/// @title RewardDistributor
/// @notice Holds realized, already-funded rewards and attributes them pro-rata to vault shareholders.
/// @dev Rewards enter ONLY through `notifyReward`, which pulls the exact amount of cash from the vault
///      in the same call. Every unit of reward liability is therefore backed 1:1 by tokens held here,
///      segregated from principal. Claims can never touch another user's principal.
contract RewardDistributor is IRewardDistributor, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant ACC_PRECISION = 1e36;

    IERC20 public immutable rewardToken;
    IERC4626 public immutable vault;

    uint256 public accRewardPerShare;
    /// @notice Sum of all rewards notified but not yet claimed/compounded (rounded up per user).
    uint256 public totalLiabilities;
    uint256 public totalNotified;
    uint256 public totalClaimed;
    uint256 public totalCompounded;

    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public storedPending;
    mapping(address => uint256) public claimedBy;
    mapping(address => uint256) public compoundedBy;
    mapping(address => bool) public autoCompound;

    event RewardNotified(uint256 amount, uint256 accRewardPerShare, uint256 totalShares);
    event Claimed(address indexed user, uint256 amount);
    event Compounded(address indexed user, uint256 amount, uint256 shares, address indexed caller);
    event AutoCompoundSet(address indexed user, bool enabled);

    error OnlyVault();
    error NoShares();
    error NothingToClaim();
    error AutoCompoundDisabled();

    modifier onlyVault() {
        if (msg.sender != address(vault)) revert OnlyVault();
        _;
    }

    constructor(address vault_, address rewardToken_) {
        vault = IERC4626(vault_);
        rewardToken = IERC20(rewardToken_);
    }

    // ------------------------------------------------------------------ vault hooks

    function beforeBalanceChange(address from, address to) external override onlyVault {
        if (from != address(0)) _checkpoint(from);
        if (to != address(0) && to != from) _checkpoint(to);
    }

    function afterBalanceChange(address from, address to) external override onlyVault {
        if (from != address(0)) _syncDebt(from);
        if (to != address(0) && to != from) _syncDebt(to);
    }

    /// @notice Pulls `amount` of realized profit from the vault and allocates it pro-rata.
    function notifyReward(uint256 amount) external override onlyVault {
        uint256 supply = vault.totalSupply();
        if (supply == 0) revert NoShares();
        rewardToken.safeTransferFrom(address(vault), address(this), amount);
        accRewardPerShare += (amount * ACC_PRECISION) / supply;
        totalLiabilities += amount;
        totalNotified += amount;
        emit RewardNotified(amount, accRewardPerShare, supply);
    }

    // ------------------------------------------------------------------ user actions

    function setAutoCompound(bool enabled) external {
        autoCompound[msg.sender] = enabled;
        emit AutoCompoundSet(msg.sender, enabled);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        amount = _takePending(msg.sender);
        if (amount == 0) revert NothingToClaim();
        totalClaimed += amount;
        claimedBy[msg.sender] += amount;
        rewardToken.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function compound() external nonReentrant returns (uint256 shares) {
        shares = _compound(msg.sender);
    }

    /// @notice Permissionless keeper entry point. Only works for users who opted in, and can only ever
    ///         redeposit the user's own rewards into the vault on the user's behalf.
    function compoundFor(address user) external nonReentrant returns (uint256 shares) {
        if (!autoCompound[user]) revert AutoCompoundDisabled();
        shares = _compound(user);
    }

    // ------------------------------------------------------------------ views

    function pendingReward(address user) public view returns (uint256) {
        uint256 bal = vault.balanceOf(user);
        uint256 accrued = (bal * accRewardPerShare) / ACC_PRECISION;
        uint256 debt = rewardDebt[user];
        return storedPending[user] + (accrued > debt ? accrued - debt : 0);
    }

    /// @notice Tokens held above outstanding liabilities (rounding dust). Must never be negative.
    function fundingSurplus() external view returns (int256) {
        return int256(rewardToken.balanceOf(address(this))) - int256(totalLiabilities);
    }

    // ------------------------------------------------------------------ internals

    function _compound(address user) internal returns (uint256 shares) {
        uint256 amount = _takePending(user);
        if (amount == 0) revert NothingToClaim();
        totalCompounded += amount;
        compoundedBy[user] += amount;
        rewardToken.forceApprove(address(vault), amount);
        shares = vault.deposit(amount, user);
        emit Compounded(user, amount, shares, msg.sender);
    }

    function _takePending(address user) internal returns (uint256 amount) {
        _checkpoint(user);
        amount = storedPending[user];
        if (amount > totalLiabilities) amount = totalLiabilities; // rounding guard
        storedPending[user] = 0;
        totalLiabilities -= amount;
    }

    function _checkpoint(address user) internal {
        uint256 bal = vault.balanceOf(user);
        uint256 accrued = (bal * accRewardPerShare) / ACC_PRECISION;
        uint256 debt = rewardDebt[user];
        if (accrued > debt) storedPending[user] += accrued - debt;
        rewardDebt[user] = accrued;
    }

    function _syncDebt(address user) internal {
        rewardDebt[user] = (vault.balanceOf(user) * accRewardPerShare) / ACC_PRECISION;
    }
}
