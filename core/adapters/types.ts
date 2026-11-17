// Common venue adapter interface implemented by KiteAdapter (NSE/BSE via Kite
// Connect), CoinDCXAdapter (crypto spot) and PaperAdapter (simulation/paper).

import type { Paise } from '../money.ts';
import type { Candle, DataSource, Environment, OrderType, Quote, Side, Timeframe, Venue } from '../types.ts';

export type AdapterMode = 'LIVE' | 'PAPER' | 'SIMULATION';

export interface AdapterCapabilities {
  venue: Venue;
  mode: AdapterMode;
  orderTypes: OrderType[];
  products: ('CNC' | 'SPOT')[];
  supportsWebSocket: boolean;
  supportsClientOrderId: boolean;  // needed for duplicate-safe retries
  supportsPostbacks: boolean;
  spotOnly: boolean;
  leverageDisabled: boolean;
  withdrawalsViaApi: boolean;      // must be false / disabled on the key
  notes: string[];
}

export interface PlaceOrderRequest {
  symbol: string;
  exchange: string;
  side: Side;
  qty: number;
  orderType: OrderType;
  product: 'CNC' | 'SPOT';
  limitPrice?: number;
  triggerPrice?: number;
  clientOrderId: string;
}

export type VenueOrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'PENDING';

export interface VenueTrade {
  venueTradeId: string;
  brokerOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  ts: number;
  feesPaise?: Paise;
  tdsPaise?: Paise;
}

export interface VenueOrderState {
  brokerOrderId: string;
  clientOrderId?: string;
  status: VenueOrderStatus;
  qty: number;
  filledQty: number;
  avgPrice?: number;
  rejectionReason?: string;
  trades: VenueTrade[];
  updatedAt: number;
}

export interface PlaceOrderAck { brokerOrderId: string; status: VenueOrderStatus; raw?: unknown }

export interface VenueBalance { cashPaise: Paise; raw?: unknown; asOf: number }
export interface VenueHolding { symbol: string; qty: number; avgPrice: number }

export type AdapterErrorKind = 'NETWORK' | 'TIMEOUT' | 'AUTH' | 'REJECTED' | 'RATE_LIMIT' | 'UNSUPPORTED' | 'INVALID' | 'UNAVAILABLE';

export class AdapterError extends Error {
  override name = 'AdapterError';
  constructor(public kind: AdapterErrorKind, message: string, public raw?: unknown) { super(message); }
  /** True when we cannot know whether the venue accepted the order. */
  get outcomeUnknown() { return this.kind === 'NETWORK' || this.kind === 'TIMEOUT'; }
}

export type MarketEvent =
  | { type: 'quote'; quote: Quote }
  | { type: 'order'; state: VenueOrderState }
  | { type: 'status'; connected: boolean; message: string };

export interface VenueAdapter {
  readonly venue: Venue;
  readonly mode: AdapterMode;
  readonly dataSource: DataSource;
  capabilities(): AdapterCapabilities;
  health(): Promise<{ ok: boolean; latencyMs: number; message: string }>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getCandles(symbol: string, tf: Timeframe, from: number, to: number): Promise<Candle[]>;
  getBalance(): Promise<VenueBalance>;
  getHoldings(): Promise<VenueHolding[]>;
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderAck>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  getOrder(brokerOrderId: string): Promise<VenueOrderState>;
  findOrderByClientId(clientOrderId: string): Promise<VenueOrderState | undefined>;
  getTrades(sinceTs?: number): Promise<VenueTrade[]>;
  subscribe?(symbols: string[], onEvent: (e: MarketEvent) => void): () => void;
}

/** The adapter mode each environment is allowed to place orders with. */
export function adapterAllowedFor(env: Environment, mode: AdapterMode): boolean {
  if (env === 'production') return mode === 'LIVE';
  if (env === 'paper') return mode === 'PAPER';
  return mode === 'SIMULATION' || mode === 'PAPER';
}
