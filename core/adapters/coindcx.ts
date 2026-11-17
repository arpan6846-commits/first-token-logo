// CoinDCX spot adapter (INR markets only; no margin/futures endpoints are ever called).
// Verified against CoinDCX API docs:
//  - Base https://api.coindcx.com; headers X-AUTH-APIKEY, X-AUTH-SIGNATURE
//  - Signature = HMAC-SHA256(secret, exact JSON body string); body carries `timestamp` (ms)
//  - POST /exchange/v1/orders/create {side, order_type: limit_order|market_order, market, price_per_unit, total_quantity, timestamp, client_order_id}
//  - POST /exchange/v1/orders/status {id | client_order_id, timestamp}
//  - POST /exchange/v1/orders/trade_history → [{id, order_id, side, fee_amount, quantity, price, symbol, timestamp}]
// Endpoints marked [VERIFY] were not re-checked in this build session.
// The API key must be created WITHOUT withdrawal permission (and IP-bound if offered).

import { hmacSha256Hex } from '../hash.ts';
import { toPaise } from '../money.ts';
import type { Candle, Quote, Timeframe } from '../types.ts';
import { httpJson, type FetchLike } from './http.ts';
import {
  AdapterError, type AdapterCapabilities, type PlaceOrderAck, type PlaceOrderRequest, type VenueAdapter, type VenueBalance,
  type VenueHolding, type VenueOrderState, type VenueOrderStatus, type VenueTrade,
} from './types.ts';

export const COINDCX_API = 'https://api.coindcx.com';
export const COINDCX_PUBLIC = 'https://public.coindcx.com';

export function coindcxSign(secret: string, body: string): string { return hmacSha256Hex(secret, body); }

export function mapCoindcxStatus(s: string, total: number, remaining: number): VenueOrderStatus {
  const x = s.toLowerCase();
  if (x === 'filled') return 'FILLED';
  if (x === 'rejected') return 'REJECTED';
  if (x === 'cancelled' || x === 'partially_cancelled') return 'CANCELLED';
  if (x === 'partially_filled' || (remaining < total && remaining > 0)) return 'PARTIALLY_FILLED';
  if (x === 'open') return 'OPEN';
  return 'PENDING'; // init
}

interface CdxOrder { id: string; client_order_id?: string; market: string; side: 'buy' | 'sell'; status: string; total_quantity: number; remaining_quantity: number; avg_price: number; fee_amount: number; updated_at: number; created_at: number }
interface CdxTrade { id: number; order_id: string; side: 'buy' | 'sell'; fee_amount: number; quantity: number; price: number; symbol: string; timestamp: number }

const TF: Partial<Record<Timeframe, string>> = { '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' };

export class CoinDCXAdapter implements VenueAdapter {
  readonly venue = 'COINDCX' as const;
  readonly mode = 'LIVE' as const;
  readonly dataSource = 'LIVE' as const;
  private pairs = new Map<string, string>(); // BTCINR → I-BTC_INR

  constructor(private cfg: { apiKey: string; apiSecret: string; fetch?: FetchLike; pairs?: Record<string, string>; now?: () => number }) {
    if (!cfg.apiKey || !cfg.apiSecret) throw new AdapterError('AUTH', 'CoinDCX credentials missing');
    for (const [k, v] of Object.entries(cfg.pairs ?? {})) this.pairs.set(k, v);
  }
  private get f(): FetchLike { return this.cfg.fetch ?? ((u, i) => fetch(u, i)); }
  private now() { return (this.cfg.now ?? Date.now)(); }

  private async signed<T>(path: string, body: Record<string, unknown>, opts: { isOrderPlacement?: boolean } = {}): Promise<T> {
    const json = JSON.stringify({ ...body, timestamp: this.now() });
    return httpJson<T>(this.f, `${COINDCX_API}${path}`, {
      method: 'POST', body: json, isOrderPlacement: opts.isOrderPlacement, timeoutMs: 8000,
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': this.cfg.apiKey, 'X-AUTH-SIGNATURE': coindcxSign(this.cfg.apiSecret, json) },
    });
  }

  capabilities(): AdapterCapabilities {
    return {
      venue: 'COINDCX', mode: 'LIVE', orderTypes: ['LIMIT', 'MARKET'], products: ['SPOT'], supportsWebSocket: true, supportsClientOrderId: true,
      supportsPostbacks: false, spotOnly: true, leverageDisabled: true, withdrawalsViaApi: false,
      notes: [
        'Spot INR markets only; margin/futures endpoints are never called.',
        'client_order_id must be unique per order — duplicates are rejected by the exchange (extra duplicate protection).',
        'TDS (1%) on sales is withheld by the exchange and is not in the trade record — estimated, then reconciled from statements.',
        'API key must have withdrawal disabled; verify in CoinDCX API settings.',
      ],
    };
  }

  async health() {
    const t = Date.now();
    try { await this.signed('/exchange/v1/users/balances', {}); return { ok: true, latencyMs: Date.now() - t, message: 'CoinDCX auth OK' }; }
    catch (e) { return { ok: false, latencyMs: Date.now() - t, message: (e as Error).message }; }
  }

  /** [VERIFY] public ticker: GET /exchange/ticker → [{market, last_price, bid, ask, volume, timestamp(s)}] */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const all = await httpJson<{ market: string; last_price: string; bid?: string; ask?: string; volume?: string; timestamp: number }[]>(this.f, `${COINDCX_API}/exchange/ticker`);
    const now = Date.now();
    return all.filter((t) => symbols.includes(t.market)).map((t) => ({
      symbol: t.market, venue: 'COINDCX' as const, ltp: Number(t.last_price), bid: t.bid ? Number(t.bid) : undefined, ask: t.ask ? Number(t.ask) : undefined,
      volume: t.volume ? Number(t.volume) : undefined, exchangeTs: t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp, receivedAt: now, source: 'LIVE' as const,
    }));
  }

  /** [VERIFY] markets_details provides pair codes and min sizes. */
  async loadMarkets(): Promise<{ symbol: string; pair: string; minQuantity: number; minNotional: number; step: number; targetPrecision: number; basePrecision: number }[]> {
    const d = await httpJson<{ symbol: string; pair: string; min_quantity: number; min_notional: number; step: number; target_currency_precision: number; base_currency_precision: number; base_currency_short_name: string; status: string }[]>(this.f, `${COINDCX_API}/exchange/v1/markets_details`);
    const inr = d.filter((m) => m.base_currency_short_name === 'INR' && m.status === 'active');
    for (const m of inr) this.pairs.set(m.symbol, m.pair);
    return inr.map((m) => ({ symbol: m.symbol, pair: m.pair, minQuantity: m.min_quantity, minNotional: m.min_notional, step: m.step, targetPrecision: m.target_currency_precision, basePrecision: m.base_currency_precision }));
  }

  /** [VERIFY] public candles: GET public.coindcx.com/market_data/candles?pair=&interval=&startTime=&endTime= */
  async getCandles(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]> {
    const pair = this.pairs.get(symbol);
    if (!pair || !TF[tf]) throw new AdapterError('INVALID', `Unknown pair/interval for ${symbol} ${tf} — call loadMarkets() first`);
    const d = await httpJson<{ open: number; high: number; low: number; close: number; volume: number; time: number }[]>(this.f, `${COINDCX_PUBLIC}/market_data/candles?pair=${encodeURIComponent(pair)}&interval=${TF[tf]}&startTime=${from}&endTime=${to}`);
    return d.map((c) => ({ ts: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })).sort((a, b) => a.ts - b.ts);
  }

  async getBalance(): Promise<VenueBalance> {
    const b = await this.signed<{ currency: string; balance: number; locked_balance: number }[]>('/exchange/v1/users/balances', {});
    const inr = b.find((x) => x.currency === 'INR');
    return { cashPaise: toPaise((inr?.balance ?? 0) + (inr?.locked_balance ?? 0)), raw: { currencies: b.length }, asOf: Date.now() };
  }

  async getHoldings(): Promise<VenueHolding[]> {
    const b = await this.signed<{ currency: string; balance: number; locked_balance: number }[]>('/exchange/v1/users/balances', {});
    return b.filter((x) => x.currency !== 'INR' && x.balance + x.locked_balance > 0).map((x) => ({ symbol: `${x.currency}INR`, qty: Number(x.balance) + Number(x.locked_balance), avgPrice: 0 }));
  }

  async placeOrder(r: PlaceOrderRequest): Promise<PlaceOrderAck> {
    if (r.product !== 'SPOT') throw new AdapterError('REJECTED', 'Only spot orders are permitted');
    if (!r.symbol.endsWith('INR')) throw new AdapterError('REJECTED', 'Only INR spot markets are permitted');
    if (r.orderType !== 'LIMIT' && r.orderType !== 'MARKET') throw new AdapterError('UNSUPPORTED', `${r.orderType} not supported on CoinDCX spot adapter`);
    const body: Record<string, unknown> = {
      side: r.side === 'BUY' ? 'buy' : 'sell', order_type: r.orderType === 'LIMIT' ? 'limit_order' : 'market_order', market: r.symbol,
      total_quantity: r.qty, client_order_id: r.clientOrderId,
    };
    if (r.orderType === 'LIMIT') body.price_per_unit = r.limitPrice;
    const res = await this.signed<{ orders?: CdxOrder[] }>('/exchange/v1/orders/create', body, { isOrderPlacement: true });
    const o = res.orders?.[0];
    if (!o?.id) throw new AdapterError('NETWORK', 'CoinDCX response missing order id — treating outcome as unknown');
    return { brokerOrderId: String(o.id), status: mapCoindcxStatus(o.status, o.total_quantity, o.remaining_quantity) };
  }

  async cancelOrder(id: string) { await this.signed('/exchange/v1/orders/cancel', { id: Number(id) }); }

  private async state(o: CdxOrder): Promise<VenueOrderState> {
    const filled = Number(o.total_quantity) - Number(o.remaining_quantity);
    const trades = filled > 0 ? (await this.getTrades(o.created_at - 60_000, o.market)).filter((t) => t.brokerOrderId === String(o.id)) : [];
    return {
      brokerOrderId: String(o.id), clientOrderId: o.client_order_id, status: mapCoindcxStatus(o.status, Number(o.total_quantity), Number(o.remaining_quantity)),
      qty: Number(o.total_quantity), filledQty: filled, avgPrice: Number(o.avg_price) || undefined, trades, updatedAt: o.updated_at,
    };
  }

  async getOrder(id: string) { return this.state(await this.signed<CdxOrder>('/exchange/v1/orders/status', { id: Number(id) })); }

  async findOrderByClientId(cid: string) {
    try { return await this.state(await this.signed<CdxOrder>('/exchange/v1/orders/status', { client_order_id: cid })); }
    catch (e) { if (e instanceof AdapterError && (e.kind === 'INVALID' || e.kind === 'REJECTED')) return undefined; throw e; }
  }

  async getTrades(sinceTs = 0, symbol?: string): Promise<VenueTrade[]> {
    const body: Record<string, unknown> = { limit: 500, sort: 'asc', from_timestamp: sinceTs };
    if (symbol) body.symbol = symbol;
    const t = await this.signed<CdxTrade[]>('/exchange/v1/orders/trade_history', body);
    return t.map((x) => ({
      venueTradeId: String(x.id), brokerOrderId: String(x.order_id), symbol: x.symbol, side: x.side === 'buy' ? 'BUY' as const : 'SELL' as const,
      qty: Number(x.quantity), price: Number(x.price), ts: x.timestamp, feesPaise: toPaise(Number(x.fee_amount)),
    }));
  }
}
