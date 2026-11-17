// Paper / simulation venue. Fills are computed from supplied quotes (live
// read-only quotes in the paper environment, synthetic quotes in simulation).
// Scenario hooks let tests force partial fills, rejections and timeouts.

import { estimateFees } from '../fees.ts';
import { newId } from '../hash.ts';
import type { AssetClass, Candle, DataSource, Quote, Timeframe, Venue } from '../types.ts';
import {
  AdapterError, type AdapterCapabilities, type AdapterMode, type PlaceOrderAck, type PlaceOrderRequest, type VenueAdapter,
  type VenueBalance, type VenueHolding, type VenueOrderState, type VenueTrade,
} from './types.ts';

export type PaperScenario =
  | { kind: 'fill' }
  | { kind: 'partial'; fraction: number; thenCancel?: boolean }
  | { kind: 'reject'; reason: string }
  | { kind: 'timeout_after_accept' }   // venue accepted, but our request timed out
  | { kind: 'timeout_before_accept' }  // request lost; venue never saw it
  | { kind: 'rest' };                  // leave the order open

interface PaperOrder extends VenueOrderState { req: PlaceOrderRequest }

export class PaperAdapter implements VenueAdapter {
  readonly dataSource: DataSource;
  private orders = new Map<string, PaperOrder>();
  private byClientId = new Map<string, string>();
  private scenarios: PaperScenario[] = [];
  private seq = 0;
  available = true;
  candleProvider?: (symbol: string, tf: Timeframe, from: number, to: number) => Candle[];

  constructor(
    readonly venue: Venue,
    readonly mode: AdapterMode,
    private quoteFn: (symbol: string) => Quote | undefined,
    private assetClassOf: (symbol: string) => AssetClass,
    private clock: () => number = Date.now,
    private opts: { slippageBps?: number; cashPaise?: () => number; holdings?: () => VenueHolding[] } = {},
  ) {
    this.dataSource = mode === 'PAPER' ? 'PAPER_FEED' : 'SIMULATED';
  }

  queueScenario(...s: PaperScenario[]) { this.scenarios.push(...s); }

  capabilities(): AdapterCapabilities {
    return {
      venue: this.venue, mode: this.mode, orderTypes: ['LIMIT', 'MARKET'], products: ['CNC', 'SPOT'],
      supportsWebSocket: false, supportsClientOrderId: true, supportsPostbacks: false, spotOnly: true,
      leverageDisabled: true, withdrawalsViaApi: false,
      notes: [`${this.mode} venue — fills are simulated from ${this.dataSource} quotes and never touch real money`],
    };
  }

  async health() { return { ok: this.available, latencyMs: 0, message: this.available ? 'paper venue up' : 'paper venue marked unavailable' }; }
  async getQuotes(symbols: string[]) { return symbols.map((s) => this.quoteFn(s)).filter((q): q is Quote => !!q); }
  async getCandles(symbol: string, tf: Timeframe, from: number, to: number) { return this.candleProvider?.(symbol, tf, from, to) ?? []; }
  async getBalance(): Promise<VenueBalance> { return { cashPaise: this.opts.cashPaise?.() ?? 0, asOf: this.clock() }; }
  async getHoldings(): Promise<VenueHolding[]> { return this.opts.holdings?.() ?? []; }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderAck> {
    if (!this.available) throw new AdapterError('UNAVAILABLE', 'Paper venue unavailable');
    if (this.byClientId.has(req.clientOrderId)) throw new AdapterError('REJECTED', `Duplicate client order id ${req.clientOrderId}`);
    if (req.product !== 'CNC' && req.product !== 'SPOT') throw new AdapterError('REJECTED', 'Only CNC/SPOT supported');
    const sc = this.scenarios.shift() ?? { kind: 'fill' };
    if (sc.kind === 'timeout_before_accept') throw new AdapterError('TIMEOUT', 'Simulated timeout before venue accepted');
    const id = `${this.venue === 'COINDCX' ? 'CDX' : 'PPR'}${++this.seq}${newId('').slice(-6)}`;
    const o: PaperOrder = { brokerOrderId: id, clientOrderId: req.clientOrderId, status: 'OPEN', qty: req.qty, filledQty: 0, trades: [], updatedAt: this.clock(), req };
    this.orders.set(id, o);
    this.byClientId.set(req.clientOrderId, id);
    if (sc.kind === 'reject') { o.status = 'REJECTED'; o.rejectionReason = sc.reason; return { brokerOrderId: id, status: 'REJECTED' }; }
    if (sc.kind === 'partial') {
      this.fill(o, decimalsFloor(req.qty * sc.fraction, this.assetClassOf(req.symbol)));
      if (sc.thenCancel) { o.status = 'CANCELLED'; }
    } else if (sc.kind === 'fill' || sc.kind === 'timeout_after_accept') {
      this.tryFill(o);
    }
    if (sc.kind === 'timeout_after_accept') throw new AdapterError('TIMEOUT', 'Simulated timeout after venue accepted');
    return { brokerOrderId: id, status: o.status };
  }

  /** Attempt to fill resting orders against the latest quote. */
  processQuotes() { for (const o of this.orders.values()) if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') this.tryFill(o); }

  private tryFill(o: PaperOrder) {
    const q = this.quoteFn(o.req.symbol);
    if (!q) return;
    const px = o.req.side === 'BUY' ? q.ask ?? q.ltp : q.bid ?? q.ltp;
    const marketable = o.req.orderType === 'MARKET' || (o.req.side === 'BUY' ? px <= (o.req.limitPrice ?? 0) : px >= (o.req.limitPrice ?? Infinity));
    if (marketable) this.fill(o, o.qty - o.filledQty);
  }

  private fill(o: PaperOrder, qty: number) {
    if (qty <= 0) return;
    const q = this.quoteFn(o.req.symbol);
    const base = o.req.orderType === 'LIMIT' && o.req.limitPrice ? o.req.limitPrice : (q?.ltp ?? o.req.limitPrice ?? 0);
    const slip = (this.opts.slippageBps ?? 0) / 10_000;
    const price = o.req.side === 'BUY' ? Math.min(base * (1 + slip), o.req.limitPrice ?? Infinity) : Math.max(base * (1 - slip), o.req.limitPrice ?? 0);
    const ac = this.assetClassOf(o.req.symbol);
    const fb = estimateFees(ac, o.req.side, qty, price);
    const t: VenueTrade = {
      venueTradeId: `T${o.brokerOrderId}-${o.trades.length + 1}`, brokerOrderId: o.brokerOrderId, symbol: o.req.symbol,
      side: o.req.side, qty, price: round(price), ts: this.clock(), feesPaise: fb.totalPaise, tdsPaise: fb.tdsPaise,
    };
    o.trades.push(t);
    o.filledQty = round(o.filledQty + qty, 8);
    o.avgPrice = o.trades.reduce((s, x) => s + x.qty * x.price, 0) / o.filledQty;
    o.status = o.filledQty + 1e-12 >= o.qty ? 'FILLED' : 'PARTIALLY_FILLED';
    o.updatedAt = this.clock();
  }

  async cancelOrder(id: string) {
    const o = this.orders.get(id);
    if (!o) throw new AdapterError('INVALID', `Unknown order ${id}`);
    if (o.status === 'OPEN' || o.status === 'PARTIALLY_FILLED') { o.status = 'CANCELLED'; o.updatedAt = this.clock(); }
  }
  async getOrder(id: string): Promise<VenueOrderState> {
    const o = this.orders.get(id);
    if (!o) throw new AdapterError('INVALID', `Unknown order ${id}`);
    const { req: _r, ...state } = o;
    return structuredClone(state);
  }
  async findOrderByClientId(cid: string) {
    const id = this.byClientId.get(cid);
    return id ? this.getOrder(id) : undefined;
  }
  async getTrades(sinceTs = 0) { return [...this.orders.values()].flatMap((o) => o.trades).filter((t) => t.ts >= sinceTs); }
}

function round(x: number, d = 4) { const f = 10 ** d; return Math.round(x * f) / f; }
function decimalsFloor(q: number, ac: AssetClass) { return ac === 'EQUITY' ? Math.floor(q) : Math.floor(q * 1e6) / 1e6; }
