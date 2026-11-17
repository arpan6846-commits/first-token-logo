// Zerodha Kite Connect v3 adapter (NSE/BSE cash equity, CNC only).
// Verified against Kite Connect v3 docs (orders, trades, postbacks):
//  - Auth header: `Authorization: token api_key:access_token`, `X-Kite-Version: 3`
//  - POST /orders/regular (form-encoded) → { data: { order_id } }
//  - `tag` alphanumeric ≤ 20 chars — used as our client order id
//  - GET /orders, GET /orders/:id (history), GET /orders/:id/trades, GET /trades (today only)
//  - Postback checksum = sha256(order_id + order_timestamp + api_secret)
//  - Session: POST /session/token with checksum = sha256(api_key + request_token + api_secret)
// The access token expires daily (early morning); the owner logs in each
// trading day via the Kite login URL. Broker passwords/TOTP are never stored.
// Static-IP and SEBI retail-algo requirements: see docs/COMPLIANCE.md.

import { sha256Hex, timingSafeEqualHex } from '../hash.ts';
import { toPaise } from '../money.ts';
import type { Candle, Quote, Timeframe } from '../types.ts';
import { httpJson, parseIst, type FetchLike } from './http.ts';
import {
  AdapterError, type AdapterCapabilities, type MarketEvent, type PlaceOrderAck, type PlaceOrderRequest, type VenueAdapter,
  type VenueBalance, type VenueHolding, type VenueOrderState, type VenueOrderStatus, type VenueTrade,
} from './types.ts';

export const KITE_API = 'https://api.kite.trade';
export const kiteLoginUrl = (apiKey: string) => `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
export const kiteSessionChecksum = (apiKey: string, requestToken: string, apiSecret: string) => sha256Hex(apiKey + requestToken + apiSecret);

export function verifyKitePostback(payload: { order_id: string; order_timestamp: string; checksum: string }, apiSecret: string): boolean {
  if (!payload?.order_id || !payload.order_timestamp || typeof payload.checksum !== 'string') return false;
  return timingSafeEqualHex(sha256Hex(payload.order_id + payload.order_timestamp + apiSecret), payload.checksum.toLowerCase());
}

export async function kiteCreateSession(fetchFn: FetchLike, apiKey: string, requestToken: string, apiSecret: string): Promise<{ accessToken: string; userId: string }> {
  const body = new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum: kiteSessionChecksum(apiKey, requestToken, apiSecret) });
  const r = await httpJson<{ data: { access_token: string; user_id: string } }>(fetchFn, `${KITE_API}/session/token`, {
    method: 'POST', headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  return { accessToken: r.data.access_token, userId: r.data.user_id };
}

const TF: Partial<Record<Timeframe, string>> = { '5m': '5minute', '15m': '15minute', '1h': '60minute', '1d': 'day' };

interface KiteOrder { order_id: string; status: string; tag: string | null; quantity: number; filled_quantity: number; average_price: number; status_message: string | null; order_timestamp: string; exchange_update_timestamp?: string | null; tradingsymbol: string; transaction_type: 'BUY' | 'SELL' }
interface KiteTrade { trade_id: string; order_id: string; tradingsymbol: string; transaction_type: 'BUY' | 'SELL'; average_price: number; quantity?: number; filled?: number; fill_timestamp: string }

export function mapKiteStatus(o: Pick<KiteOrder, 'status' | 'filled_quantity' | 'quantity'>): VenueOrderStatus {
  const s = o.status.toUpperCase();
  if (s === 'COMPLETE') return 'FILLED';
  if (s === 'REJECTED') return 'REJECTED';
  if (s === 'CANCELLED') return 'CANCELLED';
  if (o.filled_quantity > 0 && o.filled_quantity < o.quantity) return 'PARTIALLY_FILLED';
  if (s === 'OPEN' || s === 'TRIGGER PENDING') return 'OPEN';
  return 'PENDING'; // PUT ORDER REQ RECEIVED, VALIDATION PENDING, OPEN PENDING, MODIFY/CANCEL PENDING …
}

export class KiteAdapter implements VenueAdapter {
  readonly venue = 'KITE' as const;
  readonly mode = 'LIVE' as const;
  readonly dataSource = 'LIVE' as const;
  private tokens = new Map<string, number>();

  constructor(private cfg: { apiKey: string; accessToken: string; fetch?: FetchLike; exchange?: 'NSE' | 'BSE'; instrumentTokens?: Record<string, number> }) {
    if (!cfg.apiKey || !cfg.accessToken) throw new AdapterError('AUTH', 'Kite credentials missing (KITE_API_KEY and a fresh access token are required)');
    for (const [k, v] of Object.entries(cfg.instrumentTokens ?? {})) this.tokens.set(k, v);
  }
  private get f(): FetchLike { return this.cfg.fetch ?? ((u, i) => fetch(u, i)); }
  private get headers() { return { 'X-Kite-Version': '3', Authorization: `token ${this.cfg.apiKey}:${this.cfg.accessToken}` }; }
  private get ex() { return this.cfg.exchange ?? 'NSE'; }
  private get<T>(path: string) { return httpJson<{ data: T }>(this.f, `${KITE_API}${path}`, { headers: this.headers }).then((r) => r.data); }

  capabilities(): AdapterCapabilities {
    return {
      venue: 'KITE', mode: 'LIVE', orderTypes: ['LIMIT', 'MARKET', 'SL', 'SL-M'], products: ['CNC'], supportsWebSocket: true,
      supportsClientOrderId: true, supportsPostbacks: true, spotOnly: true, leverageDisabled: true, withdrawalsViaApi: false,
      notes: [
        'Only product=CNC is ever sent (no MIS/NRML/MTF) — enforced by the risk engine and here.',
        '`tag` (≤20 alphanumeric) carries our client order id; lookups scan today\'s order book.',
        'Charges are not in the trade book — fills use the fee model until contract-note charges are imported.',
        'Access token expires daily; owner must log in each trading day.',
        'Verify current static-IP and SEBI retail-algo requirements with Zerodha before enabling orders.',
      ],
    };
  }

  async health() {
    const t = Date.now();
    try { await this.get('/user/profile'); return { ok: true, latencyMs: Date.now() - t, message: 'Kite session valid' }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t, message: (e as Error).message }; }
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (!symbols.length) return [];
    const qs = symbols.map((s) => `i=${encodeURIComponent(`${this.ex}:${s}`)}`).join('&');
    const data = await this.get<Record<string, { last_price: number; volume?: number; timestamp?: string; last_trade_time?: string; depth?: { buy: { price: number }[]; sell: { price: number }[] }; instrument_token?: number }>>(`/quote?${qs}`);
    const now = Date.now();
    return Object.entries(data).map(([k, v]) => {
      const symbol = k.split(':')[1];
      if (v.instrument_token) this.tokens.set(symbol, v.instrument_token);
      return { symbol, venue: 'KITE' as const, ltp: v.last_price, bid: v.depth?.buy?.[0]?.price || undefined, ask: v.depth?.sell?.[0]?.price || undefined, volume: v.volume, exchangeTs: parseIst(v.timestamp ?? v.last_trade_time), receivedAt: now, source: 'LIVE' as const };
    });
  }

  async getCandles(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]> {
    const interval = TF[tf];
    if (!interval) throw new AdapterError('UNSUPPORTED', `Kite has no ${tf} interval`);
    const token = this.tokens.get(symbol);
    if (!token) throw new AdapterError('INVALID', `No instrument token for ${symbol} — load the instruments dump first`);
    const fmt = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const data = await this.get<{ candles: [string, number, number, number, number, number][] }>(`/instruments/historical/${token}/${interval}?from=${encodeURIComponent(fmt(from))}&to=${encodeURIComponent(fmt(to))}`);
    return data.candles.map(([ts, o, h, l, c, v]) => ({ ts: Date.parse(ts), open: o, high: h, low: l, close: c, volume: v }));
  }

  async getBalance(): Promise<VenueBalance> {
    const d = await this.get<{ available?: { live_balance?: number; cash?: number }; net?: number }>('/user/margins/equity');
    const cash = d.available?.live_balance ?? d.net ?? d.available?.cash ?? 0;
    return { cashPaise: toPaise(cash), raw: { live_balance: d.available?.live_balance, net: d.net }, asOf: Date.now() };
  }

  /** Holdings (incl. T1) plus today's CNC net positions — what the account actually owns. */
  async getHoldings(): Promise<VenueHolding[]> {
    const h = await this.get<{ tradingsymbol: string; quantity: number; t1_quantity?: number; average_price: number }[]>('/portfolio/holdings');
    const p = await this.get<{ net: { tradingsymbol: string; product: string; quantity: number; average_price: number }[] }>('/portfolio/positions');
    const m = new Map<string, VenueHolding>();
    for (const x of h) m.set(x.tradingsymbol, { symbol: x.tradingsymbol, qty: x.quantity + (x.t1_quantity ?? 0), avgPrice: x.average_price });
    for (const x of p.net.filter((y) => y.product === 'CNC' && y.quantity !== 0)) {
      const cur = m.get(x.tradingsymbol);
      m.set(x.tradingsymbol, { symbol: x.tradingsymbol, qty: (cur?.qty ?? 0) + x.quantity, avgPrice: cur?.avgPrice ?? x.average_price });
    }
    return [...m.values()].filter((x) => x.qty !== 0);
  }

  async placeOrder(r: PlaceOrderRequest): Promise<PlaceOrderAck> {
    if (r.product !== 'CNC') throw new AdapterError('REJECTED', 'Only CNC is permitted (no leverage)');
    if (!/^[A-Za-z0-9]{1,20}$/.test(r.clientOrderId)) throw new AdapterError('INVALID', 'Kite tag must be ≤20 alphanumeric chars');
    if (!Number.isInteger(r.qty) || r.qty <= 0) throw new AdapterError('INVALID', 'Equity quantity must be a positive integer');
    const body = new URLSearchParams({
      tradingsymbol: r.symbol, exchange: this.ex, transaction_type: r.side, order_type: r.orderType, quantity: String(r.qty),
      product: 'CNC', validity: 'DAY', tag: r.clientOrderId,
    });
    if (r.limitPrice !== undefined) body.set('price', String(r.limitPrice));
    if (r.triggerPrice !== undefined) body.set('trigger_price', String(r.triggerPrice));
    if (r.orderType === 'MARKET' || r.orderType === 'SL-M') body.set('market_protection', '-1');
    const res = await httpJson<{ data: { order_id: string } }>(this.f, `${KITE_API}/orders/regular`, {
      method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), isOrderPlacement: true, timeoutMs: 8000,
    });
    if (!res.data?.order_id) throw new AdapterError('NETWORK', 'Kite response missing order_id — treating outcome as unknown');
    return { brokerOrderId: res.data.order_id, status: 'PENDING' };
  }

  async cancelOrder(id: string) {
    await httpJson(this.f, `${KITE_API}/orders/regular/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers });
  }

  private async state(o: KiteOrder): Promise<VenueOrderState> {
    const trades = o.filled_quantity > 0 ? await this.get<KiteTrade[]>(`/orders/${encodeURIComponent(o.order_id)}/trades`) : [];
    return {
      brokerOrderId: o.order_id, clientOrderId: o.tag ?? undefined, status: mapKiteStatus(o), qty: o.quantity, filledQty: o.filled_quantity,
      avgPrice: o.average_price || undefined, rejectionReason: o.status_message ?? undefined, trades: trades.map((t) => this.trade(t)),
      updatedAt: parseIst(o.exchange_update_timestamp ?? o.order_timestamp),
    };
  }
  private trade(t: KiteTrade): VenueTrade {
    return { venueTradeId: `${t.order_id}:${t.trade_id}`, brokerOrderId: t.order_id, symbol: t.tradingsymbol, side: t.transaction_type, qty: t.quantity ?? t.filled ?? 0, price: t.average_price, ts: parseIst(t.fill_timestamp) };
  }

  async getOrder(id: string): Promise<VenueOrderState> {
    const hist = await this.get<KiteOrder[]>(`/orders/${encodeURIComponent(id)}`);
    if (!hist.length) throw new AdapterError('INVALID', `Kite order ${id} not found`);
    return this.state(hist[hist.length - 1]);
  }

  async findOrderByClientId(cid: string) {
    const all = await this.get<KiteOrder[]>('/orders');
    const o = all.filter((x) => x.tag === cid).pop();
    return o ? this.state(o) : undefined;
  }

  async getTrades(sinceTs = 0): Promise<VenueTrade[]> {
    return (await this.get<KiteTrade[]>('/trades')).map((t) => this.trade(t)).filter((t) => t.ts >= sinceTs);
  }

  /** Builds the WebSocket URL; the worker owns the long-lived socket (see worker/kiteTicker.ts). */
  tickerUrl() { return `wss://ws.kite.trade?api_key=${encodeURIComponent(this.cfg.apiKey)}&access_token=${encodeURIComponent(this.cfg.accessToken)}`; }
  subscribe?: (symbols: string[], onEvent: (e: MarketEvent) => void) => () => void;
}

/**
 * Parses a Kite ticker binary message (full mode packets, 184 bytes; quote 44; ltp 8).
 * Layout per Kite WebSocket docs — VERIFY offsets against the current docs before go-live.
 */
export function parseKiteTicks(buf: ArrayBuffer): { token: number; ltp: number; volume?: number; bid?: number; ask?: number; exchangeTs?: number }[] {
  const dv = new DataView(buf);
  if (buf.byteLength < 2) return []; // heartbeat
  const n = dv.getInt16(0);
  const out: ReturnType<typeof parseKiteTicks> = [];
  let off = 2;
  for (let i = 0; i < n && off + 2 <= buf.byteLength; i++) {
    const len = dv.getInt16(off); off += 2;
    const p = new DataView(buf, off, len);
    const token = p.getInt32(0);
    const div = 100; // equities: paise → rupees
    const t: ReturnType<typeof parseKiteTicks>[number] = { token, ltp: p.getInt32(4) / div };
    if (len >= 44) t.volume = p.getInt32(16);
    if (len >= 184) {
      t.exchangeTs = p.getInt32(60) * 1000;
      t.bid = p.getInt32(64 + 4) / div;          // first bid entry: qty(4) price(4) orders(2) pad(2)
      t.ask = p.getInt32(64 + 60 + 4) / div;     // first ask entry after 5 bids
    }
    out.push(t);
    off += len;
  }
  return out;
}
