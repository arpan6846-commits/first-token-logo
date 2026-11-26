// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IStrategyAdapter
/// @notice Uniform interface every yield strategy must implement. Adapters only ever move funds
///         between the AdaptiveYieldRouter and a single, fixed external protocol.
/// @dev Accounting model:
///      - `principal()` is the cost basis (book value) of capital currently deployed.
///      - `totalAssets()` is the mark-to-market value in the underlying asset.
///      - Unrealized gains (mark > principal) are NEVER withdrawable via `withdraw`; they can only be
///        realized as cash through `harvest`, which sends the realized gain to the router.
///      - Losses (mark < principal) are recognized at `harvest` by writing principal down to mark.
interface IStrategyAdapter {
    function asset() external view returns (address);
    function router() external view returns (address);
    function protocol() external view returns (address);

    /// @notice Cost basis of deployed capital.
    function principal() external view returns (uint256);
    /// @notice Mark-to-market value of deployed capital, in underlying units.
    function totalAssets() external view returns (uint256);
    /// @notice Amount of principal that can be withdrawn right now given protocol liquidity.
    function availableLiquidity() external view returns (uint256);

    /// @notice Router transfers `amount` to the adapter beforehand; adapter supplies it to the protocol.
    function deposit(uint256 amount) external;
    /// @notice Withdraw up to `amount` of principal back to the router. Returns the amount sent.
    function withdraw(uint256 amount) external returns (uint256 withdrawn);
    /// @notice Realize gains as cash (sent to router) or recognize losses (principal write-down).
    function harvest() external returns (uint256 realizedGain, uint256 recognizedLoss);
    /// @notice Pull everything out of the protocol and send it to the router. Principal is reset to 0.
    function emergencyWithdrawAll() external returns (uint256 returned);
}
