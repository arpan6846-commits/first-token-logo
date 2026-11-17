// Market data cache with freshness tracking, plus a seeded synthetic market used
// ONLY by the simulation environment. Synthetic data is always labelled
// SIMULATED, and the production ledger refuses that source.

import type { Candle, DataSource, Quote, Timeframe, Venue } from './types.ts';
import { TIMEFRAME_MINUTES } from './types.ts';
import { resample } from './priceAction.ts';

export class MarketDataCache {
  private quotes = new Map<string, Quote>();
  private candles = new Map<string, Candle[]>();
  private lastTick = new Map<Venue, number>();

  upsertQuote(q: Quote) {
    const k = `${q.venue}:${q.symbol}`;
    const prev = this.quotes.get(k);
    if (prev && prev.exchangeTs > q.exchangeTs) return; // ignore out-of-order ticks
    this.quotes.set(k, q);
    this.lastTick.set(q.venue, Math.max(this.lastTick.get(q.venue) ?? 0, q.receivedAt));
  }
  quote(venue: Venue, symbol: string) { return this.quotes.get(`${venue}:${symbol}`); }
  allQuotes(): Map<string, Quote> { return new Map(this.quotes); }

  upsertCandles(venue: Venue, symbol: string, tf: Timeframe, cs: Candle[]) {
    const k = `${venue}:${symbol}:${tf}`;
    const m = new Map((this.candles.get(k) ?? []).map((c) => [c.ts, c]));
    for (const c of cs) m.set(c.ts, c);
    this.candles.set(k, [...m.values()].sort((a, b) => a.ts - b.ts).slice(-2000));
  }
  /** Closed candles only: drops a candle whose period has not ended at `now`. */
  closedCandles(venue: Venue, symbol: string, tf: Timeframe, now: number): Candle[] {
    const tfMs = TIMEFRAME_MINUTES[tf] * 60_000;
    return (this.candles.get(`${venue}:${symbol}:${tf}`) ?? []).filter((c) => c.ts + tfMs <= now);
  }
  feedHealth(venue: Venue, now: number, maxAgeMs: number): { healthy: boolean; lastTickAgeMs: number } {
    const t = this.lastTick.get(venue);
    const age = t === undefined ? Infinity : now - t;
    return { healthy: age <= maxAgeMs, lastTickAgeMs: age };
  }
}

// -------- Synthetic market (simulation only) --------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticSymbol { symbol: string; venue: Venue; start: number; vol: number; tick: number; session: 'NSE' | '24x7' }

/** Regime-switching random walk (trend/range) so price-action patterns appear. */
export class SyntheticMarket {
  private rng: () => number;
  private state = new Map<string, { price: number; drift: number; regimeLeft: number }>();
  readonly source: DataSource = 'SIMULATED';
  constructor(private symbols: SyntheticSymbol[], seed = 42) {
    this.rng = mulberry32(seed);
    for (const s of symbols) this.state.set(s.symbol, { price: s.start, drift: 0, regimeLeft: 0 });
  }
  private gauss() { const u = Math.max(1e-12, this.rng()), v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /** Next 5-minute candle for a symbol, opening at ts. */
  nextCandle(sym: SyntheticSymbol, ts: number): Candle {
    const st = this.state.get(sym.symbol)!;
    if (st.regimeLeft <= 0) {
      const r = this.rng();
      st.drift = r < 0.35 ? sym.vol * 0.35 : r < 0.6 ? -sym.vol * 0.3 : 0;
      st.regimeLeft = 20 + Math.floor(this.rng() * 80);
    }
    st.regimeLeft--;
    const open = st.price;
    let hi = open, lo = open, p = open;
    for (let i = 0; i < 5; i++) {
      p = p * (1 + st.drift / 5 + (sym.vol / Math.sqrt(5)) * this.gauss());
      hi = Math.max(hi, p); lo = Math.min(lo, p);
    }
    hi *= 1 + Math.abs(this.gauss()) * sym.vol * 0.2; lo *= 1 - Math.abs(this.gauss()) * sym.vol * 0.2;
    st.price = p;
    const q = (x: number) => Math.max(sym.tick, Number((Math.round(x / sym.tick) * sym.tick).toFixed(6)));
    return { ts, open: q(open), high: q(Math.max(hi, open, p)), low: q(Math.min(lo, open, p)), close: q(p), volume: Math.round(1000 + this.rng() * 9000) };
  }

  /** Generates `bars` 5m candles ending before `endTs`, respecting NSE session for equities. */
  history(sym: SyntheticSymbol, endTs: number, bars: number): Candle[] {
    const step = 5 * 60_000;
    const out: Candle[] = [];
    let t = Math.floor(endTs / step) * step - step * bars * (sym.session === 'NSE' ? 4 : 1);
    while (out.length < bars && t < endTs) {
      if (sym.session === '24x7' || inNseSession(t)) out.push(this.nextCandle(sym, t));
      t += step;
    }
    return out;
  }

  quoteFrom(sym: SyntheticSymbol, c: Candle, now: number): Quote {
    const spread = sym.tick * (sym.session === 'NSE' ? 1 : 2);
    return { symbol: sym.symbol, venue: sym.venue, ltp: c.close, bid: c.close - spread / 2, ask: c.close + spread / 2, volume: c.volume, exchangeTs: now, receivedAt: now, source: 'SIMULATED' };
  }
}

function inNseSession(ts: number): boolean {
  const d = new Date(ts + 330 * 60_000);
  const wd = d.getUTCDay();
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd !== 0 && wd !== 6 && m >= 555 && m < 930;
}

export function buildTimeframes(base5m: Candle[]): Record<Timeframe, Candle[]> {
  const out = {} as Record<Timeframe, Candle[]>;
  for (const tf of ['5m', '15m', '1h', '4h', '1d'] as Timeframe[]) out[tf] = tf === '5m' ? base5m : resample(base5m, TIMEFRAME_MINUTES[tf] * 60_000);
  out['1w'] = resample(base5m, 7 * 86_400_000);
  out['1M'] = resample(base5m, 30 * 86_400_000);
  return out;
}
