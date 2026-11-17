import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { backtest } from '../core/backtest.ts';
import { mergeAiReview, parseAiReview } from '../core/aiReview.ts';
import { estimateFees } from '../core/fees.ts';
import { hmacSha256Hex, sha256Hex } from '../core/hash.ts';
import { SEED_INSTRUMENTS, SYNTHETIC_UNIVERSE } from '../core/instruments.ts';
import { Ledger, LedgerError } from '../core/ledger.ts';
import { isNseOpen, nextTradingDate, settlementDate } from '../core/marketHours.ts';
import { SyntheticMarket } from '../core/marketData.ts';
import { classifyRetracement, detectRange, territory } from '../core/priceAction.ts';
import { dailyRiskBudgetPct, evaluateFinalCheck, FINAL_CHECK, MANUAL_FINAL_CHECK_IDS, pyramidSchedule, qtyFromRisk, rewardRisk, spreadPeRule, scoreStock } from '../core/propDesk.ts';
import { createMemoryRepo, ImmutableRecordError } from '../core/repo.ts';
import { sizePosition } from '../core/risk.ts';
import { applySettingsChange, defaultSettings, RISK_CONFIRMATION_PHRASE } from '../core/settings.ts';
import { buildSignal } from '../core/signals.ts';
import type { Candle } from '../core/types.ts';
import { resample } from '../core/priceAction.ts';
import { T0 } from './helpers.ts';

describe('hash', () => {
  it('sha256 and hmac match node:crypto', () => {
    for (const s of ['', 'abc', 'x'.repeat(1000), 'नमस्ते ₹']) {
      assert.equal(sha256Hex(s), createHash('sha256').update(s).digest('hex'));
      assert.equal(hmacSha256Hex('key', s), createHmac('sha256', 'key').update(s).digest('hex'));
      assert.equal(hmacSha256Hex('k'.repeat(100), s), createHmac('sha256', 'k'.repeat(100)).update(s).digest('hex'));
    }
  });
});

describe('ledger', () => {
  const mk = () => { const repo = createMemoryRepo(); return { repo, l: new Ledger(repo.ledger, () => T0) }; };
  const dep = (k: string, amt = 100) => ({ environment: 'simulation' as const, type: 'DEPOSIT' as const, idempotencyKey: k, source: 'SIMULATED' as const, memo: 'd', lines: [{ account: 'ASSET:CASH:BANK', amountPaise: amt }, { account: 'EQUITY:CONTRIBUTED', amountPaise: -amt }] });
  it('rejects unbalanced, zero and fractional lines', async () => {
    const { l } = mk();
    await assert.rejects(() => l.post({ ...dep('a'), lines: [{ account: 'A', amountPaise: 100 }, { account: 'B', amountPaise: -99 }] }), LedgerError);
    await assert.rejects(() => l.post({ ...dep('b'), lines: [{ account: 'A', amountPaise: 0 }, { account: 'B', amountPaise: 0 }] }), LedgerError);
    await assert.rejects(() => l.post({ ...dep('c'), lines: [{ account: 'A', amountPaise: 1.5 }, { account: 'B', amountPaise: -1.5 }] }), /integer paise/);
  });
  it('is idempotent and append-only', async () => {
    const { l, repo } = mk();
    const a = await l.post(dep('same'));
    const b = await l.post(dep('same', 999));
    assert.equal(a.id, b.id);
    await assert.rejects(() => repo.ledger.update(a.id, { memo: 'edited' }), ImmutableRecordError);
  });
  it('hash chain detects tampering', async () => {
    const { l, repo } = mk();
    for (let i = 0; i < 5; i++) await l.post(dep(`k${i}`, 100 + i));
    assert.ok((await l.verifyChain('simulation')).ok);
    // simulate a direct database edit bypassing the API
    const rows = (repo.ledger as unknown as { dump(): { lines: { amountPaise: number }[] }[] }).dump();
    rows[2].lines[0].amountPaise += 1; rows[2].lines[1].amountPaise -= 1;
    const v = await l.verifyChain('simulation');
    assert.equal(v.ok, false);
    assert.equal(v.brokenAtSeq, 3);
  });
});

describe('settings governance', () => {
  const s = defaultSettings('production', T0);
  it('AI / system / worker cannot change settings', () => {
    for (const actor of ['ai', 'system', 'worker'] as const) assert.equal(applySettingsChange(s, { patch: { maxRiskPerTradePct: 0.25 }, actor, now: T0, confirmationPhrase: RISK_CONFIRMATION_PHRASE }).ok, false);
  });
  it('risk changes need the typed confirmation', () => {
    assert.equal(applySettingsChange(s, { patch: { maxRiskPerTradePct: 0.25 }, actor: 'owner', now: T0 }).ok, false);
    const r = applySettingsChange(s, { patch: { maxRiskPerTradePct: 0.25 }, actor: 'owner', now: T0, confirmationPhrase: RISK_CONFIRMATION_PHRASE });
    assert.equal(r.ok, true);
    assert.equal(r.effectiveFrom, 'now');
  });
  it('loosening is deferred to the next trading day; hard ceilings cannot be exceeded', () => {
    const r = applySettingsChange(s, { patch: { maxRiskPerTradePct: 0.75 }, actor: 'owner', now: T0, confirmationPhrase: RISK_CONFIRMATION_PHRASE });
    assert.equal(r.effectiveFrom, 'next_trading_day');
    assert.equal(applySettingsChange(s, { patch: { maxRiskPerTradePct: 2 }, actor: 'owner', now: T0, confirmationPhrase: RISK_CONFIRMATION_PHRASE }).ok, false);
    assert.equal(applySettingsChange(s, { patch: { dailyRiskBudgetPct: 1.5 }, actor: 'owner', now: T0, confirmationPhrase: RISK_CONFIRMATION_PHRASE }).ok, false);
    assert.equal(applySettingsChange(s, { patch: { maxOpenExposurePct: 150 }, actor: 'owner', now: T0, confirmationPhrase: RISK_CONFIRMATION_PHRASE }).ok, false);
  });
});

describe('market hours & settlement', () => {
  it('NSE open/closed and T+1', () => {
    assert.equal(isNseOpen(T0), true);
    assert.equal(isNseOpen(Date.parse('2026-11-21T05:30:00Z')), false); // Saturday
    assert.equal(nextTradingDate('2026-11-20'), '2026-11-23');
    assert.equal(settlementDate('EQUITY', T0), '2026-11-18');
    assert.equal(settlementDate('CRYPTO', T0), '2026-11-17');
  });
});

describe('fees', () => {
  it('equity delivery: STT both sides, stamp on buy, DP on sell; crypto: TDS only on sell', () => {
    const b = estimateFees('EQUITY', 'BUY', 10, 1000), s = estimateFees('EQUITY', 'SELL', 10, 1000);
    assert.equal(b.parts.stt, 1000); assert.equal(b.parts.stamp, 150); assert.equal(b.parts.dp, 0);
    assert.equal(s.parts.stamp, 0); assert.equal(s.parts.dp, 1593);
    const cs = estimateFees('CRYPTO', 'SELL', 1, 10000), cb = estimateFees('CRYPTO', 'BUY', 1, 10000);
    assert.equal(cs.tdsPaise, 10000); assert.equal(cb.tdsPaise, 0);
  });
});

describe('prop desk math', () => {
  it('R:R with reverse check (long and short)', () => {
    const r = rewardRisk('LONG', 576, 568, 600);
    assert.equal(r.rr, 3); assert.ok(r.reverseOk);
    const s = rewardRisk('SHORT', 576, 583.5, 544);
    assert.ok(Math.abs(s.rr - 4.2667) < 1e-3); assert.ok(s.reverseOk);
    assert.equal(rewardRisk('LONG', 100, 101, 110).rr, 0);
  });
  it('qty with reverse check', () => {
    const q = qtyFromRisk(50, 1500, 1490);
    assert.equal(q.qty, 5); assert.ok(q.reverseOk); assert.equal(q.reverseRisk, 50);
  });
  it('daily risk tiers never exceed 1% and default to lowest tier without sample', () => {
    assert.equal(dailyRiskBudgetPct(undefined, 0).pct, 0.25);
    assert.equal(dailyRiskBudgetPct(72, 50).pct, 0.5);
    assert.equal(dailyRiskBudgetPct(95, 100).pct, 0.75);
    assert.equal(dailyRiskBudgetPct(60, 50).pct, 0.25);
    assert.equal(dailyRiskBudgetPct(95, 100, { smallCapital: true }).pct, 0.5);
  });
  it('pyramid adds shrink; P/E spread rule is the course rule', () => {
    assert.deepEqual(pyramidSchedule(100), [100, 40, 30, 20, 10]);
    assert.equal(spreadPeRule(60, 20, 40).ok, true);
    assert.equal(spreadPeRule(20, 60, 40).ok, false);
  });
  it('stock scoring rejects against-sector and range-bound names', () => {
    assert.equal(scoreStock({ sectorSide: 'BUYERS', stockSide: 'SELLERS', rangeBound: false, overExtended: false, hasLogicOrV: true }).score, 'REJECT');
    assert.equal(scoreStock({ sectorSide: 'BUYERS', stockSide: 'BUYERS', rangeBound: true, overExtended: false, hasLogicOrV: true }).score, 'REJECT');
    assert.equal(scoreStock({ sectorSide: 'BUYERS', stockSide: 'BUYERS', rangeBound: false, overExtended: false, hasLogicOrV: true }).score, 'PRIMARY');
  });
  it('Final Check has 100 items; manual items pending block a pass until ticked', () => {
    assert.equal(FINAL_CHECK.length, 100);
    const allTrue = Object.fromEntries(FINAL_CHECK.filter((d) => d[3]).map((d) => [d[3]!, true]));
    const pending = evaluateFinalCheck(allTrue);
    assert.equal(pending.passed, false);
    assert.deepEqual(pending.pendingManual, MANUAL_FINAL_CHECK_IDS);
    const ok = evaluateFinalCheck(allTrue, Object.fromEntries(MANUAL_FINAL_CHECK_IDS.map((i) => [i, true])));
    assert.equal(ok.passed, true);
    const fail = evaluateFinalCheck({ ...allTrue, withTerritory: false }, Object.fromEntries(MANUAL_FINAL_CHECK_IDS.map((i) => [i, true])));
    assert.ok(fail.failed.includes(26) && fail.failed.includes(100));
  });
  it('sizing respects risk incl. costs and the notional cap', () => {
    const z = sizePosition({ equityPaise: 1_000_000, riskPct: 0.5, entry: 100, stop: 98, assetClass: 'EQUITY', qtyDecimals: 0, lotSize: 1, maxNotionalPaise: 500_000 });
    assert.ok(z.qty > 0 && z.riskPaise <= 5000);
    assert.ok(z.qty * 100 <= 5000);
  });
});

const C = (ts: number, o: number, h: number, l: number, c: number): Candle => ({ ts, open: o, high: h, low: l, close: c, volume: 1 });

describe('price action', () => {
  it('retracement classes follow the rulebook bands', () => {
    assert.equal(classifyRetracement(10), 'VERY_HEALTHY');
    assert.equal(classifyRetracement(20), 'OK');
    assert.equal(classifyRetracement(50), 'EXHAUSTING');
    assert.equal(classifyRetracement(55), 'NO_NEW_ENTRY');
    assert.equal(classifyRetracement(70), 'RANGE');
    assert.equal(classifyRetracement(100), 'OVER');
  });
  it('detects a 4-touch range', () => {
    const cs: Candle[] = [];
    const seq = [101, 103.8, 101.2, 103.9, 100.8, 103.7, 101.1, 103.6, 100.9, 103.8, 101, 103.5];
    seq.forEach((p, i) => cs.push(C(i, p, p + 0.3, p - 0.3, p)));
    const r = detectRange(cs, { minTouches: 4, minBars: 8 });
    assert.ok(r && r.touches >= 4, JSON.stringify(r));
  });
  it('territory: sustained break of a reacted high → BUYERS; initiator break flips to SELLERS', () => {
    const p = [100, 102, 104, 106, 108, 110, 108, 106, 105, 106, 108, 110.5, 112, 113, 114, 115];
    const cs = p.map((x, i) => C(i, x - 0.5, x + 0.3, x - 0.8, x));
    const t = territory(cs, 2);
    assert.equal(t.side, 'BUYERS');
    assert.ok(t.initiatorLevel !== undefined && t.initiatorLevel < 110);
    const down = [...p, 112, 108, 104, 100, 98, 96].map((x, i) => C(i, x + 0.5, x + 0.8, x - 0.3, x));
    assert.equal(territory(down, 2).side, 'SELLERS');
  });
});

describe('signal pipeline on synthetic data', () => {
  it('every VALIDATED signal respects stop < entry < target, risk caps and net R:R; manual Final Check items stay pending', () => {
    const sym = SYNTHETIC_UNIVERSE.find((s) => s.symbol === 'HCLTECH')!;
    const inst = SEED_INSTRUMENTS.find((i) => i.symbol === 'HCLTECH')!;
    const mkt = new SyntheticMarket([sym], 7);
    const base = mkt.history(sym, T0, 6000);
    const ttf = resample(base, 900_000), htf = resample(base, 3_600_000);
    const s = { ...defaultSettings('simulation', T0), maxFeeToRiskPct: 60 };
    let validated = 0, seen = 0;
    for (let i = 200; i < ttf.length; i += 3) {
      const now = ttf[i].ts + 900_000;
      const sig = buildSignal({
        environment: 'simulation', instrument: inst, ttf: '15m', ttfCandles: ttf.slice(0, i + 1), htfCandles: htf.filter((c) => c.ts + 3_600_000 <= now),
        quote: { symbol: inst.symbol, venue: 'KITE', ltp: ttf[i].close, bid: ttf[i].close - 0.05, ask: ttf[i].close + 0.05, exchangeTs: now, receivedAt: now, source: 'SIMULATED' },
        now, settings: s, equityPaise: 1_000_000, dataSource: 'SIMULATED',
        ctx: { tradesToday: 0, sectorTradesToday: 0, rangeShareOk: true, stopOutSymbols: [], postTradeUpToDate: true, plannedRiskTodayPaise: 0, accuracyTierPct: 0.5, sectorSide: 'BUYERS', indexSide: 'BUYERS' },
      });
      seen++;
      assert.ok(['REJECTED', 'WATCHLIST', 'VALIDATED'].includes(sig.status));
      if (sig.status === 'VALIDATED') {
        validated++;
        assert.ok(sig.stop < sig.entry && sig.entry < sig.target);
        assert.ok(sig.rrNetOfCosts >= s.minRewardRisk);
        assert.ok(sig.plannedRiskPaise <= 5000);
        assert.ok(sig.qty > 0);
        assert.ok(sig.finalCheck && !sig.finalCheck.passed && sig.finalCheck.pendingManual.length > 0);
        assert.ok(sig.retailIllusion && sig.invalidation.length >= 2);
      } else assert.ok(sig.rejectionReasons.length > 0);
    }
    assert.ok(seen > 50);
    console.log(`  synthetic HCLTECH: ${seen} evaluations, ${validated} validated`);
  });
  it('backtest runs without look-ahead and reports caveats', () => {
    const sym = SYNTHETIC_UNIVERSE.find((s) => s.symbol === 'SOLINR')!;
    const inst = SEED_INSTRUMENTS.find((i) => i.symbol === 'SOLINR')!;
    const base = new SyntheticMarket([sym], 11).history(sym, T0, 8000);
    const r = backtest({ instrument: inst, base, baseTf: '5m', ttf: '1h', settings: { ...defaultSettings('simulation'), maxFeeToRiskPct: 60, dailyRiskBudgetPct: 1 } });
    assert.ok(Number.isFinite(r.netPnlPaise));
    assert.ok(r.caveats.length >= 3);
    assert.equal(r.finalEquityPaise - r.startEquityPaise, r.trades.reduce((a, t) => a + t.pnlPaise, 0));
    console.log(`  synthetic SOLINR backtest: ${r.trades.length} trades, win ${r.winRatePct.toFixed(0)}%, net ₹${r.netPnlPaise / 100}, maxDD ${r.maxDrawdownPct}%`);
  });
});

describe('AI review can only make signals more conservative', () => {
  it('rejects malformed output and never upgrades', () => {
    assert.equal(parseAiReview('not json'), null);
    assert.equal(parseAiReview('{"verdict":"buy now","notes":""}'), null);
    const base = { status: 'WATCHLIST', confidence: 0.3, rejectionReasons: [] } as never;
    const out = mergeAiReview(base, { verdict: 'agree', notes: 'ok', missing_conditions: [], retail_illusion_ok: true }, 'm', 1);
    assert.equal(out.status, 'WATCHLIST');
    assert.equal(out.confidence, 0.3);
    const v = mergeAiReview({ status: 'VALIDATED', confidence: 0.8, rejectionReasons: [] } as never, { verdict: 'downgrade', notes: 'x', missing_conditions: [], retail_illusion_ok: false }, 'm', 1);
    assert.equal(v.status, 'WATCHLIST'); assert.ok(v.confidence <= 0.3);
  });
});
