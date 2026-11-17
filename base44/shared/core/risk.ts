// Deterministic pre-trade risk engine. Every order passes through
// `evaluateOrder` immediately before submission. The AI layer cannot call
// around it, cannot change its inputs (settings are owner-only) and its output
// cannot be overridden: OrderManager refuses any order without an approval.
//
// NOTE: `settings.dailyTargetPct` is intentionally never read here. Position
// size and risk are never increased to chase the aspirational target.

import { estimateFees, roundTripCost } from './fees.ts';
import { notionalPaise, floorQty, type Paise } from './money.ts';
import type { EquityView, Position } from './portfolio.ts';
import { posKey } from './portfolio.ts';
import type {
  APIConnection, AssetClass, Environment, FinalCheckResult, Instrument, KillSwitchState, OrderType, Quote, Side,
  StrategySettings, Timeframe, TradeOrder, Venue,
} from './types.ts';
import { TERMINAL_STATUSES, TIMEFRAME_MINUTES } from './types.ts';

export interface OrderProposal {
  environment: Environment;
  venue: Venue;
  symbol: string;
  assetClass: AssetClass;
  side: Side;
  qty: number;
  orderType: OrderType;
  product: 'CNC' | 'SPOT';
  limitPrice?: number;
  triggerPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
  timeframe?: Timeframe;
  sector?: string;
  isRangeTrade?: boolean;
  idempotencyKey: string;
  signalId?: string;
  leverage?: number;
  /** Reduce-only protective stop exit of an existing position. The kill switch still allows these. */
  protectiveExit?: boolean;
}

export interface RiskContext {
  now: number;
  settings: StrategySettings;
  killSwitch: KillSwitchState;
  haltedUntilDate?: string;          // IST date until which new entries are halted
  todayIst: string;
  equity: EquityView;
  startOfDayEquityPaise: Paise;
  startOfWeekEquityPaise: Paise;
  contributionsTodayPaise: Paise;
  contributionsWeekPaise: Paise;
  instrument?: Instrument;
  quote?: Quote;
  lastCandleTs?: number;             // open time of last closed candle used by the signal
  connection?: APIConnection;
  venueAvailable: boolean;
  reconciliation?: { ts: number; ok: boolean };
  marketOpen: boolean;
  positions: Map<string, Position>;
  orders: TradeOrder[];              // all orders in this environment (for today's caps, open orders)
  stopOutsToday: { symbol: string; ts: number }[];
  consecutiveLossesToday: number;
  finalCheck?: FinalCheckResult;
  requireFinalCheck: boolean;
  maxOpenOrders?: number;
}

export interface RiskCheck { code: string; pass: boolean; severity: 'BLOCK' | 'WARN' | 'INFO'; message: string }
export interface RiskDecision {
  approved: boolean;
  checks: RiskCheck[];
  failures: RiskCheck[];
  plannedRiskPaise: Paise;
  orderValuePaise: Paise;
  estFeesRoundTripPaise: Paise;
  netRewardRisk?: number;
}

const istDateOf = (ts: number) => new Date(ts + 330 * 60_000).toISOString().slice(0, 10);

export function evaluateOrder(p: OrderProposal, ctx: RiskContext): RiskDecision {
  const s = ctx.settings;
  const checks: RiskCheck[] = [];
  const add = (code: string, pass: boolean, message: string, severity: RiskCheck['severity'] = 'BLOCK') => checks.push({ code, pass, severity, message });
  const isEntry = p.side === 'BUY';
  const price = p.limitPrice ?? ctx.quote?.ask ?? ctx.quote?.ltp ?? NaN;
  const orderValue = Number.isFinite(price) ? notionalPaise(p.qty, price) : 0;
  const equity = ctx.equity.netEquityPaise;

  // 1. Global safety gates
  const protective = p.side === 'SELL' && !!p.protectiveExit;
  add('KILL_SWITCH', !ctx.killSwitch.active || protective, ctx.killSwitch.active ? (protective ? 'Kill switch active — allowing reduce-only protective stop exit' : `Emergency kill switch active: ${ctx.killSwitch.reason ?? 'no reason given'}`) : 'Kill switch off');
  if (p.environment === 'production') {
    add('PHASE_GATE', s.phase === 5, s.phase === 5 ? 'Phase 5 live trading approved' : `Live orders require Phase 5 (current phase ${s.phase})`);
    add('LIVE_ENABLED', s.liveTradingEnabled, s.liveTradingEnabled ? 'Live trading enabled by owner' : 'Live trading disabled in settings');
    add('ENV_SETTINGS_MATCH', s.environment === 'production', 'Settings belong to production book');
  } else {
    add('ENV_SETTINGS_MATCH', s.environment === p.environment, `Settings environment ${s.environment} vs order ${p.environment}`);
  }
  add('NO_LEVERAGE', (p.leverage ?? 1) === 1 && (p.product === 'CNC' || p.product === 'SPOT'), 'Only cash-delivery (CNC) equity and crypto spot; leverage, margin, futures and MIS are disabled');
  add('PRODUCT_MATCH', (p.assetClass === 'EQUITY' && p.product === 'CNC') || (p.assetClass === 'CRYPTO' && p.product === 'SPOT'), 'Product matches asset class');

  // 2. Instrument and order validity
  const inst = ctx.instrument;
  add('INSTRUMENT_KNOWN', !!inst && inst.symbol === p.symbol && inst.venue === p.venue, inst ? 'Instrument metadata loaded' : 'Instrument metadata missing — cannot validate lot/tick/min size');
  add('QTY_POSITIVE', Number.isFinite(p.qty) && p.qty > 0, `Quantity ${p.qty}`);
  if (inst) {
    add('QTY_PRECISION', floorQty(p.qty, inst.qtyDecimals) === p.qty, `Quantity must have ≤ ${inst.qtyDecimals} decimals`);
    add('LOT_SIZE', inst.lotSize <= 1 || Math.abs(p.qty / inst.lotSize - Math.round(p.qty / inst.lotSize)) < 1e-9, `Lot size ${inst.lotSize}`);
    add('MIN_QTY', p.qty >= inst.minQty, `Minimum quantity ${inst.minQty}`);
    add('MIN_NOTIONAL', orderValue >= inst.minNotionalPaise, `Order value ₹${orderValue / 100} vs venue minimum ₹${inst.minNotionalPaise / 100}`);
    if (p.limitPrice !== undefined) {
      const ticks = p.limitPrice / inst.tickSize;
      add('TICK_SIZE', Math.abs(ticks - Math.round(ticks)) < 1e-6, `Limit price must be a multiple of tick ${inst.tickSize}`);
    }
  }
  add('PRICE_KNOWN', Number.isFinite(price) && price > 0, Number.isFinite(price) ? `Reference price ${price}` : 'No reference price — refusing to trade without market data');
  if (p.orderType === 'MARKET' && p.assetClass === 'EQUITY') add('MARKET_ORDER_WARN', true, 'Market order: slippage risk; prefer LIMIT', 'WARN');

  // 3. Data freshness & connectivity
  const q = ctx.quote;
  const quoteAge = q ? ctx.now - q.exchangeTs : Infinity;
  add('QUOTE_PRESENT', !!q, q ? `Quote from ${q.source}` : 'No quote — missing market data blocks execution');
  add('QUOTE_FRESH', quoteAge <= s.maxQuoteAgeMs, `Quote age ${Number.isFinite(quoteAge) ? Math.round(quoteAge / 1000) + 's' : '∞'} (max ${s.maxQuoteAgeMs / 1000}s)`);
  if (p.environment === 'production') add('QUOTE_SOURCE_LIVE', q?.source === 'LIVE' || q?.source === 'BROKER', `Production orders need live broker data, got ${q?.source ?? 'none'}`);
  if (p.timeframe) {
    const tfMs = TIMEFRAME_MINUTES[p.timeframe] * 60_000;
    const lag = ctx.lastCandleTs === undefined ? Infinity : ctx.now - (ctx.lastCandleTs + tfMs);
    add('CANDLES_FRESH', lag <= s.maxCandleLagMultiple * tfMs, `Last ${p.timeframe} candle closed ${Number.isFinite(lag) ? Math.round(lag / 60000) + ' min' : 'never'} ago`);
    add('MIN_TIMEFRAME', TIMEFRAME_MINUTES[p.timeframe] >= TIMEFRAME_MINUTES[s.minTimeframe], `Timeframe ${p.timeframe} vs minimum ${s.minTimeframe} (prop desk: never below 5m)`);
  }
  if (p.environment !== 'simulation') {
    const c = ctx.connection;
    const sessionOk = !!c && ['AUTHENTICATED', 'TESTED_READ_ONLY', 'TESTED_ORDERS_SANDBOX'].includes(c.status) && (c.sessionExpiresAt === undefined || c.sessionExpiresAt > ctx.now);
    add('API_SESSION', sessionOk, sessionOk ? 'API session valid' : `API session not valid (${c?.status ?? 'no connection'}${c?.sessionExpiresAt && c.sessionExpiresAt <= ctx.now ? ', expired' : ''})`);
    add('TRADE_PERMISSION', !!c?.permissions.trade || p.environment === 'paper', 'Trade permission granted on API key');
    add('WITHDRAW_DISABLED', !c?.permissions.withdraw, c?.permissions.withdraw ? 'API key has WITHDRAW permission — revoke it before trading' : 'Withdrawal permission disabled');
  }
  add('VENUE_AVAILABLE', ctx.venueAvailable, ctx.venueAvailable ? 'Venue reachable' : 'Broker/exchange unavailable');
  if (p.environment === 'production') {
    const r = ctx.reconciliation;
    const fresh = !!r && r.ok && ctx.now - r.ts <= s.maxReconciliationAgeMs;
    add('BALANCES_RECONCILED', fresh, fresh ? 'Balances reconciled with venue' : r ? (r.ok ? 'Reconciliation too old' : 'Last reconciliation found mismatches') : 'Balances never reconciled');
  }
  if (p.assetClass === 'EQUITY') add('MARKET_HOURS', ctx.marketOpen, ctx.marketOpen ? 'NSE open' : 'NSE closed');

  // 4. Open orders / no shorting
  const live = ctx.orders.filter((o) => !TERMINAL_STATUSES.includes(o.status) && o.status !== 'PROPOSED');
  add('MAX_OPEN_ORDERS', live.length < (ctx.maxOpenOrders ?? 10), `${live.length} open orders`);
  const dupe = ctx.orders.find((o) => o.idempotencyKey === p.idempotencyKey && o.environment === p.environment);
  add('IDEMPOTENCY', !dupe, dupe ? `Duplicate idempotency key — existing order ${dupe.id}` : 'New idempotency key');
  if (!isEntry) {
    const pos = ctx.positions.get(posKey(p.venue, p.symbol));
    const pendingSells = live.filter((o) => o.side === 'SELL' && o.symbol === p.symbol && o.venue === p.venue).reduce((a, o) => a + (o.qty - o.filledQty), 0);
    const avail = (pos?.qty ?? 0) - pendingSells;
    add('NO_SHORT_SELLING', p.qty <= avail + 1e-9, `Sell ${p.qty} vs available holding ${avail}`);
  }

  // 5. Entry-only risk rules
  let plannedRisk = 0, rtFees = 0, netRR: number | undefined;
  if (isEntry) {
    const today = ctx.todayIst;
    add('HALT_LATCH', !(ctx.haltedUntilDate && ctx.haltedUntilDate >= today), ctx.haltedUntilDate ? `New entries halted until ${ctx.haltedUntilDate} after a loss-limit breach` : 'No halt');
    const dayPnl = equity - ctx.startOfDayEquityPaise - ctx.contributionsTodayPaise;
    const weekPnl = equity - ctx.startOfWeekEquityPaise - ctx.contributionsWeekPaise;
    const dayLimit = -Math.round((ctx.startOfDayEquityPaise * s.dailyLossStopPct) / 100);
    const weekLimit = -Math.round((ctx.startOfWeekEquityPaise * s.weeklyLossStopPct) / 100);
    add('DAILY_LOSS_STOP', dayPnl > dayLimit, `Day P&L ₹${dayPnl / 100} vs stop ₹${dayLimit / 100}`);
    add('WEEKLY_LOSS_STOP', weekPnl > weekLimit, `Week P&L ₹${weekPnl / 100} vs stop ₹${weekLimit / 100}`);

    const stop = p.stopPrice;
    const stopOk = stop !== undefined && Number.isFinite(stop) && stop > 0 && Number.isFinite(price) && stop < price;
    add('STOP_DEFINED', stopOk, stopOk ? `Stop ${stop} below entry ${price}` : 'Every entry needs a protective stop below entry');
    if (stopOk && Number.isFinite(price)) {
      rtFees = roundTripCost(p.assetClass, p.qty, price, stop!);
      plannedRisk = notionalPaise(p.qty, price - stop!) + rtFees;
      const maxRisk = Math.floor((equity * s.maxRiskPerTradePct) / 100);
      add('RISK_PER_TRADE', plannedRisk <= maxRisk, `Planned risk ₹${plannedRisk / 100} (incl. costs) vs max ₹${maxRisk / 100} (${s.maxRiskPerTradePct}% of equity)`);
      const usedToday = ctx.orders
        .filter((o) => o.side === 'BUY' && istDateOf(o.createdAt) === today && !['RISK_REJECTED', 'REJECTED'].includes(o.status) && !(o.status === 'CANCELLED' && o.filledQty === 0))
        .reduce((a, o) => a + (o.plannedRiskPaise ?? 0), 0);
      const budget = Math.floor((equity * Math.min(s.dailyRiskBudgetPct, 1)) / 100);
      add('DAILY_RISK_BUDGET', usedToday + plannedRisk <= budget, `Today's planned risk ₹${(usedToday + plannedRisk) / 100} vs daily budget ₹${budget / 100} (${s.dailyRiskBudgetPct}%)`);
      const minFeeCheck = (rtFees / Math.max(1, plannedRisk - rtFees)) * 100;
      add('COSTS_VS_RISK', minFeeCheck <= s.maxFeeToRiskPct, `Round-trip costs ₹${rtFees / 100} = ${minFeeCheck.toFixed(1)}% of price risk (max ${s.maxFeeToRiskPct}%)`);
      if (p.targetPrice !== undefined) {
        const reward = notionalPaise(p.qty, p.targetPrice - price) - roundTripCost(p.assetClass, p.qty, price, p.targetPrice);
        netRR = reward / plannedRisk;
        add('REWARD_RISK', netRR >= s.minRewardRisk, `Net-of-costs R:R ${netRR.toFixed(2)} vs minimum ${s.minRewardRisk}`);
      } else add('REWARD_RISK', false, 'Target missing — R:R cannot be computed');
    }
    const buyFees = Number.isFinite(price) ? estimateFees(p.assetClass, 'BUY', p.qty, price).totalPaise : 0;
    const venueCash = ctx.equity.cashByVenue[p.venue] ?? 0;
    const reserved = live.filter((o) => o.side === 'BUY' && o.venue === p.venue).reduce((a, o) => a + notionalPaise(o.qty - o.filledQty, o.limitPrice ?? o.avgFillPrice ?? 0), 0);
    add('CASH_AVAILABLE', orderValue + buyFees <= venueCash - reserved, `Needs ₹${(orderValue + buyFees) / 100}, free cash at ${p.venue} ₹${(venueCash - reserved) / 100} (no leverage)`);
    const exposure = ctx.equity.marketValuePaise + reserved + orderValue;
    const maxExp = Math.floor((equity * s.maxOpenExposurePct) / 100);
    add('MAX_EXPOSURE', exposure <= maxExp, `Exposure after order ₹${exposure / 100} vs max ₹${maxExp / 100} (${s.maxOpenExposurePct}% of equity)`);
    const bucket = p.assetClass === 'EQUITY' ? s.allocation.stocksPaise : s.allocation.cryptoPaise;
    const reinvestShare = ctx.equity.reinvestedPaise > 0 ? Math.round(ctx.equity.reinvestedPaise * (bucket / Math.max(1, s.allocation.stocksPaise + s.allocation.cryptoPaise))) : 0;
    const classExposure = ctx.equity.exposureByClass[p.assetClass] + orderValue;
    add('ALLOCATION_BUCKET', classExposure <= bucket + reinvestShare, `${p.assetClass} exposure ₹${classExposure / 100} vs bucket ₹${(bucket + reinvestShare) / 100}`);
    if (p.assetClass === 'EQUITY' && Number.isFinite(price)) {
      add('PRICE_UNIVERSE', price >= s.equityPriceMin && price <= s.equityPriceMax, `Price ₹${price} vs prop-desk universe ₹${s.equityPriceMin}–₹${s.equityPriceMax}`);
    }
    if (p.sector) {
      const sectorTrades = ctx.orders.filter((o) => o.side === 'BUY' && o.sector === p.sector && istDateOf(o.createdAt) === today && ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'SUBMITTING', 'APPROVED', 'AWAITING_OWNER'].includes(o.status)).length;
      add('SECTOR_CAP', sectorTrades < s.maxTradesPerSector, `${sectorTrades} trades today in ${p.sector} (max ${s.maxTradesPerSector})`);
    }
    if (p.isRangeTrade) {
      const entries = ctx.orders.filter((o) => o.side === 'BUY' && o.filledQty > 0);
      const ranges = entries.filter((o) => o.isRangeTrade).length;
      const ratio = ((ranges + 1) / (entries.length + 1)) * 100;
      add('RANGE_TRADE_SHARE', ratio <= s.maxRangeTradePct || entries.length < 5, `Range trades would be ${ratio.toFixed(0)}% of trades (max ${s.maxRangeTradePct}%)`);
    }
    const revenge = ctx.stopOutsToday.find((x) => x.symbol === p.symbol);
    add('NO_REVENGE_TRADE', !revenge, revenge ? `Stopped out of ${p.symbol} today — re-entry blocked until territory is re-analysed tomorrow` : 'No stop-out in this symbol today');
    add('LOSS_STREAK_COOLDOWN', ctx.consecutiveLossesToday < s.consecutiveLossCooldown, `${ctx.consecutiveLossesToday} consecutive losses today (cooldown at ${s.consecutiveLossCooldown})`);
    if (ctx.requireFinalCheck) {
      const fc = ctx.finalCheck;
      add('FINAL_CHECK', !!fc && fc.passed, fc ? (fc.passed ? 'Prop-desk Final Check passed' : `Final Check failed: ${[...fc.failed, ...fc.pendingManual].slice(0, 8).join(', ')}`) : 'Final Check missing');
    }
  }

  const failures = checks.filter((c) => !c.pass && c.severity === 'BLOCK');
  return { approved: failures.length === 0, checks, failures, plannedRiskPaise: plannedRisk, orderValuePaise: orderValue, estFeesRoundTripPaise: rtFees, netRewardRisk: netRR };
}

/** Position size from planned risk: qty = riskBudget ÷ per-unit risk (incl. estimated costs). */
export function sizePosition(args: {
  equityPaise: Paise; riskPct: number; entry: number; stop: number; assetClass: AssetClass; qtyDecimals: number; lotSize: number; maxNotionalPaise: Paise;
}): { qty: number; riskPaise: Paise; reason: string } {
  const { equityPaise, riskPct, entry, stop, assetClass, qtyDecimals, lotSize, maxNotionalPaise } = args;
  if (!(entry > stop && stop > 0)) return { qty: 0, riskPaise: 0, reason: 'Stop must be below entry' };
  const budget = Math.floor((equityPaise * riskPct) / 100);
  let qty = floorQty(budget / 100 / (entry - stop), qtyDecimals);
  if (lotSize > 1) qty = Math.floor(qty / lotSize) * lotSize;
  const cap = floorQty(maxNotionalPaise / 100 / entry, qtyDecimals);
  qty = Math.min(qty, cap);
  // shrink until risk including costs fits the budget
  const step = qtyDecimals === 0 ? Math.max(1, lotSize) : 10 ** -qtyDecimals;
  let risk = qty > 0 ? notionalPaise(qty, entry - stop) + roundTripCost(assetClass, qty, entry, stop) : 0;
  let guard = 0;
  while (qty > 0 && risk > budget && guard++ < 100_000) {
    qty = floorQty(qty - step, qtyDecimals);
    risk = qty > 0 ? notionalPaise(qty, entry - stop) + roundTripCost(assetClass, qty, entry, stop) : 0;
  }
  return { qty: Math.max(0, qty), riskPaise: risk, reason: qty > 0 ? `Risk ₹${risk / 100} within budget ₹${budget / 100}` : `Budget ₹${budget / 100} too small for this stop distance after costs` };
}
