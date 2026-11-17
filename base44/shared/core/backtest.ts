// Historical backtest (Phase 3). Walks closed candles forward, asks the same
// signal engine for candidates, simulates break-confirmation entries, stops and
// targets with the same fee model, and reports honest statistics. There is no
// look-ahead: each decision only sees candles that had closed at that time.

import { roundTripCost } from './fees.ts';
import { notionalPaise } from './money.ts';
import { resample } from './priceAction.ts';
import { buildSignal } from './signals.ts';
import { defaultSettings } from './settings.ts';
import type { Candle, Instrument, StrategySettings, Timeframe } from './types.ts';
import { TIMEFRAME_MINUTES } from './types.ts';
import { HTF_OF } from './signals.ts';

export interface BacktestTrade { symbol: string; entryTs: number; exitTs: number; entry: number; exit: number; qty: number; pnlPaise: number; feesPaise: number; reason: 'STOP' | 'TARGET' | 'TIMEOUT' }
export interface BacktestResult {
  trades: BacktestTrade[];
  signalsSeen: number;
  rejectedByReason: Record<string, number>;
  winRatePct: number;
  expectancyPaise: number;
  profitFactor: number;
  netPnlPaise: number;
  feesPaise: number;
  maxDrawdownPct: number;
  finalEquityPaise: number;
  startEquityPaise: number;
  caveats: string[];
}

export function backtest(args: {
  instrument: Instrument; base: Candle[]; baseTf: Timeframe; ttf: Timeframe; settings?: StrategySettings; startEquityPaise?: number; maxHoldBars?: number; step?: number;
}): BacktestResult {
  const s = args.settings ?? { ...defaultSettings('simulation'), dailyRiskBudgetPct: 1 };
  const ttfMs = TIMEFRAME_MINUTES[args.ttf] * 60_000, htfMs = TIMEFRAME_MINUTES[HTF_OF[args.ttf]] * 60_000;
  const ttfAll = args.ttf === args.baseTf ? args.base : resample(args.base, ttfMs);
  const htfAll = resample(args.base, htfMs);
  let equity = args.startEquityPaise ?? s.initialCapitalPaise;
  const start = equity;
  let peak = equity, maxDd = 0;
  const trades: BacktestTrade[] = [];
  const rejected: Record<string, number> = {};
  let seen = 0;
  const step = args.step ?? 1;
  for (let i = 150; i < ttfAll.length - 1; i += step) {
    const now = ttfAll[i].ts + ttfMs; // candle i just closed
    const ttf = ttfAll.slice(Math.max(0, i - 400), i + 1);
    const htf = htfAll.filter((c) => c.ts + htfMs <= now).slice(-200);
    const c = ttfAll[i];
    const sig = buildSignal({
      environment: 'simulation', instrument: args.instrument, ttf: args.ttf, ttfCandles: ttf, htfCandles: htf,
      quote: { symbol: args.instrument.symbol, venue: args.instrument.venue, ltp: c.close, bid: c.close, ask: c.close, exchangeTs: now, receivedAt: now, source: 'HISTORICAL' },
      now, settings: s, equityPaise: equity, dataSource: 'HISTORICAL',
      ctx: { tradesToday: 0, sectorTradesToday: 0, rangeShareOk: true, stopOutSymbols: [], postTradeUpToDate: true, plannedRiskTodayPaise: 0, accuracyTierPct: 1, sectorSide: 'BUYERS', indexSide: 'BUYERS' },
    });
    seen++;
    if (sig.status !== 'VALIDATED') { for (const r of sig.rejectionReasons) { const k = r.split(':')[0]; rejected[k] = (rejected[k] ?? 0) + 1; } continue; }
    // entry: next candles must close above build-up break (confirmation) within 6 bars, then fill at next open
    let j = i + 1, entered = -1;
    for (; j < Math.min(ttfAll.length - 1, i + 7); j++) {
      if (ttfAll[j].low <= sig.stop) break;               // invalidated before trigger
      if (ttfAll[j].close >= sig.entry) { entered = j + 1; break; }
    }
    if (entered < 0 || entered >= ttfAll.length) continue;
    const entryPx = Math.max(ttfAll[entered].open, sig.entry);
    if (entryPx > sig.entry + (sig.target - sig.entry) * 0.25) continue; // gap too far: skip, don't chase
    let exitPx = 0, reason: BacktestTrade['reason'] = 'TIMEOUT', k = entered;
    for (; k < Math.min(ttfAll.length, entered + (args.maxHoldBars ?? 60)); k++) {
      const b = ttfAll[k];
      if (b.open <= sig.stop) { exitPx = b.open; reason = 'STOP'; break; }      // gap through stop
      if (b.low <= sig.stop) { exitPx = sig.stop; reason = 'STOP'; break; }      // stop first (conservative)
      if (b.high >= sig.target) { exitPx = sig.target; reason = 'TARGET'; break; }
    }
    if (!exitPx) { k = Math.min(k, ttfAll.length - 1); exitPx = ttfAll[k].close; }
    const fees = roundTripCost(args.instrument.assetClass, sig.qty, entryPx, exitPx);
    const pnl = notionalPaise(sig.qty, exitPx - entryPx) - fees;
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, ((equity - peak) / peak) * 100);
    trades.push({ symbol: args.instrument.symbol, entryTs: ttfAll[entered].ts, exitTs: ttfAll[k]?.ts ?? 0, entry: entryPx, exit: exitPx, qty: sig.qty, pnlPaise: pnl, feesPaise: fees, reason });
    i = k; // one position at a time
  }
  const wins = trades.filter((t) => t.pnlPaise > 0);
  const gw = wins.reduce((a, t) => a + t.pnlPaise, 0), gl = -trades.filter((t) => t.pnlPaise <= 0).reduce((a, t) => a + t.pnlPaise, 0);
  return {
    trades, signalsSeen: seen, rejectedByReason: rejected,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    expectancyPaise: trades.length ? Math.round((gw - gl) / trades.length) : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    netPnlPaise: equity - start, feesPaise: trades.reduce((a, t) => a + t.feesPaise, 0),
    maxDrawdownPct: Math.round(maxDd * 100) / 100, finalEquityPaise: equity, startEquityPaise: start,
    caveats: [
      'Backtests overstate real results: no queue position, partial fills, or broker downtime are modelled.',
      'Fees are estimates from the configurable fee model.',
      `Sample size ${trades.length} trades — fewer than 30 is statistically meaningless.`,
      'Sector/index territory is assumed BUYERS in backtests; live trading requires real sector data.',
    ],
  };
}
