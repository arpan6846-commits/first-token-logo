// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

/// @notice Shared principal bookkeeping and access control for strategy adapters.
abstract contract BaseAdapter is IStrategyAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 internal immutable _asset;
    address public immutable override router;
    uint256 public override principal;

    event AdapterDeposit(uint256 amount, uint256 principal);
    event AdapterWithdraw(uint256 requested, uint256 withdrawn, uint256 principal);
    event AdapterHarvest(uint256 realizedGain, uint256 recognizedLoss, uint256 principal);
    event AdapterEmergencyExit(uint256 returned);

    error OnlyRouter();

    modifier onlyRouter() {
        if (msg.sender != router) revert OnlyRouter();
        _;
    }

    constructor(address asset_, address router_) {
        _asset = IERC20(asset_);
        router = router_;
    }

    function asset() external view override returns (address) {
        return address(_asset);
    }

    function deposit(uint256 amount) external override onlyRouter nonReentrant {
        _supply(amount);
        principal += amount;
        emit AdapterDeposit(amount, principal);
    }

    function withdraw(uint256 amount) external override onlyRouter nonReentrant returns (uint256 withdrawn) {
        // Only principal is withdrawable; unrealized gains stay until realized by harvest.
        if (amount > principal) amount = principal;
        if (amount == 0) return 0;
        withdrawn = _redeem(amount);
        principal -= withdrawn > principal ? principal : withdrawn;
        _asset.safeTransfer(router, withdrawn);
        emit AdapterWithdraw(amount, withdrawn, principal);
    }

    function harvest() external override onlyRouter nonReentrant returns (uint256 realizedGain, uint256 recognizedLoss) {
        _accrue();
        uint256 mark = totalAssets();
        if (mark > principal) {
            uint256 gain = mark - principal;
            uint256 liq = availableProtocolCash();
            if (gain > liq) gain = liq; // realize what is actually withdrawable now
            if (gain > 0) {
                realizedGain = _redeem(gain);
                _asset.safeTransfer(router, realizedGain);
            }
        } else if (mark < principal) {
            recognizedLoss = principal - mark;
            principal = mark;
        }
        emit AdapterHarvest(realizedGain, recognizedLoss, principal);
    }

    function emergencyWithdrawAll() external override onlyRouter nonReentrant returns (uint256 returned) {
        returned = _redeemAll();
        principal = 0;
        if (returned > 0) _asset.safeTransfer(router, returned);
        emit AdapterEmergencyExit(returned);
    }

    function availableLiquidity() external view override returns (uint256) {
        uint256 liq = availableProtocolCash();
        uint256 m = totalAssets();
        uint256 cap = principal < m ? principal : m;
        return liq < cap ? liq : cap;
    }

    function totalAssets() public view virtual override returns (uint256);
    function availableProtocolCash() public view virtual returns (uint256);
    function _supply(uint256 amount) internal virtual;
    function _redeem(uint256 amount) internal virtual returns (uint256 received);
    function _redeemAll() internal virtual returns (uint256 received);
    function _accrue() internal virtual {}
}
