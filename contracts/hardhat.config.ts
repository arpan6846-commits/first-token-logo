import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import path from "path";
dotenv.config();

const SOLC_VERSION = "0.8.24";

// Use the solcjs build shipped in node_modules/solc so compilation works in
// environments where binaries.soliditylang.org is unreachable.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const compilerPath = path.join(__dirname, "node_modules", "solc", "soljson.js");
    return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: "0.8.24+commit.e11b9ed9" };
  }
  return runSuper();
});

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: false, evmVersion: "paris" },
  },
  networks: {
    hardhat: {},
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts,
    },
    // Mainnet deliberately requires an explicit opt-in flag. See SECURITY.md launch gates.
    ...(process.env.ALLOW_MAINNET === "I_HAVE_AUDITS_AND_LEGAL_SIGNOFF"
      ? { bsc: { url: process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org", chainId: 56, accounts } }
      : {}),
  },
  etherscan: { apiKey: { bscTestnet: process.env.BSCSCAN_API_KEY || "" } },
  gasReporter: { enabled: process.env.REPORT_GAS === "true" },
};

export default config;
