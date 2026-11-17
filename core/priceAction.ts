// Price-action primitives from the prop-desk rulebook ("The Language of
// Price"), turned into deterministic heuristics. They are approximations of a
// discretionary method: they must be validated by backtests and paper trading
// (Phase 3) before anyone trusts them with money.

import type { Candle } from './types.ts';

export const bodyHigh = (c: Candle) => Math.max(c.open, c.close);
export const bodyLow = (c: Candle) => Math.min(c.open, c.close);
export const body = (c: Candle) => Math.abs(c.close - c.open);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

export function atr(c: Candle[], n = 14): number[] {
  const tr = c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  const out: number[] = [];
  let a = tr[0] ?? 0;
  for (let i = 0; i < tr.length; i++) { a = i < n ? mean(tr.slice(0, i + 1)) : (a * (n - 1) + tr[i]) / n; out.push(a); }
  return out;
}

export function lastAtr(c: Candle[], n = 14): number { const a = atr(c, n); return a[a.length - 1] ?? 0; }

// ---------- Candle character: impulsive vs corrective ----------
export type CandleKind = 'IMPULSIVE_UP' | 'IMPULSIVE_DOWN' | 'CORRECTIVE';

/** Impulsive = big directional body, bigger than recent bodies, closing near the extreme. */
export function classifyCandle(c: Candle[], i: number, lookback = 10): CandleKind {
  const x = c[i];
  const range = x.high - x.low;
  if (range <= 0) return 'CORRECTIVE';
  const b = body(x);
  const avg = mean(c.slice(Math.max(0, i - lookback), i).map(body)) || b;
  const up = x.close > x.open;
  const closeNearExtreme = up ? (x.high - x.close) / range <= 0.25 : (x.close - x.low) / range <= 0.25;
  if (b / range >= 0.55 && b >= 1.2 * avg && closeNearExtreme) return up ? 'IMPULSIVE_UP' : 'IMPULSIVE_DOWN';
  return 'CORRECTIVE';
}

/** Hammer / shooting star = rejection candles. Never traded alone (Context + Strength + Area). */
export function rejectionCandle(x: Candle): 'HAMMER' | 'SHOOTING_STAR' | null {
  const range = x.high - x.low;
  if (range <= 0) return null;
  const b = body(x), lower = bodyLow(x) - x.low, upper = x.high - bodyHigh(x);
  if (lower >= 2 * b && upper <= 0.3 * range && b / range <= 0.35) return 'HAMMER';
  if (upper >= 2 * b && lower <= 0.3 * range && b / range <= 0.35) return 'SHOOTING_STAR';
  return null;
}

// ---------- Swings and legs (closes, wicks ignored for momentum) ----------
export interface Pivot { i: number; type: 'H' | 'L'; price: number; wick: number }

export function pivots(c: Candle[], k = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < c.length - k; i++) {
    const win = c.slice(i - k, i + k + 1);
    if (win.every((x, j) => j === k || x.high <= c[i].high) && win.some((x, j) => j !== k && x.high < c[i].high)) out.push({ i, type: 'H', price: bodyHigh(c[i]), wick: c[i].high });
    if (win.every((x, j) => j === k || x.low >= c[i].low) && win.some((x, j) => j !== k && x.low > c[i].low)) out.push({ i, type: 'L', price: bodyLow(c[i]), wick: c[i].low });
  }
  // keep alternation: of consecutive same-type pivots keep the most extreme
  const alt: Pivot[] = [];
  for (const p of out) {
    const last = alt[alt.length - 1];
    if (last && last.type === p.type) {
      if ((p.type === 'H' && p.price > last.price) || (p.type === 'L' && p.price < last.price)) alt[alt.length - 1] = p;
    } else alt.push(p);
  }
  return alt;
}

export interface Leg { from: number; to: number; dir: 'UP' | 'DOWN'; size: number; candles: number; speed: number }

export function legs(c: Candle[], k = 2): Leg[] {
  const ps = pivots(c, k);
  const out: Leg[] = [];
  for (let j = 1; j < ps.length; j++) {
    const a = ps[j - 1], b = ps[j];
    const size = Math.abs(b.price - a.price);
    const n = Math.max(1, b.i - a.i);
    out.push({ from: a.i, to: b.i, dir: b.price > a.price ? 'UP' : 'DOWN', size, candles: n, speed: size / n });
  }
  // trailing leg from last pivot to the latest close
  const last = ps[ps.length - 1];
  if (last && last.i < c.length - 1) {
    const endPrice = c[c.length - 1].close;
    const size = Math.abs(endPrice - last.price);
    const n = c.length - 1 - last.i;
    out.push({ from: last.i, to: c.length - 1, dir: last.type === 'L' ? 'UP' : 'DOWN', size, candles: n, speed: size / Math.max(1, n) });
  }
  return out;
}

// ---------- Momentum: correction vs impulse ----------
export type MomentumClass = 'VERY_HEALTHY' | 'OK' | 'EXHAUSTING' | 'NO_NEW_ENTRY' | 'RANGE' | 'OVER';

/** Rulebook: ~10% very healthy, ~20% ok, ~50% exhausting, >50% no new trend entry, 60–70%+ range, 100% momentum over. */
export function classifyRetracement(pct: number): MomentumClass {
  if (pct >= 100) return 'OVER';
  if (pct >= 60) return 'RANGE';
  if (pct > 50) return 'NO_NEW_ENTRY';
  if (pct >= 35) return 'EXHAUSTING';
  if (pct > 15) return 'OK';
  return 'VERY_HEALTHY';
}

export function momentumSequence(ls: Leg[], dir: 'UP' | 'DOWN'): { impulse: Leg; correction: Leg; pct: number; cls: MomentumClass }[] {
  const out: { impulse: Leg; correction: Leg; pct: number; cls: MomentumClass }[] = [];
  for (let j = 1; j < ls.length; j++) {
    if (ls[j - 1].dir === dir && ls[j].dir !== dir && ls[j - 1].size > 0) {
      const pct = (ls[j].size / ls[j - 1].size) * 100;
      out.push({ impulse: ls[j - 1], correction: ls[j], pct, cls: classifyRetracement(pct) });
    }
  }
  return out;
}

// ---------- Range / build-up (4 live touches R-S-R-S) ----------
export interface RangeInfo { top: number; bottom: number; startIdx: number; endIdx: number; touches: number; sequence: string; heightAtr: number }

export function detectRange(c: Candle[], opts: { minTouches?: number; minBars?: number; maxBars?: number; maxHeightAtr?: number; endIdx?: number } = {}): RangeInfo | null {
  const minTouches = opts.minTouches ?? 4, minBars = opts.minBars ?? 8, maxBars = opts.maxBars ?? 40, maxH = opts.maxHeightAtr ?? 4;
  const end = opts.endIdx ?? c.length - 1;
  const a = lastAtr(c.slice(0, end + 1)) || 1e-9;
  let best: RangeInfo | null = null;
  for (let w = minBars; w <= Math.min(maxBars, end + 1); w++) {
    const win = c.slice(end - w + 1, end + 1);
    const top = Math.max(...win.map((x) => x.high)), bottom = Math.min(...win.map((x) => x.low));
    const h = top - bottom;
    if (h <= 0 || h / a > maxH) continue;
    const zone = h * 0.2;
    let seq = '';
    for (const x of win) {
      const r = x.high >= top - zone, s = x.low <= bottom + zone;
      const t = r && !s ? 'R' : s && !r ? 'S' : '';
      if (t && seq[seq.length - 1] !== t) seq += t;
    }
    const closesInside = win.filter((x) => x.close <= top && x.close >= bottom).length / win.length;
    if (seq.length >= minTouches && closesInside >= 0.9 && (!best || seq.length > best.touches || (seq.length === best.touches && w > best.endIdx - best.startIdx + 1))) {
      best = { top, bottom, startIdx: end - w + 1, endIdx: end, touches: seq.length, sequence: seq, heightAtr: h / a };
    }
  }
  return best;
}

// ---------- Territory: important level + prior reaction + sustained break; initiator ----------
export interface Territory {
  side: 'BUYERS' | 'SELLERS' | 'NONE';
  breachLevel?: number;
  breachIdx?: number;
  initiatorIdx?: number;
  initiatorLevel?: number;       // buyers: initiator low; sellers: initiator high — break + sustain flips territory
  sustainedCloses: number;
  note: string;
}

export function territory(c: Candle[], sustain = 2, k = 2): Territory {
  const ps = pivots(c, k);
  let state: Territory = { side: 'NONE', sustainedCloses: 0, note: 'No sustained break of a reacted level yet' };
  for (let i = 0; i < c.length; i++) {
    const prior = ps.filter((p) => p.i + k < i); // pivots confirmed before i
    const lastH = [...prior].reverse().find((p) => p.type === 'H');
    const lastL = [...prior].reverse().find((p) => p.type === 'L');
    const closesAbove = (lvl: number) => { let n = 0; for (let j = i; j >= 0 && c[j].close > lvl; j--) n++; return n; };
    const closesBelow = (lvl: number) => { let n = 0; for (let j = i; j >= 0 && c[j].close < lvl; j--) n++; return n; };

    // Flip by initiator break (sustained)
    if (state.side === 'BUYERS' && state.initiatorLevel !== undefined && closesBelow(state.initiatorLevel) >= sustain) {
      state = { side: 'SELLERS', breachLevel: state.initiatorLevel, breachIdx: i, initiatorIdx: startOfMove(c, i, 'DOWN'), sustainedCloses: closesBelow(state.initiatorLevel), note: 'Buyers\' initiator broken and sustained → sellers\' territory' };
      state.initiatorLevel = c[state.initiatorIdx!].high;
      continue;
    }
    if (state.side === 'SELLERS' && state.initiatorLevel !== undefined && closesAbove(state.initiatorLevel) >= sustain) {
      state = { side: 'BUYERS', breachLevel: state.initiatorLevel, breachIdx: i, initiatorIdx: startOfMove(c, i, 'UP'), sustainedCloses: closesAbove(state.initiatorLevel), note: 'Sellers\' initiator broken and sustained → buyers\' territory' };
      state.initiatorLevel = c[state.initiatorIdx!].low;
      continue;
    }
    if (state.side !== 'BUYERS' && lastH && closesAbove(lastH.wick) >= sustain && (state.breachIdx === undefined || lastH.i > state.breachIdx)) {
      const init = startOfMove(c, i, 'UP');
      state = { side: 'BUYERS', breachLevel: lastH.wick, breachIdx: i, initiatorIdx: init, initiatorLevel: c[init].low, sustainedCloses: closesAbove(lastH.wick), note: `Reacted high ${lastH.wick} broken with ${sustain}+ closes` };
    } else if (state.side !== 'SELLERS' && lastL && closesBelow(lastL.wick) >= sustain && (state.breachIdx === undefined || lastL.i > state.breachIdx)) {
      const init = startOfMove(c, i, 'DOWN');
      state = { side: 'SELLERS', breachLevel: lastL.wick, breachIdx: i, initiatorIdx: init, initiatorLevel: c[init].high, sustainedCloses: closesBelow(lastL.wick), note: `Reacted low ${lastL.wick} broken with ${sustain}+ closes` };
    }
  }
  return state;
}

/** Initiator: the candle where the breaking move began (walk back to the leg start). */
function startOfMove(c: Candle[], i: number, dir: 'UP' | 'DOWN'): number {
  // Walk back through the streak of rising (falling) closes to where the move started.
  let j = i;
  if (dir === 'UP') while (j > 0 && j > i - 30 && c[j - 1].close <= c[j].close) j--;
  else while (j > 0 && j > i - 30 && c[j - 1].close >= c[j].close) j--;
  return j;
}

// ---------- Probe (fake breakout) ----------
export interface Probe { idx: number; level: number; side: 'BELOW' | 'ABOVE'; bounce: number }

export function detectProbes(c: Candle[], level: number, side: 'BELOW' | 'ABOVE', fromIdx = 0): Probe[] {
  const out: Probe[] = [];
  for (let i = Math.max(1, fromIdx); i < c.length; i++) {
    const x = c[i];
    if (side === 'BELOW' && x.low < level && x.close >= level) {
      const nextMax = Math.max(...c.slice(i, Math.min(c.length, i + 6)).map((y) => y.close));
      out.push({ idx: i, level, side, bounce: nextMax - level });
    }
    if (side === 'ABOVE' && x.high > level && x.close <= level) {
      const nextMin = Math.min(...c.slice(i, Math.min(c.length, i + 6)).map((y) => y.close));
      out.push({ idx: i, level, side, bounce: level - nextMin });
    }
  }
  return out;
}

// ---------- V-formation ----------
export interface VFormation { type: 'NORMAL' | 'LOPSIDED'; zoneTop: number; zoneBottom: number; extremeIdx: number; extreme: number; completedIdx: number; dir: 'UP' | 'DOWN' }

/**
 * Bullish V: sellers leave a consolidation (drop), buyers drive price back INTO
 * that consolidation. NORMAL = back to the start; LOPSIDED = body closes beyond it.
 */
export function detectBullishV(c: Candle[], lookback = 40): VFormation | null {
  const start = Math.max(0, c.length - lookback);
  const a = lastAtr(c) || 1e-9;
  let lowIdx = start;
  for (let i = start; i < c.length; i++) if (bodyLow(c[i]) < bodyLow(c[lowIdx])) lowIdx = i;
  // consolidation before the drop: last 6 bars before the decline started
  let declineStart = lowIdx;
  while (declineStart > start && c[declineStart - 1].close >= c[declineStart].close) declineStart--;
  if (lowIdx - declineStart < 2) return null;
  const zoneBars = c.slice(Math.max(0, declineStart - 6), declineStart + 1);
  if (zoneBars.length < 3) return null;
  const zoneTop = Math.max(...zoneBars.map(bodyHigh)), zoneBottom = Math.min(...zoneBars.map(bodyLow));
  const drop = zoneBottom - bodyLow(c[lowIdx]);
  if (drop < 0.8 * a) return null;
  for (let i = lowIdx + 1; i < c.length; i++) {
    if (c[i].close >= zoneBottom) {
      const after = c.slice(i, c.length);
      const lopsided = after.some((x) => x.close > zoneTop);
      return { type: lopsided ? 'LOPSIDED' : 'NORMAL', zoneTop, zoneBottom, extremeIdx: lowIdx, extreme: c[lowIdx].low, completedIdx: i, dir: 'UP' };
    }
  }
  return null;
}

// ---------- Context helpers ----------
export function volatilityClass(c: Candle[]): { cls: 'VOLATILE' | 'NORMAL' | 'QUIET'; ratio: number } {
  if (c.length < 60) return { cls: 'NORMAL', ratio: 1 };
  const short = lastAtr(c, 14), long = lastAtr(c, 50) || 1e-9;
  const ratio = short / long;
  return { cls: ratio > 1.25 ? 'VOLATILE' : ratio < 0.75 ? 'QUIET' : 'NORMAL', ratio };
}

/** Who dominates? Compares recent up-leg vs down-leg size×speed. Rulebook wants ~70/30, not 50/50. */
export function dominance(ls: Leg[], n = 4): { buyersShare: number } {
  const recent = ls.slice(-n);
  const up = recent.filter((l) => l.dir === 'UP').reduce((s, l) => s + l.size * Math.sqrt(l.speed), 0);
  const dn = recent.filter((l) => l.dir === 'DOWN').reduce((s, l) => s + l.size * Math.sqrt(l.speed), 0);
  return { buyersShare: up + dn > 0 ? up / (up + dn) : 0.5 };
}

/** Previous-day high/low from intraday candles (IST days). */
export function previousDayHighLow(c: Candle[]): { pdh?: number; pdl?: number } {
  const day = (ts: number) => new Date(ts + 330 * 60_000).toISOString().slice(0, 10);
  if (!c.length) return {};
  const today = day(c[c.length - 1].ts);
  const prev = c.filter((x) => day(x.ts) < today);
  if (!prev.length) return {};
  const pd = day(prev[prev.length - 1].ts);
  const pdc = prev.filter((x) => day(x.ts) === pd);
  return { pdh: Math.max(...pdc.map((x) => x.high)), pdl: Math.min(...pdc.map((x) => x.low)) };
}

/** Resample candles to a higher timeframe (bucket by ms). */
export function resample(c: Candle[], bucketMs: number): Candle[] {
  const out: Candle[] = [];
  for (const x of c) {
    const b = Math.floor(x.ts / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.ts === b) { last.high = Math.max(last.high, x.high); last.low = Math.min(last.low, x.low); last.close = x.close; last.volume += x.volume; }
    else out.push({ ...x, ts: b });
  }
  return out;
}

/** Data completeness: largest gap between consecutive candles, in bars. */
export function maxGapBars(c: Candle[], tfMs: number, sessionAware = false): number {
  let g = 0;
  for (let i = 1; i < c.length; i++) {
    const bars = Math.round((c[i].ts - c[i - 1].ts) / tfMs) - 1;
    if (sessionAware && bars > 0) {
      const d1 = new Date(c[i - 1].ts + 330 * 60_000).toISOString().slice(0, 10), d2 = new Date(c[i].ts + 330 * 60_000).toISOString().slice(0, 10);
      if (d1 !== d2) continue; // overnight gap is not missing data
    }
    g = Math.max(g, bars);
  }
  return g;
}

export function nextResistanceAbove(c: Candle[], price: number, k = 2): number | undefined {
  const hs = pivots(c, k).filter((p) => p.type === 'H' && p.wick > price).map((p) => p.wick).sort((a, b) => a - b);
  return hs[0];
}
