import { ethers } from "hardhat";

export const E = (n: number | string) => ethers.parseUnits(n.toString(), 18);

/// Deploys the full AMYE stack against mocks. Governance and guardian are plain EOAs here so tests can
/// exercise role checks directly; the deploy script wires governance to the TimelockController.
export async function deployStack() {
  const [admin, governance, guardian, keeper, treasury, alice, bob, carol, outsider] = await ethers.getSigners();

  const usdt = await ethers.deployContract("MockERC20", ["Tether USD", "USDT"]);
  const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC"]);
  const marketA = await ethers.deployContract("MockVToken", [await usdt.getAddress()]);
  const marketB = await ethers.deployContract("MockVToken", [await usdt.getAddress()]);
  const pool = await ethers.deployContract("MockStableSwap", [await usdt.getAddress(), await usdc.getAddress()]);

  const risk = await ethers.deployContract("RiskController", [admin.address, governance.address, guardian.address, 1000]);
  await risk.connect(governance).setTokenAllowed(await usdt.getAddress(), true);

  const router = await ethers.deployContract("AdaptiveYieldRouter", [
    await usdt.getAddress(), await risk.getAddress(), admin.address, governance.address, guardian.address,
  ]);
  const vault = await ethers.deployContract("AMYEVault", [
    await usdt.getAddress(), await router.getAddress(), await risk.getAddress(),
    admin.address, governance.address, guardian.address, treasury.address,
  ]);
  const pa = await ethers.deployContract("ProfitAccounting", [await vault.getAddress()]);
  const rd = await ethers.deployContract("RewardDistributor", [await vault.getAddress(), await usdt.getAddress()]);
  await vault.connect(admin).setModules(await pa.getAddress(), await rd.getAddress());
  await router.connect(admin).setVault(await vault.getAddress());

  const lendA = await ethers.deployContract("LendingAdapter", [await usdt.getAddress(), await router.getAddress(), await marketA.getAddress()]);
  const lendB = await ethers.deployContract("LendingAdapter", [await usdt.getAddress(), await router.getAddress(), await marketB.getAddress()]);
  const lp = await ethers.deployContract("LiquidityAdapter", [await usdt.getAddress(), await router.getAddress(), await pool.getAddress(), 50]);

  for (const [a, bps] of [[lendA, 6000], [lendB, 2000], [lp, 1000]] as const) {
    await risk.connect(governance).setStrategyLimits(await a.getAddress(), bps, E(1_000_000));
  }
  await router.connect(governance).addStrategy(await lendA.getAddress(), "BNB lending market A");
  await router.connect(governance).addStrategy(await lendB.getAddress(), "BNB lending market B");
  await router.connect(governance).addStrategy(await lp.getAddress(), "Stablecoin liquidity");
  await router.connect(governance).setTargets([6000, 2000, 1000]); // 10% liquid reserve remains

  await vault.connect(admin).grantRole(await vault.KEEPER_ROLE(), keeper.address);
  for (const u of [alice, bob, carol]) {
    await vault.connect(admin).grantRole(await vault.DEPOSITOR_ROLE(), u.address);
    await usdt.mint(u.address, E(100_000));
    await usdt.connect(u).approve(await vault.getAddress(), ethers.MaxUint256);
  }

  return {
    admin, governance, guardian, keeper, treasury, alice, bob, carol, outsider,
    usdt, usdc, marketA, marketB, pool, risk, router, vault, pa, rd, lendA, lendB, lp,
  };
}
