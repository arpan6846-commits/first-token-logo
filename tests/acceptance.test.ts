// Acceptance tests mapped 1:1 to the requirements list.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { eligibleProfit } from '../core/compounding.ts';
import { LedgerError } from '../core/ledger.ts';
import { OrderManager } from '../core/oms.ts';
import { evaluateOrder } from '../core/risk.ts';
import { buildSignal } from '../core/signals.ts';
import { buyProposal, harness, makeProductionReady, type Harness } from './helpers.ts';

async function relaxCosts(h: Harness) {
  const s = await h.engine.settings();
  await h.repo.settings.update(s.id, { maxFeeToRiskPct: 1000, minRewardRisk: 0.5 });
}
const rupees = (p: number) => p / 100;

describe('1. INR 10,000 initial capital', () => {
  it('appears correctly with the 5,000 / 2,000 / 3,000 allocation (simulation book)', async () => {
    const h = await harness('simulation');
    const eq = await h.engine.equity();
    assert.equal(eq.netEquityPaise, 1_000_000);
    assert.equal(eq.netContributionsPaise, 1_000_000);
    assert.equal(eq.cashByVenue.KITE, 500_000);
    assert.equal(eq.cashByVenue.COINDCX, 200_000);
    assert.equal(eq.cashByVenue.BANK, 300_000);
    const s = await h.engine.settings();
    assert.deepEqual(s.allocation, { stocksPaise: 500_000, cryptoPaise: 200_000, reservePaise: 300_000 });
  });
  it('production book is NOT pre-funded: real balances only come from owner deposits confirmed by reconciliation', async () => {
    const h = await harness('production');
    assert.equal((await h.engine.equity()).netEquityPaise, 0);
  });
});

describe('2. Simulated trades never alter real cash balances', () => {
  it('simulation fills do not touch the production book even on a shared database', async () => {
    const sim = await harness('simulation');
    const prod = await harness('production', { repo: sim.repo });
    await makeProductionReady(prod);
    const before = await prod.engine.ledger.balances('production');
    await relaxCosts(sim);
    sim.quote('INFY', 1500);
    const r = await sim.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    assert.equal(r.order.status, 'FILLED');
    const after = await prod.engine.ledger.balances('production');
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
    assert.ok((await prod.engine.ledger.verifyChain('production')).ok);
  });
  it('the production ledger refuses SIMULATED / PAPER_FEED data', async () => {
    const h = await harness('production');
    await assert.rejects(() => h.engine.ledger.post({ environment: 'production', type: 'DEPOSIT', idempotencyKey: 'x', source: 'SIMULATED', memo: 'x', lines: [{ account: 'ASSET:CASH:KITE', amountPaise: 100 }, { account: 'EQUITY:CONTRIBUTED', amountPaise: -100 }] }), LedgerError);
    await assert.rejects(() => h.engine.ledger.post({ environment: 'production', type: 'DEPOSIT', idempotencyKey: 'y', source: 'PAPER_FEED', memo: 'x', lines: [{ account: 'ASSET:CASH:KITE', amountPaise: 100 }, { account: 'EQUITY:CONTRIBUTED', amountPaise: -100 }] }), LedgerError);
  });
  it('production cannot be wired to a paper/simulation adapter', async () => {
    const h = await harness('simulation');
    assert.throws(() => new OrderManager('production', h.repo, h.engine.ledger, { KITE: h.kite }), /cannot use a SIMULATION adapter/);
  });
});

describe('3. Real orders require actual broker confirmation', () => {
  it('order is OPEN/FILLED only after the venue returns an order id; manual mode waits for the owner', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'rest' });
    const r = await h.engine.submitOrder(buyProposal('production'), { actor: 'system' });
    assert.equal(r.order.status, 'AWAITING_OWNER');
    assert.equal(r.order.brokerOrderId, undefined);
    assert.equal(h.placeCalls.n, 0);
    const c = await h.engine.confirmOrder(r.order.id, { actor: 'owner', ownerConfirmed: true });
    assert.equal(c.order.status, 'OPEN');
    assert.ok(c.order.brokerOrderId);
    assert.equal((await h.engine.fills()).length, 0, 'no fill until the venue reports one');
  });
  it('first live order needs the typed confirmation phrase', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    await relaxCosts(h);
    const s = await h.engine.settings();
    await h.repo.settings.update(s.id, { firstLiveOrderConfirmedAt: undefined });
    h.quote('INFY', 1500);
    const r = await h.engine.submitOrder(buyProposal('production'), { actor: 'owner', ownerConfirmed: true });
    assert.equal(r.order.status, 'AWAITING_OWNER');
    assert.equal(h.placeCalls.n, 0);
  });
  it('a timeout is UNKNOWN and is resolved by client order id — never re-sent', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'timeout_after_accept' });
    const r = await h.engine.submitOrder(buyProposal('production'), { actor: 'owner', ownerConfirmed: true });
    assert.equal(h.placeCalls.n, 1);
    assert.equal(r.order.status, 'FILLED', 'resolved via findOrderByClientId');
    assert.ok(r.order.brokerOrderId);
  });
  it('a timeout before the venue accepted stays UNKNOWN (no blind retry)', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'timeout_before_accept' });
    const r = await h.engine.submitOrder(buyProposal('production'), { actor: 'owner', ownerConfirmed: true });
    assert.equal(r.order.status, 'UNKNOWN');
    await h.engine.oms.syncAllOpen();
    assert.equal(h.placeCalls.n, 1);
  });
});

describe('4. Partial fills and rejected orders', () => {
  it('partial fill then cancel: holdings and cash reflect only the filled quantity', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'partial', fraction: 0.5, thenCancel: true });
    const r = await h.engine.submitOrder(buyProposal('simulation', { qty: 2, stopPrice: 1490, targetPrice: 1540 }), { actor: 'owner' });
    assert.equal(r.order.status, 'CANCELLED');
    assert.equal(r.order.filledQty, 1);
    const eq = await h.engine.equity();
    assert.equal(eq.positions.get('KITE:INFY')?.qty, 1);
    const f = (await h.engine.fills())[0];
    assert.equal(eq.cashByVenue.KITE, 500_000 - Math.round(f.qty * f.price * 100) - r.order.feesPaise);
  });
  it('partial fill that completes later becomes FILLED with a weighted average price', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'partial', fraction: 0.5 });
    const r = await h.engine.submitOrder(buyProposal('simulation', { qty: 2, stopPrice: 1490, targetPrice: 1540 }), { actor: 'owner' });
    assert.equal(r.order.status, 'PARTIALLY_FILLED');
    await h.engine.onMarketUpdate();
    const o = await h.repo.orders.get(r.order.id);
    assert.equal(o?.status, 'FILLED');
    assert.equal(o?.filledQty, 2);
    assert.equal((await h.engine.fills()).length, 2);
  });
  it('venue rejection leaves no fill and no cash change', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'reject', reason: 'RMS: insufficient funds' });
    const r = await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    assert.equal(r.order.status, 'REJECTED');
    assert.match(r.order.rejectionReason ?? '', /insufficient/);
    assert.equal((await h.engine.fills()).length, 0);
    assert.equal((await h.engine.equity()).netEquityPaise, 1_000_000);
  });
});

describe('5. Duplicate orders cannot be created by retrying', () => {
  it('same idempotency key returns the original order; venue called once', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    const p = buyProposal('simulation', { idempotencyKey: 'retry-me' });
    const a = await h.engine.submitOrder(p, { actor: 'owner' });
    const b = await h.engine.submitOrder(p, { actor: 'owner' });
    assert.equal(b.duplicate, true);
    assert.equal(a.order.id, b.order.id);
    assert.equal(h.placeCalls.n, 1);
    assert.equal((await h.engine.orders()).length, 1);
  });
  it('concurrent retries still produce one order', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    const p = buyProposal('simulation', { idempotencyKey: 'race' });
    const rs = await Promise.all([1, 2, 3, 4].map(() => h.engine.submitOrder(p, { actor: 'owner' })));
    assert.equal(new Set(rs.map((r) => r.order.id)).size, 1);
    assert.equal((await h.engine.orders()).length, 1);
    assert.equal(h.placeCalls.n, 1);
  });
  it('replayed venue trades are recorded once (one fill, one ledger entry)', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    const r = await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    const st = await h.kite.getOrder(r.order.brokerOrderId!);
    for (let i = 0; i < 3; i++) await h.engine.oms.applyVenueState(r.order, st);
    assert.equal((await h.engine.fills()).length, 1);
    assert.equal((await h.engine.ledger.entries('simulation')).filter((e) => e.type === 'BUY_FILL').length, 1);
  });
});

describe('6. Profits are recorded only from verified executions', () => {
  it('unreconciled production fills are excluded from eligible profit until reconciliation', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    await relaxCosts(h);
    h.quote('BTCINR', 8_000_000);
    const buy = await h.engine.submitOrder({ ...buyProposal('production'), venue: 'COINDCX', symbol: 'BTCINR', assetClass: 'CRYPTO', product: 'SPOT', qty: 0.0002, limitPrice: 8_000_001, stopPrice: 7_900_000, targetPrice: 8_400_000 }, { actor: 'owner', ownerConfirmed: true });
    assert.equal(buy.order.status, 'FILLED');
    h.quote('BTCINR', 8_400_000);
    await h.engine.runExitManager();
    const fills = await h.engine.fills();
    assert.equal(fills.length, 2);
    assert.ok(fills.every((f) => f.reconciled === false), 'production fills start unverified');
    const s = await h.engine.settings();
    assert.equal(eligibleProfit(fills, '2026-11-17', s.taxRates).netPaise, 0);
    const rec = await h.engine.reconcile('COINDCX');
    assert.equal((await h.engine.fills()).filter((f) => f.reconciled).length, 2, rec.message);
    const e2 = eligibleProfit(await h.engine.fills(), '2026-11-17', s.taxRates);
    assert.ok(e2.realizedGrossPaise > 0);
  });
  it('unrealized gains never count', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    await h.engine.submitOrder(buyProposal('simulation', { targetPrice: 2000 }), { actor: 'owner' });
    h.quote('INFY', 1700);
    const eq = await h.engine.equity();
    assert.ok(eq.unrealizedPaise > 0);
    const s = await h.engine.settings();
    assert.equal(eligibleProfit(await h.engine.fills(), '2026-11-30', s.taxRates).realizedGrossPaise, 0);
  });
  it('equity sells are not eligible before T+1 settlement', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    await h.engine.submitOrder(buyProposal('simulation', { targetPrice: 1560 }), { actor: 'owner' });
    h.quote('INFY', 1565);
    await h.engine.runExitManager();
    const s = await h.engine.settings();
    const f = await h.engine.fills();
    assert.equal(eligibleProfit(f, '2026-11-17', s.taxRates).realizedGrossPaise, 0);
    assert.ok(eligibleProfit(f, '2026-11-18', s.taxRates).realizedGrossPaise > 0);
  });
});

describe('7. Fees and losses reduce actual equity', () => {
  it('equity after a losing round trip = capital − price loss − all fees', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    const buy = await h.engine.submitOrder(buyProposal('simulation', { qty: 2, stopPrice: 1490 }), { actor: 'owner' });
    assert.equal(buy.order.status, 'FILLED');
    h.quote('INFY', 1470);
    await h.engine.runExitManager();
    const fills = await h.engine.fills();
    const sell = fills.find((f) => f.side === 'SELL')!;
    const totalFees = fills.reduce((a, f) => a + f.feesPaise, 0);
    const priceLoss = Math.round(2 * buy.order.avgFillPrice! * 100) - Math.round(2 * sell.price * 100);
    const eq = await h.engine.equity();
    assert.equal(eq.netEquityPaise, 1_000_000 - priceLoss - totalFees);
    assert.ok(eq.feesPaise === totalFees && totalFees > 0);
    assert.ok((await h.engine.ledger.verifyChain('simulation')).ok);
  });
});

describe('8. Compounding works from eligible actual profits', () => {
  it('reinvests the configured share of new net profit; net equity unchanged by compounding', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    const b = await h.engine.submitOrder(buyProposal('simulation', { qty: 3, stopPrice: 1495, targetPrice: 1550 }), { actor: 'owner' });
    assert.equal(b.order.status, 'FILLED', b.order.rejectionReason);
    h.quote('INFY', 1560);
    await h.engine.runExitManager();
    h.clock.advance(86_400_000); // next day: T+1 settled
    const before = (await h.engine.equity()).netEquityPaise;
    const s = await h.engine.settings();
    const elig = eligibleProfit(await h.engine.fills(), '2026-11-18', s.taxRates);
    await h.engine.dailyClose('2026-11-18');
    const ev = (await h.repo.compounding.list())[0];
    assert.equal(ev.status, 'COMPOUNDED');
    assert.equal(ev.newProfitPaise, elig.netPaise);
    assert.equal(ev.reinvestedPaise, Math.floor((elig.netPaise * 50) / 100));
    const after = await h.engine.equity();
    // tax reserve was provisioned (reduces equity), compounding itself is a reclassification
    assert.equal(after.netEquityPaise, before - elig.taxProvisionPaise);
    assert.equal(after.reinvestedPaise, ev.reinvestedPaise);
    // idempotent: re-running the close does nothing
    const again = await h.engine.dailyClose('2026-11-18');
    assert.equal(again.status, 'SKIPPED');
    assert.equal((await h.repo.compounding.list()).length, 1);
  });
  it('losses below the high-water mark prevent compounding', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    await h.engine.submitOrder(buyProposal('simulation', { qty: 2, stopPrice: 1490 }), { actor: 'owner' });
    h.quote('INFY', 1470);
    await h.engine.runExitManager();
    h.clock.advance(86_400_000);
    await h.engine.dailyClose('2026-11-18');
    const ev = (await h.repo.compounding.list())[0];
    assert.equal(ev.status, 'NOTHING_ELIGIBLE');
    assert.equal(ev.reinvestedPaise, 0);
  });
});

describe('9. Risk limits block unsafe orders', () => {
  const cases: [string, (h: Harness) => Promise<Record<string, unknown>>, string][] = [
    ['risk per trade > 0.5%', async () => ({ qty: 3, stopPrice: 1470 }), 'RISK_PER_TRADE'],
    ['missing stop', async () => ({ stopPrice: undefined }), 'STOP_DEFINED'],
    ['exposure > 50% / allocation', async () => ({ qty: 4, stopPrice: 1499 }), 'MAX_EXPOSURE'],
    ['leverage', async () => ({ leverage: 5 }), 'NO_LEVERAGE'],
    ['short selling', async () => ({ side: 'SELL' }), 'NO_SHORT_SELLING'],
    ['timeframe below 5m', async () => ({ timeframe: '1M' as const }), 'CANDLES_FRESH'],
    ['price outside prop-desk universe', async (h) => { h.quote('INFY', 50); return { limitPrice: 50, stopPrice: 49.5, targetPrice: 52 }; }, 'PRICE_UNIVERSE'],
  ];
  for (const [name, mk, code] of cases) {
    it(`blocks: ${name}`, async () => {
      const h = await harness('simulation');
      await relaxCosts(h);
      h.quote('INFY', 1500);
      const r = await h.engine.submitOrder(buyProposal('simulation', await mk(h)), { actor: 'owner' });
      assert.equal(r.order.status, 'RISK_REJECTED');
      assert.ok(r.decision!.failures.some((f) => f.code === code), `${code} not in ${r.decision!.failures.map((f) => f.code)}`);
      assert.equal(h.placeCalls.n, 0);
    });
  }
  it('blocks new entries after the daily loss stop (and latches a halt)', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    const s = await h.engine.settings();
    await h.repo.settings.update(s.id, { maxRiskPerTradePct: 1, dailyRiskBudgetPct: 1, maxOpenExposurePct: 100 });
    h.quote('INFY', 1500);
    const b = await h.engine.submitOrder(buyProposal('simulation', { qty: 3, stopPrice: 1476, targetPrice: 1600 }), { actor: 'owner' });
    assert.equal(b.order.status, 'FILLED', b.order.rejectionReason);
    h.quote('INFY', 1460); // −₹120 price loss + costs > 1% of 10,000
    await h.engine.checkLossLimits();
    h.quote('BTCINR', 8_000_000);
    const r = await h.engine.submitOrder({ ...buyProposal('simulation'), venue: 'COINDCX', symbol: 'BTCINR', assetClass: 'CRYPTO', product: 'SPOT', qty: 0.0001, limitPrice: 8_000_001, stopPrice: 7_990_000, targetPrice: 8_400_000 }, { actor: 'owner' });
    const codes = r.decision!.failures.map((f) => f.code);
    assert.ok(codes.includes('DAILY_LOSS_STOP') && codes.includes('HALT_LATCH'), codes.join(','));
  });
  it('blocks production orders when session expired, balances unreconciled, or venue down', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    await relaxCosts(h);
    h.quote('INFY', 1500);
    await h.repo.connections.update('conn_production_KITE', { sessionExpiresAt: h.clock.now() - 1 });
    const sys = await h.engine.system();
    await h.repo.system.update('system', { lastReconciliation: { ...sys.lastReconciliation, 'production:KITE': { ts: h.clock.now(), ok: false } } });
    h.kite.available = false;
    const r = await h.engine.submitOrder(buyProposal('production'), { actor: 'owner', ownerConfirmed: true });
    const codes = r.decision!.failures.map((f) => f.code);
    for (const c of ['API_SESSION', 'BALANCES_RECONCILED', 'VENUE_AVAILABLE']) assert.ok(codes.includes(c), `${c} missing in ${codes}`);
  });
  it('blocks production orders before Phase 5 and when live trading is disabled', async () => {
    const h = await harness('production');
    await makeProductionReady(h);
    const s = await h.engine.settings();
    await h.repo.settings.update(s.id, { phase: 4, liveTradingEnabled: false });
    h.quote('INFY', 1500);
    const r = await h.engine.submitOrder(buyProposal('production'), { actor: 'owner', ownerConfirmed: true });
    const codes = r.decision!.failures.map((f) => f.code);
    assert.ok(codes.includes('PHASE_GATE') && codes.includes('LIVE_ENABLED'));
  });
  it('with DEFAULT settings, small trades whose costs dominate the risk are rejected (cost finding)', async () => {
    const h = await harness('simulation');
    h.quote('INFY', 1500);
    const r = await h.engine.submitOrder(buyProposal('simulation', { qty: 2, stopPrice: 1490 }), { actor: 'owner' });
    assert.ok(r.decision!.failures.some((f) => f.code === 'COSTS_VS_RISK'));
  });
  it('the AI actor cannot submit orders', async () => {
    const h = await harness('simulation');
    h.quote('INFY', 1500);
    await assert.rejects(() => h.engine.submitOrder(buyProposal('simulation'), { actor: 'ai' }), /AI layer cannot submit/);
  });
});

describe('10. Emergency stop prevents new orders', () => {
  it('kill switch blocks entries and cancels open orders; only the owner can release it', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.kite.queueScenario({ kind: 'rest' });
    const resting = await h.engine.submitOrder(buyProposal('simulation', { limitPrice: 1495, stopPrice: 1480 }), { actor: 'owner' });
    assert.equal(resting.order.status, 'OPEN');
    await h.engine.setKillSwitch(true, 'test', 'owner');
    assert.equal((await h.repo.orders.get(resting.order.id))?.status, 'CANCELLED');
    const r = await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    assert.equal(r.order.status, 'RISK_REJECTED');
    assert.ok(r.decision!.failures.some((f) => f.code === 'KILL_SWITCH'));
    await assert.rejects(() => h.engine.setKillSwitch(false, 'x', 'ai'));
    await assert.rejects(() => h.engine.setKillSwitch(false, 'x', 'system'));
    await h.engine.setKillSwitch(false, 'resolved', 'owner', { confirm: true });
    assert.equal((await h.engine.system()).killSwitch.active, false);
  });
  it('protective stop exits of existing positions are still allowed while the kill switch is on', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    await h.engine.setKillSwitch(true, 'panic', 'owner');
    h.quote('INFY', 1470);
    const exits = await h.engine.runExitManager();
    assert.equal(exits[0].status, 'FILLED');
    assert.equal(exits[0].exitReason, 'STOP');
  });
});

describe('11. Missing market data prevents execution', () => {
  it('no quote → rejected', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    const r = await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    assert.ok(r.decision!.failures.some((f) => f.code === 'QUOTE_PRESENT'));
  });
  it('stale quote → rejected', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    h.clock.advance(60_000);
    const r = await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    assert.ok(r.decision!.failures.some((f) => f.code === 'QUOTE_FRESH'));
  });
  it('signal engine rejects stale / incomplete candles', async () => {
    const h = await harness('simulation');
    const inst = h.engine.instrument('KITE', 'INFY')!;
    const s = await h.engine.settings();
    const old = Array.from({ length: 150 }, (_, i) => ({ ts: Date.parse('2026-11-10T04:00:00Z') + i * 900_000, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    const sig = buildSignal({ environment: 'simulation', instrument: inst, ttf: '15m', ttfCandles: old, htfCandles: [], now: h.clock.now(), settings: s, equityPaise: 1_000_000, dataSource: 'SIMULATED', ctx: { tradesToday: 0, sectorTradesToday: 0, rangeShareOk: true, stopOutSymbols: [], postTradeUpToDate: true, plannedRiskTodayPaise: 0, accuracyTierPct: 0.5 } });
    assert.equal(sig.status, 'REJECTED');
    assert.ok(sig.rejectionReasons.some((r) => r.startsWith('DATA_STALE')));
    assert.ok(sig.rejectionReasons.some((r) => r.startsWith('NO_QUOTE')));
    assert.ok(sig.rejectionReasons.some((r) => r.startsWith('DATA_INCOMPLETE')));
  });
});

describe('12. The 10% daily target is never represented as guaranteed', () => {
  it('risk decisions do not depend on the target', async () => {
    const h = await harness('simulation');
    await relaxCosts(h);
    h.quote('INFY', 1500);
    const ctx = await h.engine.riskContext({ venue: 'KITE', symbol: 'INFY', assetClass: 'EQUITY' });
    const p = buyProposal('simulation', { idempotencyKey: 'tgt' });
    const a = evaluateOrder(p, ctx);
    const b = evaluateOrder(p, { ...ctx, settings: { ...ctx.settings, dailyTargetPct: 100 } });
    assert.deepEqual(a, b);
    const src = readFileSync('core/risk.ts', 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!src.includes('dailyTargetPct'));
  });
  it('no screen, doc or report contains guarantee language about returns', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue; if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|md|html|json)$/.test(f)) files.push(p); } };
    for (const d of ['frontend/src', 'docs', 'core', 'base44', 'worker']) { try { walk(d); } catch { /* dir may not exist yet */ } }
    const bad = /(guaranteed (returns?|profit|income)|assured returns?|risk[- ]free (profit|returns?)|will (earn|make) 10%|10% daily (guaranteed|assured))/i;
    const hits = files.filter((f) => bad.test(readFileSync(f, 'utf8').replace(/never represent[^.\n]*|not (a )?guarantee[^.\n]*/gi, '')));
    assert.deepEqual(hits, []);
  });
  it('every UI use of the daily target goes through the TargetProgress component with the disclaimer', () => {
    let tsx: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.tsx')) tsx.push(p); } };
    try { walk('frontend/src'); } catch { tsx = []; }
    for (const f of tsx) {
      const src = readFileSync(f, 'utf8');
      if (f.endsWith('TargetProgress.tsx')) { assert.match(src, /not a guarantee/i); continue; }
      assert.ok(!/dailyTargetPct|targetProgressPct/.test(src), `${f} renders the target directly`);
    }
  });
});
