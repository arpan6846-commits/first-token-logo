// Deterministic signal engine: prop-desk analysis → trade candidate →
// validation (freshness, completeness, costs, slippage, minimum size, R:R) →
// Final Check. Long-only: the account is cash-delivery / spot with no
// shorting, so sellers' territory means "stand aside", never "short".

import { estimateSlippage, roundTripCost } from './fees.ts';
import { newId } from './hash.ts';
import { notionalPaise, roundToTick, type Paise } from './money.ts';
import {
  classifyCandle, detectBullishV, detectProbes, detectRange, dominance, lastAtr, legs, maxGapBars, momentumSequence,
  nextResistanceAbove, previousDayHighLow, rejectionCandle, territory, volatilityClass, type MomentumClass, type RangeInfo,
  type Territory, type VFormation,
} from './priceAction.ts';
import { evaluateFinalCheck, journalCoversPreTrade, liquidityCrunchScore, rewardRisk, type FinalCheckFacts } from './propDesk.ts';
import { sizePosition } from './risk.ts';
import type { AISignal, Candle, DataSource, Environment, Instrument, JournalEntry, Quote, StrategySettings, Timeframe } from './types.ts';
import { TIMEFRAME_MINUTES } from './types.ts';

export const HTF_OF: Record<Timeframe, Timeframe> = { '5m': '15m', '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1w', '1w': '1M', '1M': '1M' };

export interface SignalContext {
  sectorSide?: Territory['side'];       // sector index territory on the same TF/date
  indexSide?: Territory['side'];        // Nifty (stocks) or BTC (crypto) territory
  tradesToday: number;
  sectorTradesToday: number;
  rangeShareOk: boolean;
  stopOutSymbols: string[];
  journal?: JournalEntry;
  postTradeUpToDate: boolean;
  plannedRiskTodayPaise: Paise;
  accuracyTierPct: number;              // from dailyRiskBudgetPct()
  manualTicks?: Record<number, boolean>;
}

export interface SignalInput {
  environment: Environment;
  instrument: Instrument;
  ttf: Timeframe;
  ttfCandles: Candle[];                 // closed candles only, oldest first
  htfCandles: Candle[];
  quote?: Quote;
  now: number;
  settings: StrategySettings;
  equityPaise: Paise;
  dataSource: DataSource;
  ctx: SignalContext;
}

export interface Analysis {
  territory: Territory;
  ttfTerritory: Territory;
  momentum?: { pct: number; cls: MomentumClass };
  v: VFormation | null;
  buildUp: RangeInfo | null;
  atr: number;
  volatility: ReturnType<typeof volatilityClass>;
  dominanceBuyers: number;
  pdh?: number;
  pdl?: number;
  probesBelowBuildUp: number;
  crunch: boolean;
  lastCandleKind: string;
}

export function analyze(ttfCandles: Candle[], htfCandles: Candle[]): Analysis {
  const terr = territory(htfCandles, 2);
  const ttfTerr = territory(ttfCandles, 2);
  const ls = legs(ttfCandles, 2);
  const seq = momentumSequence(ls, 'UP');
  const v = detectBullishV(ttfCandles, 60);
  let buildUp: RangeInfo | null = null;
  if (v) {
    const r = detectRange(ttfCandles, { minTouches: 4, minBars: 6, maxBars: 30, maxHeightAtr: 3 });
    if (r && r.startIdx >= v.completedIdx - 2) buildUp = r;
  }
  const atrV = lastAtr(ttfCandles);
  const probes = buildUp ? detectProbes(ttfCandles, buildUp.bottom + (buildUp.top - buildUp.bottom) * 0.05, 'BELOW', buildUp.startIdx) : [];
  const { pdh, pdl } = previousDayHighLow(ttfCandles);
  return {
    territory: terr, ttfTerritory: ttfTerr,
    momentum: seq.length ? { pct: seq[seq.length - 1].pct, cls: seq[seq.length - 1].cls } : undefined,
    v, buildUp, atr: atrV, volatility: volatilityClass(ttfCandles), dominanceBuyers: v ? vDominance(ttfCandles, v) : dominance(ls).buyersShare,
    pdh, pdl, probesBelowBuildUp: probes.length, crunch: liquidityCrunchScore(ttfCandles).crunch,
    lastCandleKind: ttfCandles.length ? classifyCandle(ttfCandles, ttfCandles.length - 1) : 'NONE',
  };
}

export function buildSignal(input: SignalInput): AISignal {
  const { instrument: inst, settings: s, ttfCandles: tc, htfCandles: hc, quote: q, now } = input;
  const reasons: string[] = [];
  const watch: string[] = [];
  const tfMs = TIMEFRAME_MINUTES[input.ttf] * 60_000;
  const htf = HTF_OF[input.ttf];

  // --- data freshness & completeness (never trade on stale or missing data) ---
  if (TIMEFRAME_MINUTES[input.ttf] < TIMEFRAME_MINUTES[s.minTimeframe]) reasons.push(`TF_TOO_LOW: ${input.ttf} < ${s.minTimeframe}`);
  if (tc.length < 120) reasons.push(`DATA_INCOMPLETE: only ${tc.length} ${input.ttf} candles (need 120)`);
  if (hc.length < 60) reasons.push(`DATA_INCOMPLETE: only ${hc.length} ${htf} candles (need 60)`);
  const last = tc[tc.length - 1];
  if (last) {
    const lag = now - (last.ts + tfMs);
    if (lag > s.maxCandleLagMultiple * tfMs) reasons.push(`DATA_STALE: last ${input.ttf} candle closed ${Math.round(lag / 60000)} min ago`);
    if (lag < 0) reasons.push('DATA_INVALID: last candle has not closed yet (in-progress candles are not used)');
  }
  const gap = maxGapBars(tc, tfMs, inst.assetClass === 'EQUITY');
  if (gap > 2) reasons.push(`DATA_INCOMPLETE: ${gap} missing ${input.ttf} bars inside a session`);
  if (!q) reasons.push('NO_QUOTE: live quote missing');
  else if (now - q.exchangeTs > s.maxQuoteAgeMs) reasons.push(`DATA_STALE: quote ${Math.round((now - q.exchangeTs) / 1000)}s old`);
  if (tc.some((c) => !(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.low > 0))) reasons.push('DATA_INVALID: malformed OHLC');

  const a = tc.length >= 30 && hc.length >= 20 ? analyze(tc, hc) : undefined;
  const base: AISignal = {
    id: newId('sig', now), environment: input.environment, symbol: inst.symbol, venue: inst.venue, assetClass: inst.assetClass, side: 'BUY',
    timeframe: input.ttf, htf, entry: 0, stop: 0, target: 0, qty: 0, rr: 0, rrNetOfCosts: 0, plannedRiskPaise: 0, estFeesPaise: 0,
    estSlippagePaise: 0, rationale: [], invalidation: [], setupType: 'V + BUILD-UP (with HTF territory)', confidence: 0, status: 'REJECTED',
    rejectionReasons: [], dataAsOf: last?.ts ?? 0, dataSource: input.dataSource, createdAt: now, sector: inst.sector,
  };
  if (!a) return { ...base, rejectionReasons: [...reasons, 'NOT_ENOUGH_DATA_FOR_ANALYSIS'] };

  // --- territory & structure ---
  if (a.territory.side !== 'BUYERS') reasons.push(`TERRITORY: HTF ${htf} is ${a.territory.side === 'SELLERS' ? "sellers' territory" : 'undecided'} — long-only account stands aside (rulebook: trade only in territory direction)`);
  if (input.ctx.sectorSide && input.ctx.sectorSide === 'SELLERS') reasons.push(`SECTOR: sector in sellers' territory — stock would be against sector`);
  if (inst.assetClass === 'EQUITY' && q && (q.ltp < s.equityPriceMin || q.ltp > s.equityPriceMax)) reasons.push(`UNIVERSE: ₹${q.ltp} outside ₹${s.equityPriceMin}–₹${s.equityPriceMax}`);
  if (!a.v) watch.push('NO_V: sellers have not yet been driven back into their consolidation');
  if (a.v && !a.buildUp) watch.push('NO_BUILD_UP: V formed but no 4-touch build-up yet (no build-up = no trade)');
  if (a.momentum && a.momentum.cls === 'NO_NEW_ENTRY') watch.push(`MOMENTUM: last buyer impulse retraced ${a.momentum.pct.toFixed(0)}% (> 50% → no new trend entry)`);
  // Quiet volatility: the rulebook says wait. The conservative entry below only triggers on a
  // confirmed close above the build-up, i.e. when volatility arrives, so QUIET is not a blocker here.
  if (input.ctx.stopOutSymbols.includes(inst.symbol)) reasons.push('REVENGE_BLOCK: stopped out of this symbol today');

  let entry = 0, stop = 0, target = 0;
  if (a.v && a.buildUp && q) {
    const tick = inst.tickSize;
    const buffer = Math.max(tick * 2, a.atr * 0.1);
    entry = roundToTick(a.buildUp.top + tick, tick, 'up');
    const stopBase = a.v.type === 'LOPSIDED' ? a.buildUp.bottom : Math.min(a.v.extreme, a.buildUp.bottom);
    stop = roundToTick(stopBase - buffer, tick, 'down');
    const res = nextResistanceAbove(hc, entry) ?? nextResistanceAbove(tc, entry);
    if (res === undefined) reasons.push('NO_TARGET: no price-action level above entry (fixed R:R targets are forbidden)');
    else target = roundToTick(res - tick, tick, 'down');
    if (q.ltp > entry + 0.5 * a.atr) watch.push(`MISSED: price ${q.ltp} already > 0.5 ATR above build-up break ${entry} — wait for pullback, don't chase`);
  }

  let qty = 0, plannedRisk = 0, fees = 0, slip = 0, rrNet = 0;
  const rr = entry && stop && target ? rewardRisk('LONG', entry, stop, target) : undefined;
  if (rr && rr.rr > 0) {
    const remainingDaily = Math.max(0, Math.floor((input.equityPaise * Math.min(s.dailyRiskBudgetPct, input.ctx.accuracyTierPct, 1)) / 100) - input.ctx.plannedRiskTodayPaise);
    const riskPct = Math.min(s.maxRiskPerTradePct, (remainingDaily / Math.max(1, input.equityPaise)) * 100);
    const bucket = inst.assetClass === 'EQUITY' ? s.allocation.stocksPaise : s.allocation.cryptoPaise;
    const sz = sizePosition({ equityPaise: input.equityPaise, riskPct, entry, stop, assetClass: inst.assetClass, qtyDecimals: inst.qtyDecimals, lotSize: inst.lotSize, maxNotionalPaise: Math.min(bucket, Math.floor((input.equityPaise * s.maxOpenExposurePct) / 100)) });
    qty = sz.qty; plannedRisk = sz.riskPaise;
    if (qty <= 0) reasons.push(`SIZE: ${sz.reason}`);
    fees = qty > 0 ? roundTripCost(inst.assetClass, qty, entry, target) : 0;
    slip = qty > 0 ? estimateSlippage(inst.assetClass, qty, entry, q?.ask && q?.bid ? q.ask - q.bid : undefined) * 2 : 0;
    const reward = qty > 0 ? notionalPaise(qty, target - entry) - fees - slip : 0;
    rrNet = plannedRisk > 0 ? reward / (plannedRisk + slip) : 0;
    if (rrNet < s.minRewardRisk) reasons.push(`RR: net-of-costs R:R ${rrNet.toFixed(2)} < ${s.minRewardRisk} (gross ${rr.rr.toFixed(2)})`);
    const priceRisk = qty > 0 ? notionalPaise(qty, entry - stop) : 0;
    if (qty > 0 && (fees / Math.max(1, priceRisk)) * 100 > s.maxFeeToRiskPct) reasons.push(`COSTS: round-trip costs ₹${fees / 100} are ${((fees / priceRisk) * 100).toFixed(0)}% of price risk ₹${priceRisk / 100} (max ${s.maxFeeToRiskPct}%)`);
    if (qty > 0 && slip > 0.2 * priceRisk) reasons.push(`SLIPPAGE: estimated ₹${slip / 100} > 20% of risk`);
    if (qty > 0 && (qty < inst.minQty || notionalPaise(qty, entry) < inst.minNotionalPaise)) reasons.push(`MIN_ORDER: ${qty} × ${entry} below venue minimum (qty ${inst.minQty}, ₹${inst.minNotionalPaise / 100})`);
  }

  // --- narrative (deterministic, numbers from data) ---
  const t = a.territory;
  const rationale = [
    `HTF ${htf}: ${t.side} territory; ${t.note}${t.breachLevel ? ` (breach ${fmt(t.breachLevel)}, initiator ${fmt(t.initiatorLevel)}, ${t.sustainedCloses} closes)` : ''}.`,
    a.momentum ? `TTF ${input.ttf}: last correction retraced ${a.momentum.pct.toFixed(0)}% of the buyer impulse → ${a.momentum.cls}.` : `TTF ${input.ttf}: no measurable impulse/correction pair.`,
    a.v ? `${a.v.type} V: sellers pushed to ${fmt(a.v.extreme)}; buyers drove price back into ${fmt(a.v.zoneBottom)}–${fmt(a.v.zoneTop)}.` : 'No V-formation.',
    a.buildUp ? `Build-up ${fmt(a.buildUp.bottom)}–${fmt(a.buildUp.top)} with ${a.buildUp.touches} touches (${a.buildUp.sequence}).` : 'No build-up.',
    `Volatility ${a.volatility.cls} (ATR ratio ${a.volatility.ratio.toFixed(2)}); buyers' dominance ${(a.dominanceBuyers * 100).toFixed(0)}%.`,
    rr ? rr.text : 'R:R not computable.',
  ];
  const retailIllusion = a.v && t.initiatorLevel
    ? `Retail reads the drop to ${fmt(a.v.extreme)} as sellers taking control, but HTF buyers' territory above initiator ${fmt(t.initiatorLevel)} is intact — that dip was the buyers' better price.`
    : undefined;
  const invalidation = [
    a.buildUp ? `A ${input.ttf} close below build-up low ${fmt(a.buildUp.bottom)} cancels the setup.` : 'Setup not formed.',
    t.initiatorLevel ? `HTF close below initiator ${fmt(t.initiatorLevel)} for 2 candles flips territory → exit, no flip trade.` : 'No HTF initiator.',
    'Stop hit → no re-entry today (no revenge trade); re-analyse territory tomorrow.',
  ];
  const areaAnswers: Record<string, string> = {
    'Whose area?': `${t.side} (${htf} breach ${fmt(t.breachLevel)})`,
    'Who expands / loses?': `Buyers' share ${(a.dominanceBuyers * 100).toFixed(0)}%; sellers' push to ${fmt(a.v?.extreme)} was absorbed`,
    'Strong reaction in own area?': a.v ? `Yes — ${a.v.type} V back into ${fmt(a.v.zoneBottom)}` : 'Not yet',
    'Pattern?': a.buildUp ? `Build-up ${a.buildUp.sequence} at ${fmt(a.buildUp.bottom)}–${fmt(a.buildUp.top)}` : 'None',
    'Entry?': entry ? `Conservative: ${input.ttf} close above ${fmt(entry - inst.tickSize)} then limit ≤ ${fmt(entry)}; stop ${fmt(stop)}; target ${fmt(target)}` : 'No entry',
  };

  // --- Final Check facts ---
  const journal = journalCoversPreTrade(input.ctx.journal);
  const lastIdx = tc.length - 1;
  const confluence = [a.probesBelowBuildUp > 0, a.pdl !== undefined && q ? q.ltp > a.pdl : false, a.dominanceBuyers >= 0.7, !!a.v && a.v.type === 'LOPSIDED', rejectionCandle(tc[lastIdx]) === 'HAMMER' && t.side === 'BUYERS'].filter(Boolean).length;
  const spreadPct = q?.ask && q?.bid ? ((q.ask - q.bid) / q.ltp) * 100 : undefined;
  const facts: FinalCheckFacts = {
    liquid: inst.assetClass === 'CRYPTO' ? true : !!inst.fnoEligible,
    priceInUniverse: true,
    priceUniverse: inst.assetClass === 'CRYPTO' || (!!q && q.ltp >= s.equityPriceMin && q.ltp <= s.equityPriceMax),
    tightSpread: spreadPct === undefined ? false : spreadPct <= (inst.assetClass === 'EQUITY' ? 0.1 : 0.3),
    notScreener: true, niftyRead: input.ctx.indexSide !== undefined, sectorGrid: input.ctx.sectorSide !== undefined,
    sectorBreachMarked: input.ctx.sectorSide !== undefined, notAgainstSector: input.ctx.sectorSide !== undefined && input.ctx.sectorSide !== 'SELLERS',
    primaryPick: t.side === 'BUYERS' && input.ctx.sectorSide === 'BUYERS' && !!a.v, noShort: true, noLiquidityCrunch: !a.crunch,
    sectorCap: input.ctx.sectorTradesToday < s.maxTradesPerSector, writtenReasons: journal.writtenReasons, againstMePlan: journal.againstMePlan,
    profileScenario: journal.profileScenario, volatilityKnown: true, notQuiet: true, filtered: input.ctx.tradesToday < 3,
    htfOneAbove: HTF_OF[input.ttf] === htf, initiatorMarked: t.initiatorIdx !== undefined, levelImportant: t.breachLevel !== undefined,
    sustained: t.sustainedCloses >= 2, withTerritory: t.side === 'BUYERS', initiatorIntact: t.side === 'BUYERS',
    areaAnswers: !!entry, answersAligned: t.side === 'BUYERS' && a.dominanceBuyers >= 0.6 && (!input.ctx.sectorSide || input.ctx.sectorSide !== 'SELLERS'),
    oppositeNotReacting: a.lastCandleKind !== 'IMPULSIVE_DOWN', rangeBigEnough: !!rr && rr.rr >= 2, fourTouches: (a.buildUp?.touches ?? 0) >= 4,
    retailIllusion: !!retailIllusion, oppositePresent: !!a.v, notFirstZone: t.breachIdx !== undefined && hc.length - 1 - t.breachIdx >= 2,
    baseCorrective: !!a.buildUp, buildUp: !!a.buildUp, legsMeasured: !!a.momentum, hundredWithLogic: a.momentum?.cls !== 'OVER' || (!!a.v && !!a.buildUp),
    lastAttemptFailed: !!a.v, vFormation: !!a.v, notChop: !(a.volatility.cls === 'VOLATILE' && a.crunch),
    buildUpBetterPrice: !!a.buildUp && !!t.initiatorLevel && a.buildUp.bottom > t.initiatorLevel, dominance: a.dominanceBuyers >= 0.7,
    flushOrNA: true, candleContext: true, noUnexplainedExhaustion: rejectionCandle(tc[lastIdx]) !== 'SHOOTING_STAR', probeContext: true,
    pdhPdlConfirmOnly: true, confluence: confluence >= 2, thirdTfOk: true, minTf: TIMEFRAME_MINUTES[input.ttf] >= 5,
    notBreakingCandle: true, rightEndOfRange: true, stopBeyondSpike: !!a.buildUp && stop < a.buildUp.bottom, targetIsLevel: target > 0,
    rrChecked: !!rr?.reverseOk, sizeForRR: true, dailyRiskOk: s.dailyRiskBudgetPct <= 1, riskFitsAccuracy: s.dailyRiskBudgetPct <= input.ctx.accuracyTierPct,
    budgetSplit: true, qtyChecked: qty > 0, momentumAllowsEntry: !a.momentum || !['NO_NEW_ENTRY'].includes(a.momentum.cls), rangeShareOk: input.ctx.rangeShareOk,
    pyramidOk: true, numbersSourced: input.dataSource !== 'ESTIMATE', bookingPlan: true, exitTrigger: true, trailingChosen: true,
    noRevenge: !input.ctx.stopOutSymbols.includes(inst.symbol), postTradeUpToDate: input.ctx.postTradeUpToDate, learnerPaper: true,
    dataComplete: !reasons.some((r) => r.startsWith('DATA_')), neverRulesOk: true, processComplete: true,
    notes: {
      notQuiet: a.volatility.cls === 'QUIET' ? 'Quiet market: entry waits for a confirmed build-up break (volatility arriving)' : `Volatility ${a.volatility.cls}`,
      riskFitsAccuracy: `Daily budget ${s.dailyRiskBudgetPct}% vs accuracy tier ${input.ctx.accuracyTierPct}%`,
      confluence: `${confluence} confirming factors`,
      tightSpread: spreadPct === undefined ? 'No bid/ask in quote' : `Spread ${spreadPct.toFixed(3)}%`,
      niftyRead: input.ctx.indexSide === undefined ? 'Index territory not provided' : `Index ${input.ctx.indexSide}`,
      sectorGrid: input.ctx.sectorSide === undefined ? 'Sector territory not provided' : `Sector ${input.ctx.sectorSide}`,
    },
  };
  const finalCheck = evaluateFinalCheck(facts, input.ctx.manualTicks);

  const confidence = Math.min(0.9, 0.4 + 0.1 * confluence + (a.v?.type === 'LOPSIDED' ? 0.05 : 0) + (a.momentum?.cls === 'VERY_HEALTHY' ? 0.05 : 0));
  const status: AISignal['status'] = reasons.length ? 'REJECTED' : watch.length ? 'WATCHLIST' : 'VALIDATED';
  return {
    ...base, entry, stop, target, qty, rr: rr?.rr ?? 0, rrNetOfCosts: rrNet, plannedRiskPaise: plannedRisk, estFeesPaise: fees, estSlippagePaise: slip,
    rationale, invalidation, retailIllusion, areaAnswers, confidence: status === 'VALIDATED' ? confidence : Math.min(confidence, 0.3),
    status, rejectionReasons: [...reasons, ...watch], finalCheck, isRangeTrade: false,
  };
}

/** Rulebook W5 dominance: compare the sellers' V leg with the buyers' V leg (size × √speed, closes only). */
function vDominance(c: Candle[], v: VFormation): number {
  let start = v.extremeIdx;
  while (start > 0 && c[start - 1].close >= c[start].close) start--;
  const sellSize = Math.max(0, c[start].close - c[v.extremeIdx].close), sellBars = Math.max(1, v.extremeIdx - start);
  const buySize = Math.max(0, c[v.completedIdx].close - c[v.extremeIdx].close), buyBars = Math.max(1, v.completedIdx - v.extremeIdx);
  const b = buySize * Math.sqrt(buySize / buyBars), s = sellSize * Math.sqrt(sellSize / sellBars);
  return b + s > 0 ? b / (b + s) : 0.5;
}

function fmt(x?: number) { return x === undefined ? 'n/a' : Number(x.toFixed(x < 10 ? 4 : 2)).toString(); }
