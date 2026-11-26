/**
 * LOCAL DEVELOPMENT ONLY: simulates a few weeks of vault activity on a local Hardhat node so the
 * dashboards have real on-chain history to display. Refuses to run on any other network.
 *
 *   npx hardhat node
 *   BETA_DEPOSITORS=<acct4>,<acct5> npx hardhat run scripts/deploy.ts --network localhost
 *   npx hardhat run scripts/seed-local.ts --network localhost
 */
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import fs from "fs";
import path from "path";

const E = (n: number) => ethers.parseUnits(n.toString(), 18);

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") throw new Error("seed-local only runs on a local node");
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.local.json`), "utf8"));
  if (!dep.usesMocks) throw new Error("seed-local requires the mock protocols");
  const signers = await ethers.getSigners();
  const keeper = signers.find((s) => s.address === dep.roles.keeper)!;
  const [alice, bob] = [signers[4], signers[5]];
  const c = dep.contracts;
  const usdt = await ethers.getContractAt("MockERC20", c.USDT);
  const vault = await ethers.getContractAt("AMYEVault", c.AMYEVault);
  const marketA = await ethers.getContractAt("MockVToken", c.MockMarketA);
  const marketB = await ethers.getContractAt("MockVToken", c.MockMarketB);
  const pool = await ethers.getContractAt("MockStableSwap", c.MockStablePool);

  for (const [u, amt] of [[alice, 30_000], [bob, 10_000]] as const) {
    await (await usdt.mint(u.address, E(amt + 5_000))).wait();
    await (await usdt.connect(u).approve(c.AMYEVault, E(amt))).wait();
    await (await vault.connect(u).deposit(E(amt), u.address)).wait();
  }
  await (await vault.connect(keeper).rebalance()).wait();

  // Two weeks of daily harvests with modest interest, plus one loss event to show loss carryforward.
  for (let day = 1; day <= 14; day++) {
    await time.increase(86_400);
    await (await marketA.accrueInterest(E(3))).wait();
    await (await marketB.accrueInterest(E(1))).wait();
    if (day % 3 === 0) await (await pool.accrueFees(E(1))).wait();
    if (day === 6) await (await marketB.realizeLoss(E(12))).wait();
    await (await vault.connect(keeper).harvest(E(1))).wait();
  }
  console.log(`Seeded: TVL ${ethers.formatUnits(await vault.totalAssets(), 18)} USDT, alice ${alice.address}, bob ${bob.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
