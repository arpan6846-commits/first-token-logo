// Long-lived market feeds. Kite: WebSocket ticker (full mode) during NSE hours.
// CoinDCX: REST ticker polling (WebSocket is socket.io-based; polling every few
// seconds is simpler and sufficient for 1h-timeframe crypto signals).
// Feeds report health; the risk engine refuses to trade on stale quotes.

import type { KiteAdapter } from '../core/adapters/kite.ts';
import { parseKiteTicks } from '../core/adapters/kite.ts';
import type { CoinDCXAdapter } from '../core/adapters/coindcx.ts';
import { CandleBuilder } from '../core/candleBuilder.ts';
import type { MarketDataCache } from '../core/marketData.ts';
import { resample } from '../core/priceAction.ts';
import type { Candle, Timeframe, Venue } from '../core/types.ts';
import { TIMEFRAME_MINUTES } from '../core/types.ts';

const TFS: Timeframe[] = ['15m', '1h', '4h', '1d'];

/** Maintains 5m base candles from ticks and derives higher timeframes. */
export class CandleStore {
  private builder = new CandleBuilder(5 * 60_000);
  private base = new Map<string, Candle[]>();
  constructor(private market: MarketDataCache, private onClose?: (venue: Venue, symbol: string, tf: Timeframe) => void) {}
  seed(venue: Venue, symbol: string, base5m: Candle[]) { this.base.set(`${venue}:${symbol}`, base5m.slice(-3000)); this.publish(venue, symbol); }
  tick(venue: Venue, symbol: string, price: number, ts: number) {
    const c = this.builder.onTick(`${venue}:${symbol}`, price, ts);
    if (c) this.append(venue, symbol, c);
  }
  flush(now: number) { for (const { key, candle } of this.builder.flush(now)) { const [v, s] = key.split(/:(.+)/); this.append(v as Venue, s, candle); } }
  private append(venue: Venue, symbol: string, c: Candle) {
    const k = `${venue}:${symbol}`;
    const arr = this.base.get(k) ?? [];
    if (!arr.length || arr[arr.length - 1].ts < c.ts) arr.push(c);
    this.base.set(k, arr.slice(-3000));
    this.publish(venue, symbol);
  }
  private publish(venue: Venue, symbol: string) {
    const b = this.base.get(`${venue}:${symbol}`) ?? [];
    this.market.upsertCandles(venue, symbol, '5m', b);
    for (const tf of TFS) { this.market.upsertCandles(venue, symbol, tf, resample(b, TIMEFRAME_MINUTES[tf] * 60_000)); this.onClose?.(venue, symbol, tf); }
  }
}

export function startKiteTicker(kite: KiteAdapter, symbols: string[], market: MarketDataCache, candles: CandleStore, log: (m: string) => void): () => void {
  let ws: WebSocket | undefined, stopped = false, retry = 0;
  const bySym = new Map<number, string>();
  for (const s of symbols) { const t = kite.tokenOf(s); if (t) bySym.set(t, s); }
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(kite.tickerUrl());
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      retry = 0;
      const tokens = [...bySym.keys()];
      ws!.send(JSON.stringify({ a: 'subscribe', v: tokens }));
      ws!.send(JSON.stringify({ a: 'mode', v: ['full', tokens] }));
      log(`kite ticker connected (${tokens.length} instruments)`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') return; // postbacks/errors as text messages
      const now = Date.now();
      for (const t of parseKiteTicks(ev.data as ArrayBuffer)) {
        const sym = bySym.get(t.token);
        if (!sym) continue;
        const ts = t.exchangeTs ?? now;
        market.upsertQuote({ symbol: sym, venue: 'KITE', ltp: t.ltp, bid: t.bid || undefined, ask: t.ask || undefined, volume: t.volume, exchangeTs: ts, receivedAt: now, source: 'LIVE' });
        candles.tick('KITE', sym, t.ltp, ts);
      }
    };
    ws.onclose = () => { if (stopped) return; const d = Math.min(60_000, 1000 * 2 ** retry++); log(`kite ticker closed — reconnecting in ${d / 1000}s`); setTimeout(connect, d); };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => { stopped = true; ws?.close(); };
}

export function startCoindcxPolling(cdx: CoinDCXAdapter, symbols: string[], market: MarketDataCache, candles: CandleStore, log: (m: string) => void, everyMs = 5000): () => void {
  let stopped = false, failures = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        for (const q of await cdx.getQuotes(symbols)) { market.upsertQuote(q); candles.tick('COINDCX', q.symbol, q.ltp, q.exchangeTs); }
        failures = 0;
      } catch (e) {
        if (++failures % 6 === 1) log(`coindcx ticker error: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(60_000, everyMs * 2 ** Math.min(failures, 4))));
    }
  };
  loop();
  return () => { stopped = true; };
}
