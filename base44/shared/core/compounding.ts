// Compounding engine.
//  - Only VERIFIED (reconciled) and SETTLED realized results count.
//  - Fees, estimated tax and losses reduce the eligible amount.
//  - Unrealized gains never count.
//  - A high-water mark means losses must be recovered before anything new is compounded.
//  - Compounding is an equity reclassification (retained → reinvested/reserve):
//    it can never create money, so net equity is unchanged by it.

import { newId } from './hash.ts';
import { Accounts, lines, type Ledger } from './ledger.ts';
import type { Paise } from './money.ts';
import type { CompoundingEvent, DataSource, Environment, StrategySettings, TradeFill } from './types.ts';

export interface EligibleProfit {
  realizedGrossPaise: Paise;
  feesPaise: Paise;
  taxProvisionPaise: Paise;
  netPaise: Paise;
  byVenue: Record<string, Paise>;
  excluded: { unreconciled: number; unsettled: number };
}

/**
 * Tax provision estimate (VERIFY with a tax adviser):
 *  - Crypto (VDA): flat rate on each profitable sale, losses NOT set off.
 *  - Equity sold the same day as bought: speculative (slab) rate on net gain.
 *  - Equity delivery: short-term capital gains rate on net gain.
 */
export function estimateTaxProvision(fills: TradeFill[], rates: StrategySettings['taxRates']): Paise {
  let crypto = 0, intraday = 0, delivery = 0;
  const buyDates = new Map<string, Set<string>>();
  for (const f of fills) if (f.side === 'BUY') {
    const d = new Date(f.ts + 330 * 60_000).toISOString().slice(0, 10);
    if (!buyDates.has(f.symbol)) buyDates.set(f.symbol, new Set());
    buyDates.get(f.symbol)!.add(d);
  }
  for (const f of fills) {
    if (f.side !== 'SELL' || f.realizedPnlPaise === undefined) continue;
    if (f.assetClass === 'CRYPTO') { crypto += Math.max(0, f.realizedPnlPaise); continue; }
    const d = new Date(f.ts + 330 * 60_000).toISOString().slice(0, 10);
    if (buyDates.get(f.symbol)?.has(d)) intraday += f.realizedPnlPaise - f.feesPaise; else delivery += f.realizedPnlPaise - f.feesPaise;
  }
  return Math.round((crypto * rates.cryptoGainPct) / 100 + (Math.max(0, intraday) * rates.equityIntradayPct) / 100 + (Math.max(0, delivery) * rates.equityStcgPct) / 100);
}

export function eligibleProfit(fills: TradeFill[], asOfDate: string, rates: StrategySettings['taxRates']): EligibleProfit {
  const ok = fills.filter((f) => f.reconciled && f.settlementDate <= asOfDate);
  const excluded = { unreconciled: fills.filter((f) => !f.reconciled).length, unsettled: fills.filter((f) => f.reconciled && f.settlementDate > asOfDate).length };
  const byVenue: Record<string, Paise> = {};
  let gross = 0, fees = 0;
  for (const f of ok) {
    const r = f.side === 'SELL' ? f.realizedPnlPaise ?? 0 : 0;
    gross += r; fees += f.feesPaise;
    byVenue[f.venue] = (byVenue[f.venue] ?? 0) + r - f.feesPaise;
  }
  const tax = estimateTaxProvision(ok, rates);
  return { realizedGrossPaise: gross, feesPaise: fees, taxProvisionPaise: tax, netPaise: gross - fees - tax, byVenue, excluded };
}

/** Adjusts the tax-reserve liability to the current estimate (idempotent per date). */
export async function postTaxProvision(ledger: Ledger, env: Environment, date: string, targetPaise: Paise, currentReservePaise: Paise, source: DataSource) {
  const delta = targetPaise - currentReservePaise;
  if (delta === 0) return undefined;
  return ledger.post({
    environment: env, type: delta > 0 ? 'TAX_PROVISION' : 'TAX_RELEASE', idempotencyKey: `tax:${date}`, source,
    memo: `Tax reserve ${delta > 0 ? 'increase' : 'release'} to estimated ₹${targetPaise / 100} (estimate, not a tax filing)`,
    lines: lines([Accounts.taxProvision, delta], [Accounts.taxReserve, -delta]),
  });
}

export interface CompoundingDecision {
  event: CompoundingEvent;
  newHighWaterPaise: Paise;
}

export function decideCompounding(env: Environment, date: string, eligible: EligibleProfit, highWaterPaise: Paise, reinvestPct: number, now: number): CompoundingDecision {
  const newProfit = eligible.netPaise - highWaterPaise;
  if (newProfit <= 0) {
    return {
      newHighWaterPaise: highWaterPaise,
      event: {
        id: newId('cmp', now), environment: env, date, cumEligibleNetPaise: eligible.netPaise, previousHighWaterPaise: highWaterPaise,
        newProfitPaise: 0, reinvestPct, reinvestedPaise: 0, toReservePaise: 0, byVenue: {}, status: 'NOTHING_ELIGIBLE', createdAt: now,
        note: eligible.netPaise < highWaterPaise
          ? `Net eligible ₹${eligible.netPaise / 100} is below the high-water mark ₹${highWaterPaise / 100}: losses must be recovered first`
          : 'No new verified, settled profit since the last compounding',
      },
    };
  }
  const reinvest = Math.floor((newProfit * reinvestPct) / 100);
  const toReserve = newProfit - reinvest;
  const positive = Object.entries(eligible.byVenue).filter(([, v]) => v > 0);
  const posTotal = positive.reduce((s, [, v]) => s + v, 0) || 1;
  const byVenue: Record<string, Paise> = {};
  let assigned = 0;
  positive.forEach(([k, v], i) => { const share = i === positive.length - 1 ? reinvest - assigned : Math.floor((reinvest * v) / posTotal); byVenue[k] = share; assigned += share; });
  return {
    newHighWaterPaise: eligible.netPaise,
    event: {
      id: newId('cmp', now), environment: env, date, cumEligibleNetPaise: eligible.netPaise, previousHighWaterPaise: highWaterPaise,
      newProfitPaise: newProfit, reinvestPct, reinvestedPaise: reinvest, toReservePaise: toReserve, byVenue, status: 'COMPOUNDED', createdAt: now,
      note: `₹${newProfit / 100} new verified settled profit after fees and estimated tax: ₹${reinvest / 100} reinvested (${reinvestPct}%), ₹${toReserve / 100} to profit reserve`,
    },
  };
}

export async function postCompounding(ledger: Ledger, ev: CompoundingEvent, source: DataSource) {
  if (ev.status !== 'COMPOUNDED' || ev.newProfitPaise <= 0) return undefined;
  return ledger.post({
    environment: ev.environment, type: 'COMPOUNDING', idempotencyKey: `compound:${ev.date}`, source, refType: 'CompoundingEvent', refId: ev.id,
    memo: ev.note,
    lines: lines([Accounts.retained, ev.newProfitPaise], [Accounts.reinvested, -ev.reinvestedPaise], ['EQUITY:PROFIT_RESERVE', -ev.toReservePaise]),
  });
}
