// Builds closed candles from live ticks (used by the worker's WebSocket feeds).
// A candle is emitted only after its period has ended, so in-progress candles
// never reach the signal engine.

import type { Candle } from './types.ts';

export class CandleBuilder {
  private cur = new Map<string, Candle>();
  constructor(private periodMs: number) {}

  /** Feed a tick; returns the candle that just closed (if the tick starts a new period). */
  onTick(key: string, price: number, ts: number, volume = 0): Candle | undefined {
    if (!(price > 0) || !Number.isFinite(ts)) return undefined;
    const bucket = Math.floor(ts / this.periodMs) * this.periodMs;
    const c = this.cur.get(key);
    if (!c) { this.cur.set(key, { ts: bucket, open: price, high: price, low: price, close: price, volume }); return undefined; }
    if (bucket < c.ts) return undefined; // late tick for an already-closed period: ignore
    if (bucket === c.ts) { c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.volume += volume; return undefined; }
    this.cur.set(key, { ts: bucket, open: price, high: price, low: price, close: price, volume });
    return c;
  }

  /** Close candles whose period ended without a new tick (call on a timer). */
  flush(now: number): { key: string; candle: Candle }[] {
    const out: { key: string; candle: Candle }[] = [];
    for (const [k, c] of this.cur) if (c.ts + this.periodMs <= now) { out.push({ key: k, candle: c }); this.cur.delete(k); }
    return out;
  }
}
