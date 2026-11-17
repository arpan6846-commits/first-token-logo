// Positions are rebuilt deterministically from fills (FIFO lots). Equity comes
// from ledger balances plus marked holdings, minus liabilities.

import { Accounts, sumPrefix } from './ledger.ts';
import { notionalPaise, type Paise } from './money.ts';
import type { AssetClass, DataSource, Quote, TradeFill, Venue } from './types.ts';

export interface Lot { qty: number; price: number; costPaise: Paise; ts: number; fillId: string }

export interface Position {
  key: string;
  venue: Venue;
  symbol: string;
  assetClass: AssetClass;
  qty: number;
  costPaise: Paise;
  avgPrice: number;
  lots: Lot[];
  markPrice?: number;
  markSource?: DataSource;
  markTs?: number;
  marketValuePaise: Paise;
  unrealizedPaise: Paise;
}

export const posKey = (venue: Venue, symbol: string) => `${venue}:${symbol}`;
const EPS = 1e-9;

/** Removes `qty` from the FIFO lots and returns the cost basis consumed. */
export function consumeFifo(lots: Lot[], qty: number): { costPaise: Paise; remaining: Lot[] } {
  let need = qty, cost = 0;
  const remaining = lots.map((l) => ({ ...l }));
  while (need > EPS && remaining.length) {
    const lot = remaining[0];
    const take = Math.min(lot.qty, need);
    const c = take >= lot.qty - EPS ? lot.costPaise : Math.round((lot.costPaise * take) / lot.qty);
    cost += c;
    lot.qty -= take; lot.costPaise -= c; need -= take;
    if (lot.qty <= EPS) remaining.shift();
  }
  if (need > EPS) throw new Error(`Sell quantity exceeds holdings by ${need} — short selling is not allowed`);
  return { costPaise: cost, remaining };
}

export function buildPositions(fills: TradeFill[]): Map<string, Position> {
  const m = new Map<string, Position>();
  const sorted = [...fills].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  for (const f of sorted) {
    const k = posKey(f.venue, f.symbol);
    let p = m.get(k);
    if (!p) { p = { key: k, venue: f.venue, symbol: f.symbol, assetClass: f.assetClass, qty: 0, costPaise: 0, avgPrice: 0, lots: [], marketValuePaise: 0, unrealizedPaise: 0 }; m.set(k, p); }
    if (f.side === 'BUY') {
      p.lots.push({ qty: f.qty, price: f.price, costPaise: notionalPaise(f.qty, f.price), ts: f.ts, fillId: f.id });
    } else {
      p.lots = consumeFifo(p.lots, f.qty).remaining;
    }
    p.qty = p.lots.reduce((s, l) => s + l.qty, 0);
    p.costPaise = p.lots.reduce((s, l) => s + l.costPaise, 0);
    p.avgPrice = p.qty > EPS ? p.costPaise / 100 / p.qty : 0;
  }
  for (const [k, p] of m) if (p.qty <= EPS) m.delete(k);
  return m;
}

export function markPositions(positions: Map<string, Position>, quotes: Map<string, Quote>): { complete: boolean; sources: DataSource[] } {
  let complete = true;
  const sources = new Set<DataSource>();
  for (const p of positions.values()) {
    const q = quotes.get(posKey(p.venue, p.symbol)) ?? quotes.get(p.symbol);
    if (q && Number.isFinite(q.ltp) && q.ltp > 0) {
      p.markPrice = q.ltp; p.markSource = q.source; p.markTs = q.exchangeTs;
      p.marketValuePaise = notionalPaise(p.qty, q.ltp);
      sources.add(q.source);
    } else {
      complete = false;
      p.markPrice = undefined; p.markSource = undefined;
      p.marketValuePaise = p.costPaise; // fall back to cost and flag incomplete
    }
    p.unrealizedPaise = p.marketValuePaise - p.costPaise;
  }
  return { complete, sources: [...sources] };
}

export interface EquityView {
  cashPaise: Paise;
  cashByVenue: Record<string, Paise>;
  holdingsCostPaise: Paise;
  marketValuePaise: Paise;
  unrealizedPaise: Paise;
  realizedPaise: Paise;
  feesPaise: Paise;
  taxReservePaise: Paise;
  tdsReceivablePaise: Paise;
  netEquityPaise: Paise;
  netContributionsPaise: Paise;
  reinvestedPaise: Paise;
  exposureByClass: Record<AssetClass, Paise>;
  marksComplete: boolean;
  markSources: DataSource[];
}

export function equityView(balances: Map<string, Paise>, positions: Map<string, Position>, quotes: Map<string, Quote>): EquityView {
  const { complete, sources } = markPositions(positions, quotes);
  const cashByVenue: Record<string, Paise> = {};
  for (const [k, v] of balances) if (k.startsWith('ASSET:CASH:')) cashByVenue[k.slice('ASSET:CASH:'.length)] = v;
  const cash = sumPrefix(balances, 'ASSET:CASH:');
  const mv = [...positions.values()].reduce((s, p) => s + p.marketValuePaise, 0);
  const cost = [...positions.values()].reduce((s, p) => s + p.costPaise, 0);
  const tds = balances.get(Accounts.tdsReceivable) ?? 0;
  const taxReserve = -(balances.get(Accounts.taxReserve) ?? 0);
  const exposureByClass: Record<AssetClass, Paise> = { EQUITY: 0, CRYPTO: 0 };
  for (const p of positions.values()) exposureByClass[p.assetClass] += p.marketValuePaise;
  return {
    cashPaise: cash,
    cashByVenue,
    holdingsCostPaise: cost,
    marketValuePaise: mv,
    unrealizedPaise: mv - cost,
    realizedPaise: -sumPrefix(balances, 'INCOME:REALIZED:'),
    feesPaise: sumPrefix(balances, 'EXPENSE:FEES:'),
    taxReservePaise: taxReserve,
    tdsReceivablePaise: tds,
    netEquityPaise: cash + mv + tds - taxReserve,
    netContributionsPaise: -(balances.get(Accounts.contributed) ?? 0) - (balances.get(Accounts.withdrawn) ?? 0),
    reinvestedPaise: -(balances.get(Accounts.reinvested) ?? 0),
    exposureByClass,
    marksComplete: complete,
    markSources: sources,
  };
}
