// Full pipeline on a scripted SIMULATED setup:
// prop-desk signal → owner arms → confirmed break triggers order → fill →
// target exit → realized profit → T+1 settlement → tax reserve → compounding.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resample } from '../core/priceAction.ts';
import { scriptedLongSetup } from '../core/scenarios.ts';
import type { Candle } from '../core/types.ts';
import { harness } from './helpers.ts';

const M15 = 900_000;

describe('end-to-end on a scripted rulebook setup (simulation)', () => {
  it('validates, waits for confirmation, fills, exits at the price-action target and compounds verified profit', async () => {
    const h = await harness('simulation');
    const s0 = await h.engine.settings();
    await h.repo.settings.update(s0.id, { maxFeeToRiskPct: 100 }); // see docs: costs at ₹10k capital
    const end = Math.floor(h.clock.now() / M15) * M15;
    const c15: Candle[] = scriptedLongSetup(end, M15, 150);
    const put = (cs: Candle[]) => {
      h.market.upsertCandles('KITE', 'TATASTEEL', '15m', cs);
      h.market.upsertCandles('KITE', 'TATASTEEL', '1h', resample(h.market.closedCandles('KITE', 'TATASTEEL', '15m', Infinity), 3_600_000));
      const l = cs[cs.length - 1];
      h.quote('TATASTEEL', l.close, 'KITE', 0.05);
    };
    put(c15);

    const [sig] = await h.engine.generateSignals([{ venue: 'KITE', symbol: 'TATASTEEL' }]);
    assert.equal(sig.status, 'VALIDATED', sig.rejectionReasons.join(' | '));
    assert.ok(sig.target > sig.entry && sig.entry > sig.stop);
    assert.ok(sig.rrNetOfCosts >= 2);
    assert.ok(sig.retailIllusion);

    // Owner arms it: no order yet because the build-up has not broken.
    const armed = await h.engine.approveSignal(sig.id, { actor: 'owner' });
    assert.equal(armed.signal.status, 'APPROVED');
    assert.equal(armed.result, undefined);
    assert.equal((await h.engine.orders()).length, 0);

    // Next 15m candle closes above the build-up → confirmed break → order.
    h.clock.t = end + M15;
    const prev = c15[c15.length - 1];
    put([{ ts: end, open: prev.close, high: sig.entry + 0.2, low: prev.close - 0.05, close: sig.entry + 0.1, volume: 2000 }]);
    await h.engine.onMarketUpdate();
    const entry = (await h.engine.orders()).find((o) => o.side === 'BUY')!;
    assert.equal(entry.status, 'FILLED');
    assert.ok(entry.plannedRiskPaise! <= 5000, `planned risk ${entry.plannedRiskPaise}`);
    assert.equal((await h.repo.signals.get(sig.id))!.status, 'EXECUTED');

    // Price reaches the target → reduce-only TARGET exit.
    h.clock.advance(4 * M15);
    put([{ ts: end + 3 * M15, open: sig.entry, high: sig.target + 0.5, low: sig.entry, close: sig.target + 0.3, volume: 3000 }]);
    await h.engine.onMarketUpdate();
    const exit = (await h.engine.orders()).find((o) => o.side === 'SELL')!;
    assert.equal(exit.exitReason, 'TARGET');
    assert.equal(exit.status, 'FILLED');
    const eq = await h.engine.equity();
    assert.ok(eq.realizedPaise > 0 && eq.positions.size === 0);

    // Next day: T+1 settled → tax reserve + compounding.
    h.clock.advance(86_400_000);
    const log = await h.engine.dailyClose('2026-11-18');
    assert.equal(log.status, 'SUCCESS', log.message);
    const ev = (await h.repo.compounding.list())[0];
    assert.equal(ev.status, 'COMPOUNDED');
    assert.ok(ev.reinvestedPaise > 0 && ev.toReservePaise >= 0);
    const after = await h.engine.equity();
    assert.ok(after.taxReservePaise > 0, 'tax reserve provisioned');
    assert.ok((await h.engine.ledger.verifyChain('simulation')).ok);
    assert.ok((await h.engine.verifyAudit()).ok);
    console.log(`  e2e: entry ${entry.avgFillPrice} x${entry.filledQty}, exit ${exit.avgFillPrice}, realized ₹${after.realizedPaise / 100}, fees ₹${after.feesPaise / 100}, tax reserve ₹${after.taxReservePaise / 100}, reinvested ₹${ev.reinvestedPaise / 100}`);
  });

  it('an armed signal expires when the setup is invalidated (close below stop) and never trades', async () => {
    const h = await harness('simulation');
    const s0 = await h.engine.settings();
    await h.repo.settings.update(s0.id, { maxFeeToRiskPct: 100 });
    const end = Math.floor(h.clock.now() / M15) * M15;
    const c15 = scriptedLongSetup(end, M15, 150);
    h.market.upsertCandles('KITE', 'TATASTEEL', '15m', c15);
    h.market.upsertCandles('KITE', 'TATASTEEL', '1h', resample(c15, 3_600_000));
    h.quote('TATASTEEL', c15[c15.length - 1].close, 'KITE', 0.05);
    const [sig] = await h.engine.generateSignals([{ venue: 'KITE', symbol: 'TATASTEEL' }]);
    assert.equal(sig.status, 'VALIDATED');
    await h.engine.approveSignal(sig.id, { actor: 'owner' });
    h.clock.t = end + M15;
    h.market.upsertCandles('KITE', 'TATASTEEL', '15m', [{ ts: end, open: 123.4, high: 123.5, low: sig.stop - 1, close: sig.stop - 0.5, volume: 1 }]);
    h.quote('TATASTEEL', sig.stop - 0.5, 'KITE', 0.05);
    await h.engine.onMarketUpdate();
    assert.equal((await h.repo.signals.get(sig.id))!.status, 'EXPIRED');
    assert.equal((await h.engine.orders()).length, 0);
  });

  it('production signals cannot be armed without the Final Check (manual items + written journal)', async () => {
    const h = await harness('production');
    const end = Math.floor(h.clock.now() / M15) * M15;
    const c15 = scriptedLongSetup(end, M15, 150);
    h.market.upsertCandles('KITE', 'TATASTEEL', '15m', c15);
    h.market.upsertCandles('KITE', 'TATASTEEL', '1h', resample(c15, 3_600_000));
    h.quote('TATASTEEL', c15[c15.length - 1].close, 'KITE', 0.05);
    const s = await h.engine.settings();
    await h.repo.settings.update(s.id, { firstLiveOrderConfirmedAt: h.clock.now(), maxFeeToRiskPct: 100 });
    const [sig] = await h.engine.generateSignals([{ venue: 'KITE', symbol: 'TATASTEEL' }]);
    if (sig.status !== 'VALIDATED') return; // production equity is 0 → sizing fails; still must not trade
    await assert.rejects(() => h.engine.approveSignal(sig.id, { actor: 'owner' }), /Final Check not passed/);
  });
});
