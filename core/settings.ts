// Strategy settings, hard safety ceilings and change governance.
// - Only the owner can change settings; AI/system/worker actors are refused.
// - Any change to a risk field requires an explicit typed confirmation.
// - Loosening a risk limit never takes effect intraday: it is scheduled for the
//   next IST trading day, so a losing day cannot be "fixed" by raising limits.
// - Hard ceilings cannot be exceeded even by the owner.

import { toPaise } from './money.ts';
import type { Actor, Environment, StrategySettings } from './types.ts';

export const RISK_CONFIRMATION_PHRASE = 'I CONFIRM THIS RISK CHANGE';

export const HARD_LIMITS = {
  maxRiskPerTradePct: 1,        // never risk more than 1% of equity on one trade
  dailyLossStopPct: 2,
  weeklyLossStopPct: 5,
  maxOpenExposurePct: 100,      // 100% = fully invested cash, never leverage
  dailyRiskBudgetPct: 1,        // prop desk: daily risk never > 1%
  maxTradesPerSector: 3,
  maxRangeTradePct: 20,
  reinvestPctMax: 100,
} as const;

/** Fields where a larger value means more risk. */
const LOOSEN_IF_HIGHER: (keyof StrategySettings)[] = [
  'maxRiskPerTradePct', 'dailyLossStopPct', 'weeklyLossStopPct', 'maxOpenExposurePct',
  'dailyRiskBudgetPct', 'maxFeeToRiskPct', 'maxQuoteAgeMs', 'maxCandleLagMultiple',
  'maxReconciliationAgeMs', 'maxTradesPerSector', 'maxRangeTradePct', 'consecutiveLossCooldown',
];
/** Fields where a smaller value means more risk. */
const LOOSEN_IF_LOWER: (keyof StrategySettings)[] = ['minRewardRisk'];

export const RISK_FIELDS: (keyof StrategySettings)[] = [
  ...LOOSEN_IF_HIGHER, ...LOOSEN_IF_LOWER, 'executionMode', 'liveTradingEnabled', 'allocation', 'phase',
];

export function defaultSettings(environment: Environment, now = Date.now()): StrategySettings {
  return {
    id: `settings_${environment}`,
    version: 1,
    environment,
    initialCapitalPaise: toPaise(10_000),
    allocation: { stocksPaise: toPaise(5_000), cryptoPaise: toPaise(2_000), reservePaise: toPaise(3_000) },
    maxRiskPerTradePct: 0.5,
    dailyLossStopPct: 1,
    weeklyLossStopPct: 3,
    maxOpenExposurePct: 50,
    dailyRiskBudgetPct: 0.5,
    minRewardRisk: 2,
    maxFeeToRiskPct: 25,
    maxQuoteAgeMs: 15_000,
    maxCandleLagMultiple: 2,
    maxReconciliationAgeMs: 6 * 60 * 60 * 1000,
    reinvestPct: 50,
    dailyTargetPct: 10,
    maxTradesPerSector: 2,
    maxRangeTradePct: 20,
    equityPriceMin: 100,
    equityPriceMax: 4000,
    minTimeframe: '5m',
    stockTimeframe: '15m',
    cryptoTimeframe: '1h',
    executionMode: 'manual_approval',
    liveTradingEnabled: false,
    phase: 1,
    // Indian tax defaults — VERIFY with a tax adviser before relying on them.
    taxRates: { cryptoGainPct: 31.2, equityIntradayPct: 31.2, equityStcgPct: 20.8, cryptoTdsPct: 1 },
    consecutiveLossCooldown: 2,
    updatedAt: now,
    updatedBy: 'system',
  };
}

export function validateSettings(s: StrategySettings): string[] {
  const e: string[] = [];
  const within = (v: number, lo: number, hi: number, name: string) => {
    if (!(Number.isFinite(v) && v >= lo && v <= hi)) e.push(`${name} must be between ${lo} and ${hi} (got ${v})`);
  };
  within(s.maxRiskPerTradePct, 0.01, HARD_LIMITS.maxRiskPerTradePct, 'maxRiskPerTradePct');
  within(s.dailyLossStopPct, 0.1, HARD_LIMITS.dailyLossStopPct, 'dailyLossStopPct');
  within(s.weeklyLossStopPct, s.dailyLossStopPct, HARD_LIMITS.weeklyLossStopPct, 'weeklyLossStopPct');
  within(s.maxOpenExposurePct, 1, HARD_LIMITS.maxOpenExposurePct, 'maxOpenExposurePct');
  within(s.dailyRiskBudgetPct, 0.05, HARD_LIMITS.dailyRiskBudgetPct, 'dailyRiskBudgetPct');
  within(s.minRewardRisk, 1, 20, 'minRewardRisk');
  within(s.maxFeeToRiskPct, 1, 100, 'maxFeeToRiskPct');
  within(s.reinvestPct, 0, HARD_LIMITS.reinvestPctMax, 'reinvestPct');
  within(s.maxTradesPerSector, 1, HARD_LIMITS.maxTradesPerSector, 'maxTradesPerSector');
  within(s.maxRangeTradePct, 0, HARD_LIMITS.maxRangeTradePct, 'maxRangeTradePct');
  within(s.equityPriceMin, 1, s.equityPriceMax, 'equityPriceMin');
  if (s.maxRiskPerTradePct > s.dailyLossStopPct) e.push('maxRiskPerTradePct cannot exceed dailyLossStopPct');
  const a = s.allocation;
  for (const [k, v] of Object.entries(a)) if (!Number.isInteger(v) || v < 0) e.push(`allocation.${k} must be non-negative paise`);
  if (a.stocksPaise + a.cryptoPaise + a.reservePaise > s.initialCapitalPaise * 100) e.push('allocation is implausibly large');
  if (!['5m', '15m', '1h', '4h', '1d', '1w', '1M'].includes(s.minTimeframe)) e.push('minTimeframe invalid');
  return e;
}

export interface SettingsChangeRequest {
  patch: Partial<StrategySettings>;
  actor: Actor;
  confirmationPhrase?: string;
  now: number;
}

export interface SettingsChangeResult {
  ok: boolean;
  errors: string[];
  next?: StrategySettings;
  riskFieldsChanged: string[];
  loosenedFields: string[];
  effectiveFrom: 'now' | 'next_trading_day';
}

/** Pure decision function used by the backend `updateSettings` function. */
export function applySettingsChange(current: StrategySettings, req: SettingsChangeRequest): SettingsChangeResult {
  const base = { riskFieldsChanged: [] as string[], loosenedFields: [] as string[], effectiveFrom: 'now' as const };
  if (req.actor !== 'owner') {
    return { ...base, ok: false, errors: [`Actor '${req.actor}' may not change settings. Only the authenticated owner can.`] };
  }
  const forbidden = ['id', 'environment', 'version', 'updatedAt', 'updatedBy', 'confirmedByOwnerAt', 'firstLiveOrderConfirmedAt'];
  for (const k of Object.keys(req.patch)) if (forbidden.includes(k)) return { ...base, ok: false, errors: [`Field '${k}' cannot be patched directly`] };

  const riskFieldsChanged = Object.keys(req.patch).filter(
    (k) => RISK_FIELDS.includes(k as keyof StrategySettings) && JSON.stringify((req.patch as Record<string, unknown>)[k]) !== JSON.stringify((current as unknown as Record<string, unknown>)[k]),
  );
  const loosenedFields: string[] = [];
  for (const k of riskFieldsChanged) {
    const nv = (req.patch as Record<string, unknown>)[k];
    const ov = (current as unknown as Record<string, unknown>)[k];
    if (LOOSEN_IF_HIGHER.includes(k as keyof StrategySettings) && (nv as number) > (ov as number)) loosenedFields.push(k);
    if (LOOSEN_IF_LOWER.includes(k as keyof StrategySettings) && (nv as number) < (ov as number)) loosenedFields.push(k);
    if (k === 'executionMode' && nv === 'auto') loosenedFields.push(k);
    if (k === 'liveTradingEnabled' && nv === true) loosenedFields.push(k);
    if (k === 'phase' && (nv as number) > (ov as number)) loosenedFields.push(k);
    if (k === 'allocation') {
      const n = nv as StrategySettings['allocation'], o = ov as StrategySettings['allocation'];
      if (n.stocksPaise > o.stocksPaise || n.cryptoPaise > o.cryptoPaise) loosenedFields.push(k);
    }
  }
  if (riskFieldsChanged.length && req.confirmationPhrase !== RISK_CONFIRMATION_PHRASE) {
    return { ok: false, errors: [`Risk settings changed (${riskFieldsChanged.join(', ')}). Type "${RISK_CONFIRMATION_PHRASE}" to confirm.`], riskFieldsChanged, loosenedFields, effectiveFrom: 'now' };
  }
  const next: StrategySettings = {
    ...current, ...req.patch,
    version: current.version + 1, updatedAt: req.now, updatedBy: 'owner',
    confirmedByOwnerAt: riskFieldsChanged.length ? req.now : current.confirmedByOwnerAt,
  };
  const errors = validateSettings(next);
  if (errors.length) return { ok: false, errors, riskFieldsChanged, loosenedFields, effectiveFrom: 'now' };
  return { ok: true, errors: [], next, riskFieldsChanged, loosenedFields, effectiveFrom: loosenedFields.length ? 'next_trading_day' : 'now' };
}
