// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IRiskController} from "../interfaces/IRiskController.sol";

/// @title AdaptiveYieldRouter
/// @notice Registry of approved strategy adapters and their target weights. Moves funds ONLY between the
///         vault and registered adapters; there is no code path that sends assets anywhere else.
/// @dev - Adding strategies and changing target weights requires GOVERNANCE_ROLE (the timelock).
///      - The guardian (multisig) can instantly zero a target and exit a strategy (risk reduction).
///      - Fund-moving functions are callable only by the vault, which itself restricts them to keepers
///        executing the timelocked targets. The off-chain AI/risk engine never holds keys that can move
///        user funds to arbitrary destinations.
contract AdaptiveYieldRouter is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_STRATEGIES = 8;

    struct Strategy {
        IStrategyAdapter adapter;
        uint16 targetBps;
        bool active;
        string name;
    }

    struct StrategyView {
        address adapter;
        address protocol;
        string name;
        uint16 targetBps;
        bool active;
        uint256 principal;
        uint256 markValue;
        uint256 bookValue;
        uint256 availableLiquidity;
        uint8 riskScore;
        bool acceptingDeposits;
    }

    IERC20 public immutable asset;
    IRiskController public immutable riskController;
    address public vault;

    Strategy[] internal _strategies;
    mapping(address => bool) public isRegistered;

    event VaultSet(address vault);
    event StrategyAdded(uint256 indexed id, address indexed adapter, string name);
    event TargetsUpdated(uint16[] targets, uint16 reserveBps);
    event StrategyDeactivated(uint256 indexed id, uint256 returned);
    event Deployed(uint256 indexed id, uint256 amount);
    event Withdrawn(uint256 indexed id, uint256 requested, uint256 received);

    error OnlyVault();
    error VaultAlreadySet();
    error InvalidAdapter();
    error TooManyStrategies();
    error LengthMismatch();
    error TargetsExceedLimit();
    error StrategyInactive(uint256 id);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address asset_, address riskController_, address admin, address governance, address guardian) {
        asset = IERC20(asset_);
        riskController = IRiskController(riskController_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, governance);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /// @notice One-time wiring, done by the deployer before admin rights are handed to the timelock.
    function setVault(address vault_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault != address(0)) revert VaultAlreadySet();
        vault = vault_;
        emit VaultSet(vault_);
    }

    // ------------------------------------------------------------------ governance (timelocked)

    function addStrategy(address adapter, string calldata name) external onlyRole(GOVERNANCE_ROLE) returns (uint256 id) {
        if (_strategies.length >= MAX_STRATEGIES) revert TooManyStrategies();
        IStrategyAdapter a = IStrategyAdapter(adapter);
        if (
            isRegistered[adapter] || a.asset() != address(asset) || a.router() != address(this)
                || !riskController.isAllowedToken(address(asset))
        ) revert InvalidAdapter();
        isRegistered[adapter] = true;
        _strategies.push(Strategy({adapter: a, targetBps: 0, active: true, name: name}));
        id = _strategies.length - 1;
        emit StrategyAdded(id, adapter, name);
    }

    /// @notice Sets target weights. Whatever is not allocated stays as the liquid reserve in the vault.
    function setTargets(uint16[] calldata targets) external onlyRole(GOVERNANCE_ROLE) {
        if (targets.length != _strategies.length) revert LengthMismatch();
        uint256 sum;
        for (uint256 i; i < targets.length; ++i) {
            Strategy storage s = _strategies[i];
            if (targets[i] > 0) {
                if (!s.active) revert StrategyInactive(i);
                if (targets[i] > riskController.maxAllocationBps(address(s.adapter))) revert TargetsExceedLimit();
            }
            s.targetBps = targets[i];
            sum += targets[i];
        }
        if (sum + riskController.minReserveBps() > BPS) revert TargetsExceedLimit();
        emit TargetsUpdated(targets, uint16(BPS - sum));
    }

    // ------------------------------------------------------------------ guardian (instant risk reduction)

    function guardianSetTargetZero(uint256 id) external onlyRole(GUARDIAN_ROLE) {
        _strategies[id].targetBps = 0;
        uint16[] memory t = new uint16[](_strategies.length);
        uint256 sum;
        for (uint256 i; i < t.length; ++i) {
            t[i] = _strategies[i].targetBps;
            sum += t[i];
        }
        emit TargetsUpdated(t, uint16(BPS - sum));
    }

    // ------------------------------------------------------------------ vault-only fund movement

    function deployToStrategy(uint256 id, uint256 amount, uint256 vaultTotalAssets) external onlyVault {
        Strategy storage s = _strategies[id];
        if (!s.active) revert StrategyInactive(id);
        uint256 newBook = _bookValue(s.adapter) + amount;
        riskController.checkAllocation(address(s.adapter), newBook, vaultTotalAssets);
        asset.safeTransferFrom(vault, address(s.adapter), amount);
        s.adapter.deposit(amount);
        emit Deployed(id, amount);
    }

    function withdrawFromStrategy(uint256 id, uint256 amount) external onlyVault returns (uint256 received) {
        received = _strategies[id].adapter.withdraw(amount);
        if (received > 0) asset.safeTransfer(vault, received);
        emit Withdrawn(id, amount, received);
    }

    function harvestStrategy(uint256 id) external onlyVault returns (uint256 gain, uint256 loss) {
        (gain, loss) = _strategies[id].adapter.harvest();
        if (gain > 0) asset.safeTransfer(vault, gain);
    }

    /// @notice Exits a strategy completely and deactivates it. Called by the vault on guardian request.
    function exitStrategy(uint256 id) external onlyVault returns (uint256 returned, uint256 principalBefore) {
        Strategy storage s = _strategies[id];
        principalBefore = s.adapter.principal();
        returned = s.adapter.emergencyWithdrawAll();
        s.active = false;
        s.targetBps = 0;
        if (returned > 0) asset.safeTransfer(vault, returned);
        emit StrategyDeactivated(id, returned);
    }

    // ------------------------------------------------------------------ views

    function strategyCount() external view returns (uint256) {
        return _strategies.length;
    }

    function adapterOf(uint256 id) external view returns (address) {
        return address(_strategies[id].adapter);
    }

    function targetBps(uint256 id) external view returns (uint16) {
        return _strategies[id].targetBps;
    }

    function isActive(uint256 id) external view returns (bool) {
        return _strategies[id].active;
    }

    function reserveTargetBps() public view returns (uint16) {
        uint256 sum;
        for (uint256 i; i < _strategies.length; ++i) sum += _strategies[i].targetBps;
        return uint16(BPS - sum);
    }

    /// @notice Conservative value: per strategy min(principal, mark). Unrealized gains are excluded,
    ///         unrealized losses are included.
    function bookValue(uint256 id) public view returns (uint256) {
        return _bookValue(_strategies[id].adapter);
    }

    function totalBookValue() external view returns (uint256 total) {
        for (uint256 i; i < _strategies.length; ++i) total += _bookValue(_strategies[i].adapter);
    }

    function totalMarkValue() external view returns (uint256 total) {
        for (uint256 i; i < _strategies.length; ++i) total += _strategies[i].adapter.totalAssets();
    }

    function availableLiquidity(uint256 id) public view returns (uint256) {
        IStrategyAdapter a = _strategies[id].adapter;
        uint256 liq = a.availableLiquidity();
        uint256 book = _bookValue(a);
        return liq < book ? liq : book;
    }

    function totalAvailableLiquidity() external view returns (uint256 total) {
        for (uint256 i; i < _strategies.length; ++i) total += availableLiquidity(i);
    }

    function getStrategy(uint256 id) public view returns (StrategyView memory v) {
        Strategy storage s = _strategies[id];
        address a = address(s.adapter);
        v.adapter = a;
        v.protocol = s.adapter.protocol();
        v.name = s.name;
        v.targetBps = s.targetBps;
        v.active = s.active;
        v.principal = s.adapter.principal();
        v.markValue = s.adapter.totalAssets();
        v.bookValue = v.principal < v.markValue ? v.principal : v.markValue;
        v.availableLiquidity = availableLiquidity(id);
        v.riskScore = riskController.riskScore(a);
        v.acceptingDeposits = riskController.canReceiveDeposits(a);
    }

    function getAllStrategies() external view returns (StrategyView[] memory views) {
        views = new StrategyView[](_strategies.length);
        for (uint256 i; i < views.length; ++i) views[i] = getStrategy(i);
    }

    function _bookValue(IStrategyAdapter a) internal view returns (uint256) {
        uint256 p = a.principal();
        uint256 m = a.totalAssets();
        return p < m ? p : m;
    }
}
