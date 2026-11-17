// Seed instrument catalogue for SIMULATION ONLY. In paper/production the
// instrument metadata (tick size, lot size, minimum quantity/notional) MUST be
// loaded from the broker/exchange: Kite `/instruments` dump, CoinDCX
// `/exchange/v1/markets_details`. NSE tick sizes changed in 2025 for low-priced
// stocks, so never trust these seed values for real orders.
// Sector membership follows NSE sectoral indices; verify against current index
// constituents before use.

import { toPaise } from './money.ts';
import type { Instrument } from './types.ts';
import type { SyntheticSymbol } from './marketData.ts';

const eq = (symbol: string, sector: string): Instrument => ({
  symbol, venue: 'KITE', assetClass: 'EQUITY', exchange: 'NSE', tickSize: 0.05, lotSize: 1, minQty: 1, qtyDecimals: 0,
  minNotionalPaise: 0, sector, fnoEligible: true,
});
const cx = (symbol: string, minQty: number, qtyDecimals: number, tick: number): Instrument => ({
  symbol, venue: 'COINDCX', assetClass: 'CRYPTO', exchange: 'COINDCX', tickSize: tick, lotSize: 1, minQty, qtyDecimals,
  minNotionalPaise: toPaise(100), sector: 'CRYPTO',
});

export const SEED_INSTRUMENTS: Instrument[] = [
  eq('INFY', 'IT'), eq('HCLTECH', 'IT'), eq('TECHM', 'IT'), eq('WIPRO', 'IT'),
  eq('ICICIBANK', 'BANK'), eq('SBIN', 'BANK'), eq('AXISBANK', 'BANK'),
  eq('TATASTEEL', 'METAL'), eq('HINDALCO', 'METAL'), eq('JSWSTEEL', 'METAL'),
  eq('ITC', 'FMCG'), eq('DABUR', 'FMCG'),
  eq('CIPLA', 'PHARMA'), eq('SUNPHARMA', 'PHARMA'),
  cx('BTCINR', 0.00001, 6, 1), cx('ETHINR', 0.0001, 5, 1), cx('SOLINR', 0.001, 4, 0.1),
];

export const SECTOR_INDEX: Record<string, string> = {
  IT: 'NIFTY IT', BANK: 'NIFTY BANK', METAL: 'NIFTY METAL', FMCG: 'NIFTY FMCG', PHARMA: 'NIFTY PHARMA', AUTO: 'NIFTY AUTO', CRYPTO: 'BTCINR',
};

/** Synthetic starting prices — arbitrary, NOT real market prices. */
export const SYNTHETIC_UNIVERSE: SyntheticSymbol[] = [
  { symbol: 'INFY', venue: 'KITE', start: 1500, vol: 0.0025, tick: 0.05, session: 'NSE' },
  { symbol: 'HCLTECH', venue: 'KITE', start: 1400, vol: 0.0025, tick: 0.05, session: 'NSE' },
  { symbol: 'TECHM', venue: 'KITE', start: 1300, vol: 0.003, tick: 0.05, session: 'NSE' },
  { symbol: 'WIPRO', venue: 'KITE', start: 260, vol: 0.003, tick: 0.05, session: 'NSE' },
  { symbol: 'ICICIBANK', venue: 'KITE', start: 1250, vol: 0.0022, tick: 0.05, session: 'NSE' },
  { symbol: 'SBIN', venue: 'KITE', start: 780, vol: 0.0025, tick: 0.05, session: 'NSE' },
  { symbol: 'AXISBANK', venue: 'KITE', start: 1100, vol: 0.0027, tick: 0.05, session: 'NSE' },
  { symbol: 'TATASTEEL', venue: 'KITE', start: 150, vol: 0.0035, tick: 0.05, session: 'NSE' },
  { symbol: 'HINDALCO', venue: 'KITE', start: 650, vol: 0.0033, tick: 0.05, session: 'NSE' },
  { symbol: 'JSWSTEEL', venue: 'KITE', start: 950, vol: 0.003, tick: 0.05, session: 'NSE' },
  { symbol: 'ITC', venue: 'KITE', start: 420, vol: 0.002, tick: 0.05, session: 'NSE' },
  { symbol: 'DABUR', venue: 'KITE', start: 500, vol: 0.0022, tick: 0.05, session: 'NSE' },
  { symbol: 'CIPLA', venue: 'KITE', start: 1450, vol: 0.0025, tick: 0.05, session: 'NSE' },
  { symbol: 'SUNPHARMA', venue: 'KITE', start: 1700, vol: 0.0023, tick: 0.05, session: 'NSE' },
  { symbol: 'NIFTY 50', venue: 'KITE', start: 24000, vol: 0.0015, tick: 0.05, session: 'NSE' },
  { symbol: 'NIFTY IT', venue: 'KITE', start: 36000, vol: 0.002, tick: 0.05, session: 'NSE' },
  { symbol: 'NIFTY BANK', venue: 'KITE', start: 52000, vol: 0.0018, tick: 0.05, session: 'NSE' },
  { symbol: 'NIFTY METAL', venue: 'KITE', start: 9000, vol: 0.0025, tick: 0.05, session: 'NSE' },
  { symbol: 'NIFTY FMCG', venue: 'KITE', start: 56000, vol: 0.0015, tick: 0.05, session: 'NSE' },
  { symbol: 'NIFTY PHARMA', venue: 'KITE', start: 21000, vol: 0.0018, tick: 0.05, session: 'NSE' },
  { symbol: 'BTCINR', venue: 'COINDCX', start: 8_000_000, vol: 0.004, tick: 1, session: '24x7' },
  { symbol: 'ETHINR', venue: 'COINDCX', start: 300_000, vol: 0.005, tick: 1, session: '24x7' },
  { symbol: 'SOLINR', venue: 'COINDCX', start: 15_000, vol: 0.006, tick: 0.1, session: '24x7' },
];
