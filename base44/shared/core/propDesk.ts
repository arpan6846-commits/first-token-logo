// Prop Trading Desk rulebook ("The Language of Price") — deterministic parts.
// Modes: A market analysis · B stock selection · C trade plan · D chart review ·
// E psychology · F post-trade review · G long–short spread.
// Anything that needs human judgement (calendar read, fundamentals, written
// reasons) is a MANUAL Final Check item that the owner must tick.

import type { FinalCheckResult, JournalEntry, Trend3 } from './types.ts';

// ---------------- R:R and quantity with reverse checks (template 3.5 step 22) ----------------
export interface RRResult { rr: number; risk: number; reward: number; reverseTarget: number; reverseOk: boolean; text: string }

export function rewardRisk(side: 'LONG' | 'SHORT', entry: number, stop: number, target: number): RRResult {
  const risk = side === 'LONG' ? entry - stop : stop - entry;
  const reward = side === 'LONG' ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return { rr: 0, risk, reward, reverseTarget: NaN, reverseOk: false, text: 'Invalid: stop/target on wrong side of entry' };
  const rr = reward / risk;
  const reverseTarget = side === 'LONG' ? entry + rr * risk : entry - rr * risk;
  const reverseOk = Math.abs(reverseTarget - target) < 1e-6 * Math.max(1, Math.abs(target));
  const text = side === 'LONG'
    ? `R:R = (${target} − ${entry}) ÷ (${entry} − ${stop}) = ${rr.toFixed(2)}; reverse: ${entry} + ${rr.toFixed(4)} × ${risk.toFixed(4)} = ${reverseTarget.toFixed(4)}`
    : `R:R = (${entry} − ${target}) ÷ (${stop} − ${entry}) = ${rr.toFixed(2)}; reverse: ${entry} − ${rr.toFixed(4)} × ${risk.toFixed(4)} = ${reverseTarget.toFixed(4)}`;
  return { rr, risk, reward, reverseTarget, reverseOk, text };
}

export function qtyFromRisk(tradeRiskRupees: number, entry: number, stop: number, decimals = 0): { qty: number; reverseRisk: number; reverseOk: boolean; text: string } {
  const per = Math.abs(entry - stop);
  if (!(per > 0)) return { qty: 0, reverseRisk: 0, reverseOk: false, text: 'Entry equals stop' };
  const f = 10 ** decimals;
  const qty = Math.floor((tradeRiskRupees / per) * f) / f;
  const reverseRisk = qty * per;
  return { qty, reverseRisk, reverseOk: reverseRisk <= tradeRiskRupees + 1e-9, text: `Qty = ₹${tradeRiskRupees} ÷ ${per.toFixed(4)} = ${qty}; reverse: ${qty} × ${per.toFixed(4)} = ₹${reverseRisk.toFixed(2)}` };
}

/** Rulebook 3.8: ~50% accuracy → 0.25%, ~70% → 0.5%, ~90% → 0.75–1%; between anchors use the lower; small capital lower; never > 1%. */
export function dailyRiskBudgetPct(accuracyPct: number | undefined, sampleSize: number, opts: { smallCapital?: boolean; minSample?: number } = {}): { pct: number; reason: string } {
  const minSample = opts.minSample ?? 30;
  if (accuracyPct === undefined || sampleSize < minSample) return { pct: 0.25, reason: `Only ${sampleSize} recorded trades (< ${minSample}) — using the lowest tier 0.25%` };
  let pct = accuracyPct >= 90 ? 0.75 : accuracyPct >= 70 ? 0.5 : accuracyPct >= 50 ? 0.25 : 0.25;
  if (opts.smallCapital && pct > 0.25) pct = Math.max(0.25, pct - 0.25);
  return { pct: Math.min(pct, 1), reason: `Accuracy ${accuracyPct.toFixed(0)}% over ${sampleSize} trades → ${pct}%${opts.smallCapital ? ' (reduced for small capital)' : ''}` };
}

/** Split the daily budget across planned trades; lower R:R gets lower size (e.g. 60/40). */
export function splitDailyBudget(budgetRupees: number, trades: { id: string; rr: number }[]): Record<string, number> {
  const w = trades.map((t) => Math.max(0.1, t.rr));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(trades.map((t, i) => [t.id, Math.floor((budgetRupees * w[i]) / total * 100) / 100]));
}

/** Inside bar: trade mother-candle direction; target 10–20% of mother range; stop = other extreme. */
export function insideBarPlan(mother: { high: number; low: number; bullish: boolean }, clearPath: boolean) {
  const range = mother.high - mother.low;
  const pctT = clearPath ? 0.2 : 0.1;
  return mother.bullish
    ? { entry: mother.high, stop: mother.low, target: mother.high + range * pctT }
    : { entry: mother.low, stop: mother.high, target: mother.low - range * pctT };
}

/** Pyramiding: impulsive candles only, each add smaller (100 → 40 → 30 → 20 → 10). */
export function pyramidSchedule(baseQty: number, adds = 4): number[] {
  const ratios = [1, 0.4, 0.3, 0.2, 0.1];
  return ratios.slice(0, adds + 1).map((r) => Math.floor(baseQty * r));
}

// ---------------- Stock selection (workflow 3.2) ----------------
export interface UniverseCheck { ok: boolean; reasons: string[] }
export function universeFilter(x: { price: number; fnoEligible?: boolean; liquid?: boolean; fellWithinMonthForMarketReasons?: boolean; veryLiquidLargeCap?: boolean }, min = 100, max = 4000): UniverseCheck {
  const reasons: string[] = [];
  if (x.price < min && !x.fellWithinMonthForMarketReasons) reasons.push(`Price ₹${x.price} < ₹${min} (exception only if it fell within ~1 month for market/sector reasons)`);
  if (x.price > max && !x.veryLiquidLargeCap) reasons.push(`Price ₹${x.price} > ₹${max} (only very liquid names with experience)`);
  if (!x.fnoEligible && !x.liquid) reasons.push('Not Nifty 200 F&O and not a liquid chart');
  return { ok: reasons.length === 0, reasons };
}

export type StockScore = 'PRIMARY' | 'OBSERVE' | 'REJECT';
/** B / M / BE scoring: against sector or range-bound → reject; over-extended → observe; aligned + logic or V → primary. */
export function scoreStock(x: { sectorSide: 'BUYERS' | 'SELLERS' | 'NONE'; stockSide: 'BUYERS' | 'SELLERS' | 'NONE'; rangeBound: boolean; overExtended: boolean; hasLogicOrV: boolean }): { score: StockScore; reason: string } {
  if (x.rangeBound) return { score: 'REJECT', reason: 'Range-bound stock' };
  if (x.sectorSide !== 'NONE' && x.stockSide !== x.sectorSide) return { score: 'REJECT', reason: `Stock ${x.stockSide} against sector ${x.sectorSide}` };
  if (x.overExtended) return { score: 'OBSERVE', reason: 'Over-extended — observe, wait for better price' };
  if (x.hasLogicOrV && x.stockSide === x.sectorSide) return { score: 'PRIMARY', reason: 'Aligned with sector and logic/V present' };
  return { score: 'OBSERVE', reason: 'Aligned but no logic/V yet' };
}

/** Weekly tendency (not absolute): Metal & Auto with Nifty; FMCG with Nifty but weaker; IT & Pharma often opposite. */
export const SECTOR_TENDENCY: Record<string, 'WITH_NIFTY' | 'WITH_NIFTY_WEAKER' | 'OFTEN_OPPOSITE'> = {
  METAL: 'WITH_NIFTY', AUTO: 'WITH_NIFTY', FMCG: 'WITH_NIFTY_WEAKER', IT: 'OFTEN_OPPOSITE', PHARMA: 'OFTEN_OPPOSITE',
};

/** Liquidity-crunch heuristic: many wicks / long corrective candles / sudden reversals. */
export function liquidityCrunchScore(c: { open: number; high: number; low: number; close: number }[]): { score: number; crunch: boolean } {
  if (c.length < 10) return { score: 0, crunch: false };
  const recent = c.slice(-20);
  const wickRatio = recent.reduce((s, x) => { const r = x.high - x.low; return s + (r > 0 ? 1 - Math.abs(x.close - x.open) / r : 0); }, 0) / recent.length;
  let flips = 0;
  for (let i = 1; i < recent.length; i++) if (Math.sign(recent[i].close - recent[i].open) !== Math.sign(recent[i - 1].close - recent[i - 1].open)) flips++;
  const score = wickRatio * 0.6 + (flips / recent.length) * 0.4;
  return { score, crunch: score > 0.62 };
}

// ---------------- Long–short spread (mode G) ----------------
export interface SpreadPoint { date: string; longAdjClose: number; shortAdjClose: number; spread: number }
export function spreadSeries(longC: { date: string; adjClose: number }[], shortC: { date: string; adjClose: number }[]): SpreadPoint[] {
  const s = new Map(shortC.map((x) => [x.date, x.adjClose]));
  return longC.filter((x) => s.has(x.date) && s.get(x.date)! > 0).map((x) => ({ date: x.date, longAdjClose: x.adjClose, shortAdjClose: s.get(x.date)!, spread: x.adjClose / s.get(x.date)! }));
}
export function spreadPeRule(longPe: number, shortPe: number, sectorPe: number): { ok: boolean; reason: string } {
  const ok = longPe > sectorPe && shortPe < sectorPe;
  return { ok, reason: ok ? 'Long P/E above sector, short P/E below sector (course rule, not textbook low-P/E-buy)' : `Rule needs long P/E (${longPe}) > sector (${sectorPe}) and short P/E (${shortPe}) < sector` };
}
export function spreadReviewDue(lastReviewIso: string, nowIso: string): boolean {
  return Date.parse(nowIso) - Date.parse(lastReviewIso) >= 14 * 86_400_000;
}

// ---------------- Psychology & journal (modes E, F) ----------------
export function profileScenario(n: Trend3, s: Trend3, st: Trend3): string {
  if (n === 'UP' && s === 'CONSOLIDATION' && st === 'DOWN') return 'Weak downside expected — use a trailing stop (SBI-type profile)';
  if (n === 'UP' && s === 'CONSOLIDATION' && st === 'UP') return 'Selling inside the stock is a buying opportunity (HUL-type profile)';
  if (n === s && s === st) return `Full alignment ${n} — highest-quality context`;
  return `Mixed context (Nifty ${n}, sector ${s}, stock ${st}) — reduce size or wait`;
}

export function traderStage(avgTradesPerDay: number): string {
  if (avgTradesPerDay >= 5) return 'Fresher (5–6 trades/day) — filter harder; fewer, better trades';
  if (avgTradesPerDay >= 3) return 'Senior (~3/day)';
  if (avgTradesPerDay > 1) return 'Experienced — allocate risk unequally by conviction';
  return 'Master — one high-conviction trade';
}

export function psychologyAlerts(x: { stopOutsToday: { symbol: string }[]; consecutiveLosses: number; tradesToday: number; missingPostTrade: number }): string[] {
  const a: string[] = [];
  if (x.stopOutsToday.length) a.push(`Stop hit today in ${[...new Set(x.stopOutsToday.map((s) => s.symbol))].join(', ')} — no flip/revenge unless territory changed (NEVER 11)`);
  if (x.consecutiveLosses >= 2) a.push(`${x.consecutiveLosses} losses in a row — pause, write the post-trade review before the next entry`);
  if (x.tradesToday >= 5) a.push('5+ trades today — fresher pattern; filter harder (Final Check B20)');
  if (x.missingPostTrade > 0) a.push(`${x.missingPostTrade} closed trade(s) without a written post-trade review (MUST 13)`);
  return a;
}

export const NEVER_RULES = [
  'Find trades via a screener', 'Trade a candle alone', 'Sell a shooting star inside a very strong uptrend', 'Short at range bottom / long at range top',
  'Short in a hurry while buyers still react in their area', 'Trade when the 5 answers are mixed', 'Buy "support" in a sellers\' area / sell "resistance" in a buyers\' area',
  'Enter right after a breakout', 'Trade 100% retracement without logic', 'Trade a V without build-up', 'Revenge-trade after SL when territory is unchanged',
  'Trade small ranges', 'Range trading > 20% of trades', 'Use a TF below 5m', 'Daily risk > 1%', 'Fixed 1:4 / 1:5 targets', 'Hunt counter-trend trades',
  'Buy a bearish-structure stock on a hammer', '> 2 (max 3) trades per sector', 'Short IT/Pharma only because Nifty is up', 'Use PDH/PDL as a standalone method',
  'Hunt V / 100% retracement as patterns', 'Mix later concepts into early learning exercises', 'Keep the profile in Excel (pen & paper)', 'Treat fundamentals as signals',
  'Use textbook P/E (low P/E = buy)',
];

// ---------------- Final Check (section 6) ----------------
type Def = [number, string, string, string?]; // id, block, text, auto fact key (absent = manual)

export const FINAL_CHECK: Def[] = [
  [1, 'A', 'Economic calendar checked'], [2, 'A', "Today's data impact considered"], [3, 'A', 'Nifty 200 F&O / liquid (CG26)', 'liquid'],
  [4, 'A', '₹100–4000 or valid exception', 'priceUniverse'], [5, 'A', 'Tight bid–ask (CG26)', 'tightSpread'], [6, 'A', 'Screener not the reason (CG1)', 'notScreener'],
  [7, 'A', 'Nifty read first', 'niftyRead'], [8, 'A', 'Sector grid same TF/date', 'sectorGrid'], [9, 'A', 'Sector breach marked', 'sectorBreachMarked'],
  [10, 'A', 'Stocks scored, against-sector rejected', 'notAgainstSector'], [11, 'A', 'Primary pick, not "looks strong"', 'primaryPick'],
  [12, 'A', 'Not shorting IT/Pharma only because Nifty up (CG19)', 'noShort'], [13, 'A', 'Liquidity checked', 'noLiquidityCrunch'], [14, 'A', '≤ 2–3 trades in sector', 'sectorCap'],
  [15, 'B', 'Written reasons (CG27)', 'writtenReasons'], [16, 'B', 'Against-me plan', 'againstMePlan'], [17, 'B', 'Profile scenario read', 'profileScenario'],
  [18, 'B', 'Volatility class + why', 'volatilityKnown'], [19, 'B', 'Waited if non-volatile', 'notQuiet'], [20, 'B', 'Trade filtered, not one of 5–6 (CG20)', 'filtered'],
  [21, 'C', 'HTF one above TTF', 'htfOneAbove'], [22, 'C', 'Nothing beyond HTF', 'htfOneAbove'], [23, 'C', 'Initiator marked', 'initiatorMarked'],
  [24, 'C', 'Level important', 'levelImportant'], [25, 'C', 'Break sustained 1–2 closes (CG7)', 'sustained'], [26, 'C', 'Trade in territory direction', 'withTerritory'],
  [27, 'C', 'No support-buy in sellers\' area (CG6)', 'withTerritory'], [28, 'C', 'Only substantive levels (CG8)', 'levelImportant'], [29, 'C', 'HTF initiator used', 'initiatorMarked'],
  [30, 'C', 'Retracement vs new initiator decided', 'initiatorIntact'], [31, 'C', '5 answers with levels (CG24)', 'areaAnswers'], [32, 'C', 'Answers not mixed', 'answersAligned'],
  [33, 'C', 'Opposite side not still reacting (CG5)', 'oppositeNotReacting'], [34, 'C', 'Zone flips only on structure (CG17)', 'sustained'], [35, 'C', 'Range big enough (CG25)', 'rangeBigEnough'],
  [36, 'C', '4 touches', 'fourTouches'],
  [37, 'D', 'Retail illusion named', 'retailIllusion'], [38, 'D', 'Opposite side present', 'oppositePresent'], [39, 'D', 'Not first zone after aggressive move (CG10)', 'notFirstZone'],
  [40, 'D', 'D/S chosen by logic (CG9)', 'notFirstZone'], [41, 'D', 'D/S legs impulsive, base corrective', 'baseCorrective'], [42, 'D', 'Build-up before breakout', 'buildUp'],
  [43, 'D', 'Legs measured (wicks ignored)', 'legsMeasured'], [44, 'D', '100% backed by logic (CG12)', 'hundredWithLogic'], [45, 'D', 'Last attempt failed', 'lastAttemptFailed'],
  [46, 'D', 'V type correct', 'vFormation'], [47, 'D', 'Not volatile chop (CG29)', 'notChop'], [48, 'D', 'Build-up exists (CG16)', 'buildUp'],
  [49, 'D', 'Build-up at dominant side\'s better price (CG22)', 'buildUpBetterPrice'], [50, 'D', 'Dominance 70/30', 'dominance'], [51, 'D', 'Phase vs reversal checked', 'initiatorIntact'],
  [52, 'D', 'Flush done', 'flushOrNA'], [53, 'D', 'Fundamental reason checked'], [54, 'D', 'Design matches sector', 'notAgainstSector'],
  [55, 'E', 'Candle via C/S/A (CG2)', 'candleContext'], [56, 'E', 'No counter candle inside strong trend', 'candleContext'], [57, 'E', 'Exhaustion candle where it shouldn\'t be → asked why, waited (CG13)', 'noUnexplainedExhaustion'],
  [58, 'E', 'Probe = confirmation', 'probeContext'], [59, 'E', 'Probe bounces compared', 'probeContext'], [60, 'E', 'PDH/PDL only confirms', 'pdhPdlConfirmOnly'],
  [61, 'E', '≥ 2–3 factors', 'confluence'], [62, 'E', 'Interpretation followed', 'answersAligned'], [63, 'E', '3rd TF only after correlation + 3 rules', 'thirdTfOk'], [64, 'E', 'No TF < 5m', 'minTf'],
  [65, 'F', 'Not breaking candle (CG11)', 'notBreakingCandle'], [66, 'F', 'Not wrong end of range (CG3)', 'rightEndOfRange'], [67, 'F', 'Stop beyond highest spike (CG4)', 'stopBeyondSpike'],
  [68, 'F', 'Stop matches table 3.8', 'stopBeyondSpike'], [69, 'F', 'Target is a price-action level', 'targetIsLevel'], [70, 'F', 'No fixed R:R target', 'targetIsLevel'],
  [71, 'F', 'R:R computed + reverse-checked', 'rrChecked'], [72, 'F', 'Size reduced for low R:R', 'sizeForRR'], [73, 'F', 'Daily risk ≤ 1%', 'dailyRiskOk'],
  [74, 'F', 'Risk % fits accuracy/capital', 'riskFitsAccuracy'], [75, 'F', 'Budget split', 'budgetSplit'], [76, 'F', 'Qty computed + reverse-checked', 'qtyChecked'],
  [77, 'F', '~50% → smaller size, > 50% no new entry', 'momentumAllowsEntry'], [78, 'F', 'Range trades ≤ 20% (CG15)', 'rangeShareOk'], [79, 'F', 'Pyramiding rules', 'pyramidOk'],
  [80, 'F', 'Inside-bar math', 'naOk'], [81, 'F', 'Counter-trend R:R ≥ 1:1', 'naOk'], [82, 'F', 'Every number re-read from source', 'numbersSourced'],
  [83, 'G', 'Booking plan', 'bookingPlan'], [84, 'G', 'Exit trigger', 'exitTrigger'], [85, 'G', 'Trend trading stops in range', 'exitTrigger'],
  [86, 'G', 'Stop/trailing chosen via sector', 'trailingChosen'], [87, 'G', 'No revenge after SL (CG14)', 'noRevenge'], [88, 'G', 'Counter-trend natural, at order area, HL→HH (CG30)', 'naOk'],
  [89, 'G', 'Wider stops in crunch', 'noLiquidityCrunch'], [90, 'G', 'Spread: P/E rule + spread stop + 2-week review (CG28)', 'naOk'],
  [91, 'H', 'Post-trade written', 'postTradeUpToDate'], [92, 'H', 'Profile updated'], [93, 'H', 'Stock kept after profit (CG18)', 'naOk'],
  [94, 'H', 'Learner → paper trade (CG23)', 'learnerPaper'], [95, 'H', 'Price interpreted, no pattern hunting (CG21)', 'answersAligned'],
  [96, 'I', 'Every number has a source', 'numbersSourced'], [97, 'I', 'Every rule matches this skill', 'naOk'], [98, 'I', 'Nothing invented; unknowns marked', 'dataComplete'],
  [99, 'I', 'None of the 26 NEVER rules broken', 'neverRulesOk'], [100, 'I', 'No process step skipped', 'processComplete'],
];

export type FinalCheckFacts = { [key: string]: boolean | Record<string, string> | undefined; notes?: Record<string, string> };

export function evaluateFinalCheck(facts: FinalCheckFacts, manualTicks: Record<number, boolean> = {}): FinalCheckResult {
  const items = FINAL_CHECK.map(([id, block, text, key]) => {
    if (!key) {
      const v = manualTicks[id];
      return { id, block, text, mode: 'manual' as const, pass: v === undefined ? null : v, note: v === undefined ? 'Owner must confirm' : 'Confirmed by owner' };
    }
    const raw = key === 'naOk' ? true : facts[key];
    const v = typeof raw === 'boolean' ? raw : undefined;
    return { id, block, text, mode: 'auto' as const, pass: v === undefined ? false : v, note: key === 'naOk' ? 'Not used in this setup' : facts.notes?.[key] ?? (v === undefined ? `Fact '${key}' not computed` : undefined) };
  });
  const failed = items.filter((i) => i.pass === false).map((i) => i.id);
  const pendingManual = items.filter((i) => i.pass === null).map((i) => i.id);
  // 'processComplete' (100) must reflect the others
  const i100 = items.find((i) => i.id === 100)!;
  if (failed.some((x) => x !== 100) || pendingManual.length) { i100.pass = false; i100.note = 'Other items failed or pending'; if (!failed.includes(100)) failed.push(100); }
  return { passed: failed.length === 0 && pendingManual.length === 0, items, failed, pendingManual };
}

export const MANUAL_FINAL_CHECK_IDS = FINAL_CHECK.filter((d) => !d[3]).map((d) => d[0]);

export function journalCoversPreTrade(j?: JournalEntry): { writtenReasons: boolean; againstMePlan: boolean; profileScenario: boolean } {
  return {
    writtenReasons: !!(j?.sectorWhy?.trim() && j.stockWhy?.trim() && j.positionWhy?.trim()),
    againstMePlan: !!j?.againstMePlan?.trim(),
    profileScenario: !!j?.profileScenario,
  };
}

export const DISCLAIMER_HI = 'Yeh course-rulebook par based analysis hai, financial advice nahi; final faisla aapka.';
