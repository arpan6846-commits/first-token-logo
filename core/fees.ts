// Transaction-cost model. These are ESTIMATES used for pre-trade validation and
// paper/simulated fills. Production fills use broker-reported charges (contract
// note / trade book) whenever available; the fill records `feesSource`.
// Every rate below is configurable and MUST be re-verified against the current
// Zerodha / CoinDCX charge sheets before live trading (see docs/COMPLIANCE.md).

import { notionalPaise, type Paise } from './money.ts';
import type { AssetClass, Side } from './types.ts';

export interface EquityDeliveryFeeConfig {
  brokeragePct: number;          // Zerodha equity delivery: 0
  brokerageCapPaise: Paise;
  sttPct: number;                // STT on delivery: 0.1% on buy and sell
  exchangeTxnPct: number;        // NSE transaction charge
  sebiPerCrorePaise: Paise;      // SEBI turnover fee ₹10 / crore
  stampBuyPct: number;           // stamp duty on buy (delivery 0.015%)
  gstPct: number;                // 18% on brokerage + exchange + SEBI
  dpChargePerSellPaise: Paise;   // depository charge per scrip per sell day (incl. GST)
}

export interface CryptoSpotFeeConfig {
  tradingFeePct: number;         // venue maker/taker fee
  gstPct: number;                // 18% GST on the fee
  tdsPct: number;                // 1% TDS on sale consideration (section 194S)
}

export interface FeeConfig {
  equity: EquityDeliveryFeeConfig;
  crypto: CryptoSpotFeeConfig;
  slippageBps: { equity: number; crypto: number };
}

export const DEFAULT_FEES: FeeConfig = {
  equity: {
    brokeragePct: 0,
    brokerageCapPaise: 2000,
    sttPct: 0.1,
    exchangeTxnPct: 0.00297,
    sebiPerCrorePaise: 1000,
    stampBuyPct: 0.015,
    gstPct: 18,
    dpChargePerSellPaise: 1593,
  },
  crypto: { tradingFeePct: 0.5, gstPct: 18, tdsPct: 1 },
  slippageBps: { equity: 5, crypto: 10 },
};

export interface FeeBreakdown {
  totalPaise: Paise;             // charges that reduce cash (excludes TDS)
  tdsPaise: Paise;               // withheld tax, claimable — tracked as receivable, not expense
  parts: Record<string, Paise>;
}

export function estimateFees(assetClass: AssetClass, side: Side, qty: number, price: number, cfg: FeeConfig = DEFAULT_FEES): FeeBreakdown {
  const value = notionalPaise(qty, price);
  if (assetClass === 'EQUITY') {
    const c = cfg.equity;
    const brokerage = Math.min(Math.round((value * c.brokeragePct) / 100), c.brokerageCapPaise);
    const stt = Math.round((value * c.sttPct) / 100);
    const exch = Math.round((value * c.exchangeTxnPct) / 100);
    const sebi = Math.round((value * c.sebiPerCrorePaise) / 1_00_00_000_00);
    const stamp = side === 'BUY' ? Math.round((value * c.stampBuyPct) / 100) : 0;
    const gst = Math.round(((brokerage + exch + sebi) * c.gstPct) / 100);
    const dp = side === 'SELL' ? c.dpChargePerSellPaise : 0;
    const parts = { brokerage, stt, exchange: exch, sebi, stamp, gst, dp };
    return { totalPaise: brokerage + stt + exch + sebi + stamp + gst + dp, tdsPaise: 0, parts };
  }
  const c = cfg.crypto;
  const fee = Math.round((value * c.tradingFeePct) / 100);
  const gst = Math.round((fee * c.gstPct) / 100);
  const tds = side === 'SELL' ? Math.round((value * c.tdsPct) / 100) : 0;
  return { totalPaise: fee + gst, tdsPaise: tds, parts: { fee, gst } };
}

/** Round-trip cost of buying then selling the same quantity (entry at `entry`, exit at `exit`). */
export function roundTripCost(assetClass: AssetClass, qty: number, entry: number, exit: number, cfg: FeeConfig = DEFAULT_FEES): Paise {
  return estimateFees(assetClass, 'BUY', qty, entry, cfg).totalPaise + estimateFees(assetClass, 'SELL', qty, exit, cfg).totalPaise;
}

export function estimateSlippage(assetClass: AssetClass, qty: number, price: number, spread?: number, cfg: FeeConfig = DEFAULT_FEES): Paise {
  const bps = assetClass === 'EQUITY' ? cfg.slippageBps.equity : cfg.slippageBps.crypto;
  const halfSpread = spread && spread > 0 ? notionalPaise(qty, spread / 2) : 0;
  return Math.max(halfSpread, Math.round((notionalPaise(qty, price) * bps) / 10_000));
}
