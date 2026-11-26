/**
 * AMYE deployment script (BNB Smart Chain testnet first).
 *
 *   npx hardhat run scripts/deploy.ts --network bscTestnet
 *
 * Environment (see .env.example):
 *   DEPLOYER_PRIVATE_KEY     funded testnet key (holds roles only during deployment, then renounces all)
 *   MULTISIG_ADDRESS         Safe multisig: timelock proposer/canceller + guardian (required off-hardhat)
 *   KEEPER_ADDRESS           automation account allowed to rebalance/harvest (no custody)
 *   RISK_REPORTER_ADDRESS    risk engine signer allowed to publish risk scores
 *   TREASURY_ADDRESS         receives the disclosed performance fee (defaults to MULTISIG_ADDRESS)
 *   TIMELOCK_DELAY_SECONDS   default 3600 on testnet; at least 172800 (48h) required on mainnet
 *   BETA_DEPOSITORS          comma-separated addresses allowed to deposit during the guarded launch
 *   USDT_ADDRESS, VENUS_MARKET_A, VENUS_MARKET_B, STABLE_POOL
 *                            real protocol addresses; when unset on testnet, clearly-labelled mocks
 *                            are deployed instead. Mocks are refused on mainnet.
 *
 * Final state asserted at the end: the deployer holds no role on any contract; governance and admin
 * rights sit with the timelock; the guardian is the multisig.
 */
import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

const E = (n: number) => ethers.parseUnits(n.toString(), 18);
const BSC_MAINNET = 56n;

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function requireAddress(name: string, value: string | undefined): string {
  if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be set to a valid address`);
  return ethers.getAddress(value);
}

async function main() {
  const [deployer, ...localSigners] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const isMainnet = chainId === BSC_MAINNET;

  // ---------------------------------------------------------------- configuration
  const multisig = isLocal && !env("MULTISIG_ADDRESS")
    ? localSigners[0].address
    : requireAddress("MULTISIG_ADDRESS", env("MULTISIG_ADDRESS"));
  const keeper = isLocal && !env("KEEPER_ADDRESS")
    ? localSigners[1].address
    : requireAddress("KEEPER_ADDRESS", env("KEEPER_ADDRESS"));
  const riskReporter = isLocal && !env("RISK_REPORTER_ADDRESS")
    ? localSigners[2].address
    : requireAddress("RISK_REPORTER_ADDRESS", env("RISK_REPORTER_ADDRESS"));
  const treasury = env("TREASURY_ADDRESS") ? requireAddress("TREASURY_ADDRESS", env("TREASURY_ADDRESS")) : multisig;
  const timelockDelay = BigInt(env("TIMELOCK_DELAY_SECONDS") ?? (isMainnet ? "172800" : "3600"));
  const betaDepositors = (env("BETA_DEPOSITORS") ?? "").split(",").map((a) => a.trim()).filter(Boolean)
    .map((a) => requireAddress("BETA_DEPOSITORS entry", a));

  for (const [name, addr] of [["MULTISIG", multisig], ["KEEPER", keeper], ["RISK_REPORTER", riskReporter], ["TREASURY", treasury]]) {
    if (addr === deployer.address) throw new Error(`${name} must not be the deployer address`);
  }
  if (isMainnet) {
    if (timelockDelay < 172800n) throw new Error("Mainnet timelock delay must be at least 48 hours");
    for (const k of ["USDT_ADDRESS", "VENUS_MARKET_A", "VENUS_MARKET_B", "STABLE_POOL"]) {
      if (!env(k)) throw new Error(`${k} is required on mainnet; mocks are never deployed to mainnet`);
    }
  }

  console.log(`Network ${network.name} (chainId ${chainId}), deployer ${deployer.address}`);
  console.log(`Multisig ${multisig}, keeper ${keeper}, risk reporter ${riskReporter}, treasury ${treasury}`);

  const addr = async (c: { getAddress(): Promise<string> }) => c.getAddress();
  const wait = async (txPromise: Promise<{ wait(): Promise<unknown> }>) => (await txPromise).wait();
  const deploy = async (name: string, args: unknown[]) => {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    console.log(`  ${name.padEnd(22)} ${await c.getAddress()}`);
    return c;
  };

  // ---------------------------------------------------------------- external protocols (real or mock)
  const mocks: Record<string, string> = {};
  let usdtAddr = env("USDT_ADDRESS");
  let marketA = env("VENUS_MARKET_A");
  let marketB = env("VENUS_MARKET_B");
  let pool = env("STABLE_POOL");
  if (!usdtAddr || !marketA || !marketB || !pool) {
    console.log("Deploying TEST-ONLY mocks for missing protocol addresses:");
    if (!usdtAddr) usdtAddr = mocks.MockUSDT = await addr(await deploy("MockERC20", ["Test USDT (AMYE testnet)", "tUSDT"]));
    if (!marketA) marketA = mocks.MockMarketA = await addr(await deploy("MockVToken", [usdtAddr]));
    if (!marketB) marketB = mocks.MockMarketB = await addr(await deploy("MockVToken", [usdtAddr]));
    if (!pool) {
      const usdc = await deploy("MockERC20", ["Test USDC (AMYE testnet)", "tUSDC"]);
      mocks.MockUSDC = await addr(usdc);
      pool = mocks.MockStablePool = await addr(await deploy("MockStableSwap", [usdtAddr, mocks.MockUSDC]));
    }
  }
  const usdt = requireAddress("USDT_ADDRESS", usdtAddr);

  // ---------------------------------------------------------------- governance
  console.log("Deploying governance and core contracts:");
  // Multisig proposes/cancels; anyone may execute after the delay; no admin (self-administered).
  const timelock = await deploy("AMYETimelock", [timelockDelay, [multisig], [ethers.ZeroAddress], ethers.ZeroAddress]);
  const timelockAddr = await addr(timelock);

  // The deployer temporarily holds admin + governance to wire everything, then hands both to the timelock.
  const risk = await deploy("RiskController", [deployer.address, deployer.address, multisig, 1000]);
  await wait(risk.setTokenAllowed(usdt, true));
  const router = await deploy("AdaptiveYieldRouter", [usdt, await addr(risk), deployer.address, deployer.address, multisig]);
  const vault = await deploy("AMYEVault", [usdt, await addr(router), await addr(risk), deployer.address, deployer.address, multisig, treasury]);
  const vaultAddr = await addr(vault);
  const profitAccounting = await deploy("ProfitAccounting", [vaultAddr]);
  const rewardDistributor = await deploy("RewardDistributor", [vaultAddr, usdt]);
  await wait(vault.setModules(await addr(profitAccounting), await addr(rewardDistributor)));
  await wait(router.setVault(vaultAddr));

  console.log("Deploying strategy adapters:");
  const routerAddr = await addr(router);
  const lendA = await deploy("LendingAdapter", [usdt, routerAddr, marketA]);
  const lendB = await deploy("LendingAdapter", [usdt, routerAddr, marketB]);
  const liquidity = await deploy("LiquidityAdapter", [usdt, routerAddr, pool, 50]);

  // Illustrative initial weights 60/20/10 with a 10% liquid reserve. Absolute caps keep the testnet small.
  const strategies = [
    { adapter: lendA, name: "BNB lending market A", bps: 6000, cap: E(60_000) },
    { adapter: lendB, name: "BNB lending market B", bps: 2000, cap: E(20_000) },
    { adapter: liquidity, name: "Stablecoin liquidity provision", bps: 1000, cap: E(10_000) },
  ];
  for (const s of strategies) {
    await wait(risk.setStrategyLimits(await addr(s.adapter), s.bps, s.cap));
    await wait(router.addStrategy(await addr(s.adapter), s.name));
  }
  await wait(router.setTargets(strategies.map((s) => s.bps)));

  // Operational roles (none of them can move funds to arbitrary addresses).
  await wait(vault.grantRole(await vault.KEEPER_ROLE(), keeper));
  await wait(risk.grantRole(await risk.RISK_REPORTER_ROLE(), riskReporter));
  for (const d of betaDepositors) await wait(vault.grantRole(await vault.DEPOSITOR_ROLE(), d));

  // ---------------------------------------------------------------- hand over and renounce
  console.log("Handing governance and admin to the timelock, renouncing deployer roles...");
  for (const c of [risk, router, vault]) {
    const GOV = await c.GOVERNANCE_ROLE();
    const ADMIN = await c.DEFAULT_ADMIN_ROLE();
    await wait(c.grantRole(GOV, timelockAddr));
    await wait(c.grantRole(ADMIN, timelockAddr));
    await wait(c.renounceRole(GOV, deployer.address));
    await wait(c.renounceRole(ADMIN, deployer.address));
  }

  // ---------------------------------------------------------------- verify final state (fail loudly)
  const problems: string[] = [];
  for (const [name, c] of [["RiskController", risk], ["AdaptiveYieldRouter", router], ["AMYEVault", vault]] as const) {
    for (const roleName of ["DEFAULT_ADMIN_ROLE", "GOVERNANCE_ROLE", "GUARDIAN_ROLE"] as const) {
      const role = await c[roleName]();
      if (await c.hasRole(role, deployer.address)) problems.push(`${name}: deployer still holds ${roleName}`);
    }
    if (!(await c.hasRole(await c.GOVERNANCE_ROLE(), timelockAddr))) problems.push(`${name}: timelock lacks GOVERNANCE_ROLE`);
    if (!(await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), timelockAddr))) problems.push(`${name}: timelock lacks DEFAULT_ADMIN_ROLE`);
    if (!(await c.hasRole(await c.GUARDIAN_ROLE(), multisig))) problems.push(`${name}: multisig lacks GUARDIAN_ROLE`);
  }
  if (!(await vault.hasRole(await vault.KEEPER_ROLE(), keeper))) problems.push("AMYEVault: keeper lacks KEEPER_ROLE");
  if (!(await vault.guardedLaunch())) problems.push("AMYEVault: guarded launch is not enabled");
  if ((await timelock.getMinDelay()) !== timelockDelay) problems.push("Timelock: unexpected delay");
  if (!(await timelock.hasRole(await timelock.PROPOSER_ROLE(), multisig))) problems.push("Timelock: multisig is not proposer");
  if (await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)) problems.push("Timelock: deployer is admin");
  if (problems.length) throw new Error(`Deployment verification FAILED:\n - ${problems.join("\n - ")}`);
  console.log("Verification passed: deployer holds no roles; timelock governs; multisig guards.");

  // ---------------------------------------------------------------- record addresses for frontend/indexer
  const deployment = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    startBlock: (await vault.deploymentTransaction()?.wait())?.blockNumber ?? null,
    usesMocks: Object.keys(mocks).length > 0,
    roles: { multisig, keeper, riskReporter, treasury, timelockDelaySeconds: Number(timelockDelay) },
    contracts: {
      USDT: usdt,
      AMYETimelock: timelockAddr,
      RiskController: await addr(risk),
      AdaptiveYieldRouter: routerAddr,
      AMYEVault: vaultAddr,
      ProfitAccounting: await addr(profitAccounting),
      RewardDistributor: await addr(rewardDistributor),
      LendingAdapterA: await addr(lendA),
      LendingAdapterB: await addr(lendB),
      LiquidityAdapter: await addr(liquidity),
      ...mocks,
    },
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, isLocal ? `${network.name}.local.json` : `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
