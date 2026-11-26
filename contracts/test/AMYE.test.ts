import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployStack, E } from "./fixture";

const TOL = 10n ** 9n; // rounding tolerance in wei for exchange-rate math

async function fundedAndDeployed() {
  const s = await deployStack();
  await s.vault.connect(s.alice).deposit(E(30_000), s.alice.address);
  await s.vault.connect(s.bob).deposit(E(10_000), s.bob.address);
  await s.vault.connect(s.keeper).rebalance();
  return s;
}

describe("AMYE — deposits and allocation", () => {
  it("mints shares 1:1 on first deposits and records no revenue", async () => {
    const s = await loadFixture(deployStack);
    await s.vault.connect(s.alice).deposit(E(30_000), s.alice.address);
    await s.vault.connect(s.bob).deposit(E(10_000), s.bob.address);
    expect(await s.vault.balanceOf(s.alice.address)).to.equal(E(30_000));
    expect(await s.vault.totalAssets()).to.equal(E(40_000));

    // A harvest right after deposits must distribute nothing: deposits are not income.
    await s.vault.connect(s.keeper).harvest(0);
    expect(await s.rd.totalNotified()).to.equal(0);
    expect(await s.pa.cumulativeRealizedGain()).to.equal(0);
  });

  it("rebalances to 60/20/10 and keeps a 10% liquid reserve", async () => {
    const s = await loadFixture(fundedAndDeployed);
    expect(await s.router.bookValue(0)).to.equal(E(24_000));
    expect(await s.router.bookValue(1)).to.equal(E(8_000));
    expect(await s.router.bookValue(2)).to.equal(E(4_000));
    expect(await s.vault.idleAssets()).to.equal(E(4_000));
    expect(await s.vault.totalAssets()).to.equal(E(40_000));
  });

  it("enforces the guarded launch allowlist, minimum deposit and deposit cap", async () => {
    const s = await loadFixture(deployStack);
    await s.usdt.mint(s.outsider.address, E(1_000));
    await s.usdt.connect(s.outsider).approve(await s.vault.getAddress(), ethers.MaxUint256);
    await expect(s.vault.connect(s.outsider).deposit(E(100), s.outsider.address))
      .to.be.revertedWithCustomError(s.vault, "NotAllowedDepositor");
    await expect(s.vault.connect(s.alice).deposit(E(5), s.alice.address))
      .to.be.revertedWithCustomError(s.vault, "BelowMinDeposit");
    await s.vault.connect(s.governance).setLimits(E(1_000), E(10));
    await expect(s.vault.connect(s.alice).deposit(E(1_001), s.alice.address)).to.be.reverted;
  });
});

describe("AMYE — realized profit and rewards", () => {
  it("distributes only realized net gain, pro-rata, after costs and disclosed fee", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.marketA.accrueInterest(E(400));

    const keeperBefore = await s.usdt.balanceOf(s.keeper.address);
    await s.vault.connect(s.keeper).harvest(E(100));
    // Cost capped at 5% of gross gain (20), not the requested 100.
    const cost = (await s.usdt.balanceOf(s.keeper.address)) - keeperBefore;
    expect(cost).to.be.closeTo(E(20), TOL);

    const distributable = await s.pa.cumulativeDistributable();
    expect(distributable).to.be.closeTo(E(380), TOL);
    expect(await s.usdt.balanceOf(s.treasury.address)).to.be.closeTo(E(38), TOL);

    const rewards = await s.rd.totalNotified();
    expect(rewards).to.be.closeTo(E(342), TOL);
    expect(await s.rd.pendingReward(s.alice.address)).to.be.closeTo((rewards * 3n) / 4n, TOL);
    expect(await s.rd.pendingReward(s.bob.address)).to.be.closeTo(rewards / 4n, TOL);

    // Rewards are fully funded and segregated from principal.
    expect(await s.usdt.balanceOf(await s.rd.getAddress())).to.equal(await s.rd.totalLiabilities());
    expect(await s.vault.totalAssets()).to.be.closeTo(E(40_000), TOL);
  });

  it("excludes unrealized gains from NAV and withdrawals until harvested", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.marketA.accrueInterest(E(1_000));
    expect(await s.vault.totalAssets()).to.equal(E(40_000));
    expect(await s.vault.estimatedNav()).to.be.closeTo(E(41_000), TOL);
    expect(await s.vault.maxWithdraw(s.alice.address)).to.equal(E(30_000));
  });

  it("does not treat a token donation as revenue", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.usdt.mint(await s.vault.getAddress(), E(5_000));
    await s.vault.connect(s.keeper).harvest(0);
    expect(await s.rd.totalNotified()).to.equal(0);
  });

  it("recognizes losses, carries them forward and resumes rewards only above the high-water mark", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.marketA.realizeLoss(E(2_000));
    await s.vault.connect(s.keeper).harvest(0);
    expect(await s.vault.totalAssets()).to.be.closeTo(E(38_000), TOL);
    expect(await s.pa.lossCarryforward(await s.vault.totalAssets(), await s.vault.totalSupply()))
      .to.be.closeTo(E(2_000), TOL);
    expect(await s.rd.totalNotified()).to.equal(0);

    // First recovery: 1,000 gain (50 cost) all goes back into NAV.
    await s.marketB.accrueInterest(E(1_000));
    await s.vault.connect(s.keeper).harvest(E(50));
    expect(await s.rd.totalNotified()).to.equal(0);
    expect(await s.pa.cumulativeRecovered()).to.be.closeTo(E(950), TOL);

    // Second: 2,000 gain (50 cost) — 1,050 restores the HWM, 900 becomes distributable.
    await s.marketB.accrueInterest(E(2_000));
    await s.vault.connect(s.keeper).harvest(E(50));
    expect(await s.pa.cumulativeDistributable()).to.be.closeTo(E(900), E(1));
    expect(await s.vault.pricePerShare()).to.be.closeTo(E(1), 10n ** 12n);
  });

  it("keeps accrued rewards with the holder when shares are transferred", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.marketA.accrueInterest(E(400));
    await s.vault.connect(s.keeper).harvest(0);
    const alicePending = await s.rd.pendingReward(s.alice.address);

    await s.vault.connect(s.alice).transfer(s.carol.address, await s.vault.balanceOf(s.alice.address));
    expect(await s.rd.pendingReward(s.alice.address)).to.equal(alicePending);
    expect(await s.rd.pendingReward(s.carol.address)).to.equal(0);
  });
});

describe("AMYE — claim and compounding", () => {
  async function withRewards() {
    const s = await fundedAndDeployed();
    await s.marketA.accrueInterest(E(400));
    await s.vault.connect(s.keeper).harvest(0);
    return s;
  }

  it("claims realized rewards to the user", async () => {
    const s = await loadFixture(withRewards);
    const pending = await s.rd.pendingReward(s.alice.address);
    const before = await s.usdt.balanceOf(s.alice.address);
    await s.rd.connect(s.alice).claim();
    expect((await s.usdt.balanceOf(s.alice.address)) - before).to.equal(pending);
    expect(await s.rd.pendingReward(s.alice.address)).to.equal(0);
    expect(await s.rd.claimedBy(s.alice.address)).to.equal(pending);
    await expect(s.rd.connect(s.alice).claim()).to.be.revertedWithCustomError(s.rd, "NothingToClaim");
  });

  it("compounds rewards into new shares for the same user", async () => {
    const s = await loadFixture(withRewards);
    const pending = await s.rd.pendingReward(s.alice.address);
    const sharesBefore = await s.vault.balanceOf(s.alice.address);
    await s.rd.connect(s.alice).compound();
    expect(await s.vault.balanceOf(s.alice.address)).to.be.gt(sharesBefore);
    expect(await s.rd.compoundedBy(s.alice.address)).to.equal(pending);
    expect(await s.rd.pendingReward(s.alice.address)).to.equal(0);
  });

  it("lets keepers auto-compound only for users who opted in", async () => {
    const s = await loadFixture(withRewards);
    await expect(s.rd.connect(s.outsider).compoundFor(s.bob.address))
      .to.be.revertedWithCustomError(s.rd, "AutoCompoundDisabled");
    await s.rd.connect(s.bob).setAutoCompound(true);
    const before = await s.vault.balanceOf(s.bob.address);
    await s.rd.connect(s.outsider).compoundFor(s.bob.address);
    expect(await s.vault.balanceOf(s.bob.address)).to.be.gt(before);
    expect(await s.vault.balanceOf(s.outsider.address)).to.equal(0);
  });
});

describe("AMYE — withdrawals and liquidity", () => {
  it("pulls from strategies when idle cash is insufficient (partial and full unstake)", async () => {
    const s = await loadFixture(fundedAndDeployed);
    const before = await s.usdt.balanceOf(s.bob.address);
    await s.vault.connect(s.bob).withdraw(E(6_000), s.bob.address, s.bob.address); // partial, > idle 4,000
    expect((await s.usdt.balanceOf(s.bob.address)) - before).to.equal(E(6_000));
    await s.vault.connect(s.bob).redeem(await s.vault.balanceOf(s.bob.address), s.bob.address, s.bob.address);
    expect(await s.vault.balanceOf(s.bob.address)).to.equal(0);
    expect((await s.usdt.balanceOf(s.bob.address)) - before).to.equal(E(10_000));
  });

  it("reverts withdrawals that exceed available liquidity and reports it via maxWithdraw", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.marketA.setCashLock(E(24_000)); // market A fully utilized
    expect(await s.vault.availableLiquidity()).to.equal(E(16_000));
    expect(await s.vault.maxWithdraw(s.alice.address)).to.equal(E(16_000));
    await expect(s.vault.connect(s.alice).withdraw(E(20_000), s.alice.address, s.alice.address)).to.be.reverted;
  });

  it("allows withdrawals while paused but blocks deposits and keeper actions", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.vault.connect(s.guardian).pause();
    await expect(s.vault.connect(s.alice).deposit(E(100), s.alice.address)).to.be.reverted;
    await expect(s.vault.connect(s.keeper).rebalance()).to.be.reverted;
    await s.vault.connect(s.alice).withdraw(E(1_000), s.alice.address, s.alice.address);
    await expect(s.vault.connect(s.guardian).unpause()).to.be.reverted; // only governance can unpause
    await s.vault.connect(s.governance).unpause();
  });

  it("bounds withdrawal freezes to 3 days", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await expect(s.vault.connect(s.guardian).freezeWithdrawals(4 * 86400))
      .to.be.revertedWithCustomError(s.vault, "InvalidConfig");
    await s.vault.connect(s.guardian).freezeWithdrawals(86400);
    await expect(s.vault.connect(s.alice).withdraw(E(1), s.alice.address, s.alice.address)).to.be.reverted;
    await time.increase(86401);
    await s.vault.connect(s.alice).withdraw(E(1), s.alice.address, s.alice.address);
  });
});

describe("AMYE — risk controls and roles", () => {
  it("restricts keeper and governance functions", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await expect(s.vault.connect(s.alice).harvest(0)).to.be.reverted;
    await expect(s.vault.connect(s.alice).rebalance()).to.be.reverted;
    await expect(s.router.connect(s.keeper).setTargets([7000, 1000, 1000])).to.be.reverted;
    await expect(s.router.connect(s.alice).deployToStrategy(0, 1, 1)).to.be.revertedWithCustomError(s.router, "OnlyVault");
    await expect(s.vault.connect(s.governance).setFeeConfig(s.treasury.address, 2_001, 0, 0))
      .to.be.revertedWithCustomError(s.vault, "InvalidConfig");
  });

  it("rejects targets above caps or that eat into the minimum reserve", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await expect(s.router.connect(s.governance).setTargets([6500, 2000, 1000]))
      .to.be.revertedWithCustomError(s.router, "TargetsExceedLimit");
    await expect(s.router.connect(s.governance).setTargets([6000, 2000, 1500]))
      .to.be.revertedWithCustomError(s.router, "TargetsExceedLimit");
  });

  it("lets the guardian only reduce risk", async () => {
    const s = await loadFixture(fundedAndDeployed);
    const a = await s.lendA.getAddress();
    await expect(s.risk.connect(s.guardian).guardianSetBlocked(a, false))
      .to.be.revertedWithCustomError(s.risk, "OnlyRiskReduction");
    await expect(s.risk.connect(s.guardian).guardianLowerLimits(a, 7000, E(1_000_000)))
      .to.be.revertedWithCustomError(s.risk, "OnlyRiskReduction");
    await s.risk.connect(s.guardian).guardianSetBlocked(a, true);
    expect(await s.risk.canReceiveDeposits(a)).to.equal(false);
  });

  it("limits how far a single risk report can move a score, and high scores block deposits", async () => {
    const s = await loadFixture(fundedAndDeployed);
    const a = await s.lendB.getAddress();
    await s.risk.connect(s.admin).grantRole(await s.risk.RISK_REPORTER_ROLE(), s.keeper.address);
    const h = ethers.id("report-1");
    await expect(s.risk.connect(s.keeper).reportRiskScore(a, 90, h))
      .to.be.revertedWithCustomError(s.risk, "ScoreStepTooLarge");
    await s.risk.connect(s.keeper).reportRiskScore(a, 75, h);
    await s.risk.connect(s.keeper).reportRiskScore(a, 85, h);
    expect(await s.risk.canReceiveDeposits(a)).to.equal(false);
  });

  it("skips deposits into blocked strategies during rebalance", async () => {
    const s = await loadFixture(deployStack);
    await s.risk.connect(s.guardian).guardianSetBlocked(await s.lendA.getAddress(), true);
    await s.vault.connect(s.alice).deposit(E(10_000), s.alice.address);
    await s.vault.connect(s.keeper).rebalance();
    expect(await s.router.bookValue(0)).to.equal(0);
    expect(await s.router.bookValue(1)).to.equal(E(2_000));
  });

  it("emergency exit returns funds, deactivates the strategy and settles the result", async () => {
    const s = await loadFixture(fundedAndDeployed);
    await s.marketA.accrueInterest(E(400));
    await s.vault.connect(s.guardian).emergencyExitStrategy(0);
    expect(await s.router.isActive(0)).to.equal(false);
    expect(await s.router.bookValue(0)).to.equal(0);
    expect(await s.vault.idleAssets()).to.be.closeTo(E(28_000), TOL);
    expect(await s.rd.totalNotified()).to.be.closeTo(E(360), TOL); // 400 gain, 10% fee, no keeper cost
  });
});
