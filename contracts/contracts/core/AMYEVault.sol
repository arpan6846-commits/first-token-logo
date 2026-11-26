// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AdaptiveYieldRouter} from "./AdaptiveYieldRouter.sol";
import {IRiskController} from "../interfaces/IRiskController.sol";
import {IProfitAccounting} from "../interfaces/IProfitAccounting.sol";
import {IRewardDistributor} from "../interfaces/IRewardDistributor.sol";

/// @title AMYEVault
/// @notice USDT vault for the Adaptive Multi-Strategy Yield Engine. Users deposit USDT and receive
///         amyUSDT shares representing principal. Realized net profit above the high-water mark is
///         moved into the RewardDistributor as funded rewards; nothing else is ever paid out as yield.
/// @dev Valuation is deliberately conservative: totalAssets = idle cash + sum(min(principal, mark)).
///      Unrealized gains are excluded (not withdrawable cash), unrealized losses are included.
///      There is no admin-funded reward pool, no reward emission schedule and no yield promise.
contract AMYEVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE"); // timelock
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE"); // multisig
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE"); // automation (no custody)
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE"); // guarded-launch allowlist

    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 2_000;
    uint16 public constant MAX_HARVEST_COST_BPS = 1_000; // keeper reimbursement <= 10% of gross gain
    uint256 public constant MAX_WITHDRAWAL_FREEZE = 3 days;

    AdaptiveYieldRouter public immutable router;
    IRiskController public immutable riskController;
    IProfitAccounting public profitAccounting;
    IRewardDistributor public rewardDistributor;

    address public treasury;
    uint16 public performanceFeeBps;
    uint16 public harvestCostBps;
    uint256 public harvestCostCap;
    uint256 public depositCap;
    uint256 public minDeposit;
    /// @notice While true only DEPOSITOR_ROLE accounts may deposit. Defaults to true: public deposits must
    ///         not be opened before audits, legal review and stress testing (see SECURITY.md).
    bool public guardedLaunch = true;
    uint64 public withdrawalsFrozenUntil;
    uint64 public lastHarvest;

    event Harvested(
        address indexed keeper,
        uint256 grossGain,
        uint256 recognizedLoss,
        uint256 executionCost,
        uint256 distributable,
        uint256 performanceFee,
        uint256 rewards,
        uint256 totalAssetsAfter
    );
    event Rebalanced(address indexed keeper, uint256 deployed, uint256 withdrawn, uint256 idleAfter);
    event StrategyExited(uint256 indexed id, uint256 returned, uint256 principalBefore);
    event FeeConfigSet(address treasury, uint16 performanceFeeBps, uint16 harvestCostBps, uint256 harvestCostCap);
    event LimitsSet(uint256 depositCap, uint256 minDeposit);
    event GuardedLaunchSet(bool guarded);
    event WithdrawalsFrozen(uint64 until);
    event ModulesSet(address profitAccounting, address rewardDistributor);

    error ModulesAlreadySet();
    error NotAllowedDepositor();
    error DepositCapExceeded();
    error BelowMinDeposit();
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error WithdrawalsAreFrozen();
    error InvalidConfig();

    constructor(
        IERC20 asset_,
        AdaptiveYieldRouter router_,
        IRiskController riskController_,
        address admin,
        address governance,
        address guardian,
        address treasury_
    ) ERC20("AMYE Vault USDT", "amyUSDT") ERC4626(asset_) {
        if (!riskController_.isAllowedToken(address(asset_))) revert InvalidConfig();
        router = router_;
        riskController = riskController_;
        treasury = treasury_;
        performanceFeeBps = 1_000; // 10% of distributable profit, disclosed in UI
        harvestCostBps = 500;
        harvestCostCap = 50e18;
        depositCap = 100_000e18;
        minDeposit = 10e18;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, governance);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice One-time wiring of the accounting modules (they need the vault address at construction).
    function setModules(IProfitAccounting pa, IRewardDistributor rd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(profitAccounting) != address(0)) revert ModulesAlreadySet();
        profitAccounting = pa;
        rewardDistributor = rd;
        emit ModulesSet(address(pa), address(rd));
    }

    // ================================================================== accounting views

    /// @inheritdoc ERC4626
    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + router.totalBookValue();
    }

    /// @notice Estimated NAV including unrealized gains (informational, not withdrawable).
    function estimatedNav() external view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + router.totalMarkValue();
    }

    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Cash that can be returned to withdrawers right now.
    function availableLiquidity() public view returns (uint256) {
        return idleAssets() + router.totalAvailableLiquidity();
    }

    function pricePerShare() external view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? 1e18 : (totalAssets() * 1e18) / supply;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 ta = totalAssets();
        return ta >= depositCap ? 0 : depositCap - ta;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return convertToShares(maxDeposit(receiver));
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (block.timestamp < withdrawalsFrozenUntil) return 0;
        uint256 owned = convertToAssets(balanceOf(owner));
        uint256 liq = availableLiquidity();
        return owned < liq ? owned : liq;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (block.timestamp < withdrawalsFrozenUntil) return 0;
        uint256 shares = balanceOf(owner);
        uint256 liqShares = convertToShares(availableLiquidity());
        return shares < liqShares ? shares : liqShares;
    }

    // ================================================================== user flows (ERC4626 hooks)

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        bool fromDistributor = caller == address(rewardDistributor);
        if (guardedLaunch && !fromDistributor && !hasRole(DEPOSITOR_ROLE, caller)) revert NotAllowedDepositor();
        if (!fromDistributor && assets < minDeposit) revert BelowMinDeposit();
        if (totalAssets() + assets > depositCap) revert DepositCapExceeded();
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (block.timestamp < withdrawalsFrozenUntil) revert WithdrawalsAreFrozen();
        _ensureLiquidity(assets);
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Keeps reward accounting in sync on every share movement (mint, burn, transfer).
    function _update(address from, address to, uint256 value) internal override {
        IRewardDistributor rd = rewardDistributor;
        if (address(rd) != address(0)) rd.beforeBalanceChange(from, to);
        super._update(from, to, value);
        if (address(rd) != address(0)) rd.afterBalanceChange(from, to);
    }

    function _ensureLiquidity(uint256 assets) internal {
        uint256 idle = idleAssets();
        if (idle >= assets) return;
        uint256 needed = assets - idle;
        uint256 n = router.strategyCount();
        for (uint256 i; i < n && needed > 0; ++i) {
            uint256 liq = router.availableLiquidity(i);
            if (liq == 0) continue;
            uint256 take = liq < needed ? liq : needed;
            uint256 got = router.withdrawFromStrategy(i, take);
            needed = got >= needed ? 0 : needed - got;
        }
        if (needed > 0) revert InsufficientLiquidity(assets, assets - needed);
    }

    // ================================================================== keeper operations

    /// @notice Realize strategy results and distribute only realized net profit above the HWM.
    /// @param executionCost keeper's claimed gas/execution cost, reimbursed only from realized gain and
    ///        capped by `harvestCostBps` and `harvestCostCap`.
    function harvest(uint256 executionCost)
        external
        onlyRole(KEEPER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 distributable)
    {
        uint256 grossGain;
        uint256 totalLoss;
        uint256 n = router.strategyCount();
        for (uint256 i; i < n; ++i) {
            if (!router.isActive(i)) continue;
            (uint256 gain, uint256 loss) = router.harvestStrategy(i);
            profitAccounting.recordStrategyResult(i, gain, loss);
            grossGain += gain;
            totalLoss += loss;
        }
        distributable = _settleAndDistribute(grossGain, totalLoss, executionCost);
        lastHarvest = uint64(block.timestamp);
    }

    /// @notice Moves capital toward the timelocked target weights while preserving the liquid reserve.
    function rebalance() external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        uint256 ta = totalAssets();
        uint256 n = router.strategyCount();
        uint256 withdrawn;
        uint256 deployed;

        // 1. Pull surplus out of over-allocated (or inactive / blocked) strategies.
        for (uint256 i; i < n; ++i) {
            uint256 book = router.bookValue(i);
            uint256 target = router.isActive(i) ? (ta * router.targetBps(i)) / BPS : 0;
            if (book > target) {
                uint256 liq = router.availableLiquidity(i);
                uint256 excess = book - target;
                uint256 amt = excess < liq ? excess : liq;
                if (amt > 0) withdrawn += router.withdrawFromStrategy(i, amt);
            }
        }

        // 2. Deploy idle cash above the reserve into under-allocated strategies.
        uint256 reserveBps = router.reserveTargetBps();
        uint16 minRes = riskController.minReserveBps();
        if (reserveBps < minRes) reserveBps = minRes;
        uint256 reserveTarget = (ta * reserveBps) / BPS;
        uint256 idle = idleAssets();
        uint256 deployable = idle > reserveTarget ? idle - reserveTarget : 0;
        for (uint256 i; i < n && deployable > 0; ++i) {
            if (!router.isActive(i)) continue;
            address adapter = router.adapterOf(i);
            if (!riskController.canReceiveDeposits(adapter)) continue;
            uint256 target = (ta * router.targetBps(i)) / BPS;
            uint256 book = router.bookValue(i);
            if (target <= book) continue;
            uint256 amt = target - book < deployable ? target - book : deployable;
            IERC20(asset()).forceApprove(address(router), amt);
            router.deployToStrategy(i, amt, ta);
            deployable -= amt;
            deployed += amt;
        }
        emit Rebalanced(msg.sender, deployed, withdrawn, idleAssets());
    }

    // ================================================================== guardian (instant risk reduction)

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GOVERNANCE_ROLE) {
        _unpause();
    }

    /// @notice Temporarily freeze withdrawals during an active exploit. Bounded to 3 days per call.
    function freezeWithdrawals(uint64 duration) external onlyRole(GUARDIAN_ROLE) {
        if (duration > MAX_WITHDRAWAL_FREEZE) revert InvalidConfig();
        withdrawalsFrozenUntil = uint64(block.timestamp) + duration;
        emit WithdrawalsFrozen(withdrawalsFrozenUntil);
    }

    function unfreezeWithdrawals() external onlyRole(GUARDIAN_ROLE) {
        withdrawalsFrozenUntil = 0;
        emit WithdrawalsFrozen(0);
    }

    /// @notice Pull all funds out of a strategy back into the vault and deactivate it.
    function emergencyExitStrategy(uint256 id) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        (uint256 returned, uint256 principalBefore) = router.exitStrategy(id);
        uint256 gain = returned > principalBefore ? returned - principalBefore : 0;
        uint256 loss = principalBefore > returned ? principalBefore - returned : 0;
        profitAccounting.recordStrategyResult(id, gain, loss);
        _settleAndDistribute(gain, loss, 0);
        emit StrategyExited(id, returned, principalBefore);
    }

    // ================================================================== governance (timelocked)

    function setFeeConfig(address treasury_, uint16 perfFeeBps, uint16 costBps, uint256 costCap)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (treasury_ == address(0) || perfFeeBps > MAX_PERFORMANCE_FEE_BPS || costBps > MAX_HARVEST_COST_BPS) {
            revert InvalidConfig();
        }
        treasury = treasury_;
        performanceFeeBps = perfFeeBps;
        harvestCostBps = costBps;
        harvestCostCap = costCap;
        emit FeeConfigSet(treasury_, perfFeeBps, costBps, costCap);
    }

    function setLimits(uint256 depositCap_, uint256 minDeposit_) external onlyRole(GOVERNANCE_ROLE) {
        depositCap = depositCap_;
        minDeposit = minDeposit_;
        emit LimitsSet(depositCap_, minDeposit_);
    }

    function setGuardedLaunch(bool guarded) external onlyRole(GOVERNANCE_ROLE) {
        guardedLaunch = guarded;
        emit GuardedLaunchSet(guarded);
    }

    // ================================================================== internals

    function _settleAndDistribute(uint256 grossGain, uint256 totalLoss, uint256 requestedCost)
        internal
        returns (uint256 distributable)
    {
        // Execution cost is reimbursed from realized gain only — never from principal.
        uint256 cost = requestedCost;
        uint256 pctCap = (grossGain * harvestCostBps) / BPS;
        if (cost > pctCap) cost = pctCap;
        if (cost > harvestCostCap) cost = harvestCostCap;
        if (cost > 0) IERC20(asset()).safeTransfer(msg.sender, cost);

        distributable = profitAccounting.settle(grossGain, cost, totalAssets(), totalSupply());

        uint256 fee;
        uint256 rewards;
        if (distributable > 0) {
            fee = (distributable * performanceFeeBps) / BPS;
            rewards = distributable - fee;
            if (fee > 0) IERC20(asset()).safeTransfer(treasury, fee);
            if (rewards > 0) {
                IERC20(asset()).forceApprove(address(rewardDistributor), rewards);
                rewardDistributor.notifyReward(rewards);
            }
            profitAccounting.recordDistribution(fee, rewards);
        }
        emit Harvested(msg.sender, grossGain, totalLoss, cost, distributable, fee, rewards, totalAssets());
    }

    // Required override resolution
    function decimals() public view override(ERC4626) returns (uint8) {
        return super.decimals();
    }
}
