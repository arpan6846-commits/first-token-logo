// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Timelock that holds GOVERNANCE_ROLE on every AMYE contract. The multisig (e.g. a Safe) is the
///         only proposer/canceller; execution is open after the delay so anyone can execute queued ops.
contract AMYETimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
