// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IRiskController} from "../interfaces/IRiskController.sol";

/// @title RiskController
/// @notice On-chain guard rails for the yield engine: verified token allowlist, per-strategy exposure
///         caps, minimum liquid reserve and risk scores.
/// @dev Role model:
///      - GOVERNANCE_ROLE: held ONLY by the TimelockController (proposed by the multisig). Anything that
///        can INCREASE risk (raising caps, allowlisting tokens, lowering reserve) is timelocked.
///      - GUARDIAN_ROLE: held by the multisig directly. Can only REDUCE risk instantly (lower caps, raise
///        reserve, block a strategy).
///      - RISK_REPORTER_ROLE: the off-chain risk-scoring engine's signer. It can publish scores, which can
///        only block deposits into a strategy. It can never move funds and never raise a cap.
contract RiskController is AccessControl, IRiskController {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant RISK_REPORTER_ROLE = keccak256("RISK_REPORTER_ROLE");

    uint16 public constant BPS = 10_000;
    /// @notice No single strategy may ever hold more than this share of vault assets.
    uint16 public constant HARD_MAX_ALLOCATION_BPS = 7_000;
    /// @notice The liquid reserve can never be configured below this floor.
    uint16 public constant HARD_MIN_RESERVE_BPS = 500;
    /// @notice Maximum change a single risk report can apply to a score (dampens a compromised reporter).
    uint8 public constant MAX_SCORE_STEP = 25;

    struct StrategyRisk {
        uint16 maxAllocationBps; // cap as share of vault total assets
        uint256 maxAbsolute; // absolute cap in asset units (0 = strategy disabled)
        uint8 score; // 0 (lowest risk) .. 100 (highest risk)
        bool blocked; // guardian kill-switch for new deposits
        bool configured;
    }

    mapping(address => bool) private _allowedToken;
    mapping(address => StrategyRisk) private _risk;
    uint16 public override minReserveBps;
    /// @notice Scores at or above this value block new deposits into a strategy.
    uint8 public depositBlockScore;

    event TokenAllowlisted(address indexed token, bool allowed);
    event StrategyLimitsSet(address indexed adapter, uint16 maxAllocationBps, uint256 maxAbsolute);
    event StrategyBlocked(address indexed adapter, bool blocked);
    event RiskScoreReported(address indexed adapter, uint8 oldScore, uint8 newScore, bytes32 reportHash);
    event MinReserveSet(uint16 bps);
    event DepositBlockScoreSet(uint8 score);

    error TokenNotAllowed();
    error InvalidBps();
    error NotConfigured(address adapter);
    error AllocationCapExceeded(address adapter, uint256 newBookValue, uint256 cap);
    error StrategyNotAcceptingDeposits(address adapter);
    error OnlyRiskReduction();
    error ScoreStepTooLarge();

    constructor(address admin, address governance, address guardian, uint16 minReserveBps_) {
        if (minReserveBps_ < HARD_MIN_RESERVE_BPS || minReserveBps_ > BPS) revert InvalidBps();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, governance);
        _grantRole(GUARDIAN_ROLE, guardian);
        minReserveBps = minReserveBps_;
        depositBlockScore = 80;
    }

    // ------------------------------------------------------------------ governance (timelocked)

    function setTokenAllowed(address token, bool allowed) external onlyRole(GOVERNANCE_ROLE) {
        _allowedToken[token] = allowed;
        emit TokenAllowlisted(token, allowed);
    }

    function setStrategyLimits(address adapter, uint16 maxAllocationBps_, uint256 maxAbsolute)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (maxAllocationBps_ > HARD_MAX_ALLOCATION_BPS) revert InvalidBps();
        StrategyRisk storage r = _risk[adapter];
        r.maxAllocationBps = maxAllocationBps_;
        r.maxAbsolute = maxAbsolute;
        if (!r.configured) {
            r.configured = true;
            r.score = 50; // neutral until the risk engine reports
        }
        emit StrategyLimitsSet(adapter, maxAllocationBps_, maxAbsolute);
    }

    function setMinReserveBps(uint16 bps) external onlyRole(GOVERNANCE_ROLE) {
        if (bps < HARD_MIN_RESERVE_BPS || bps > BPS) revert InvalidBps();
        minReserveBps = bps;
        emit MinReserveSet(bps);
    }

    function setDepositBlockScore(uint8 score) external onlyRole(GOVERNANCE_ROLE) {
        if (score > 100) revert InvalidBps();
        depositBlockScore = score;
        emit DepositBlockScoreSet(score);
    }

    // ------------------------------------------------------------------ guardian (instant, risk-reducing only)

    function guardianSetBlocked(address adapter, bool blocked) external onlyRole(GUARDIAN_ROLE) {
        // Unblocking increases risk, so it must go through governance.
        if (!blocked) revert OnlyRiskReduction();
        _risk[adapter].blocked = true;
        emit StrategyBlocked(adapter, true);
    }

    function governanceUnblock(address adapter) external onlyRole(GOVERNANCE_ROLE) {
        _risk[adapter].blocked = false;
        emit StrategyBlocked(adapter, false);
    }

    function guardianLowerLimits(address adapter, uint16 maxAllocationBps_, uint256 maxAbsolute)
        external
        onlyRole(GUARDIAN_ROLE)
    {
        StrategyRisk storage r = _risk[adapter];
        if (maxAllocationBps_ > r.maxAllocationBps || maxAbsolute > r.maxAbsolute) revert OnlyRiskReduction();
        r.maxAllocationBps = maxAllocationBps_;
        r.maxAbsolute = maxAbsolute;
        emit StrategyLimitsSet(adapter, maxAllocationBps_, maxAbsolute);
    }

    function guardianRaiseReserve(uint16 bps) external onlyRole(GUARDIAN_ROLE) {
        if (bps < minReserveBps || bps > BPS) revert OnlyRiskReduction();
        minReserveBps = bps;
        emit MinReserveSet(bps);
    }

    // ------------------------------------------------------------------ risk engine

    /// @param reportHash keccak256 of the full off-chain report (inputs + model version), for auditability.
    function reportRiskScore(address adapter, uint8 newScore, bytes32 reportHash)
        external
        onlyRole(RISK_REPORTER_ROLE)
    {
        StrategyRisk storage r = _risk[adapter];
        if (!r.configured) revert NotConfigured(adapter);
        if (newScore > 100) revert InvalidBps();
        uint8 old = r.score;
        uint8 step = newScore > old ? newScore - old : old - newScore;
        if (step > MAX_SCORE_STEP) revert ScoreStepTooLarge();
        r.score = newScore;
        emit RiskScoreReported(adapter, old, newScore, reportHash);
    }

    // ------------------------------------------------------------------ views

    function isAllowedToken(address token) external view override returns (bool) {
        return _allowedToken[token];
    }

    function maxAllocationBps(address adapter) external view override returns (uint16) {
        return _risk[adapter].maxAllocationBps;
    }

    function maxAbsolute(address adapter) external view returns (uint256) {
        return _risk[adapter].maxAbsolute;
    }

    function riskScore(address adapter) external view override returns (uint8) {
        return _risk[adapter].score;
    }

    function isBlocked(address adapter) external view returns (bool) {
        return _risk[adapter].blocked;
    }

    function canReceiveDeposits(address adapter) public view override returns (bool) {
        StrategyRisk storage r = _risk[adapter];
        return r.configured && !r.blocked && r.score < depositBlockScore && r.maxAbsolute > 0;
    }

    /// @notice Reverts if allocating up to `newBookValue` into `adapter` would breach any limit.
    function checkAllocation(address adapter, uint256 newBookValue, uint256 vaultTotalAssets)
        external
        view
        override
    {
        StrategyRisk storage r = _risk[adapter];
        if (!r.configured) revert NotConfigured(adapter);
        if (!canReceiveDeposits(adapter)) revert StrategyNotAcceptingDeposits(adapter);
        uint256 relCap = (vaultTotalAssets * r.maxAllocationBps) / BPS;
        uint256 cap = relCap < r.maxAbsolute ? relCap : r.maxAbsolute;
        if (newBookValue > cap) revert AllocationCapExceeded(adapter, newBookValue, cap);
    }
}
