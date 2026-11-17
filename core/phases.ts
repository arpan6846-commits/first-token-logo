// Implementation phase gates. Each phase is unlocked only when measurable
// criteria pass AND the owner approves. Phase 5 (real money) additionally
// requires the compliance checklist to be ticked by the owner.

import type { APIConnection, AutomationLog, ReconciliationRecord, StrategySettings, TradeFill, TradeOrder } from './types.ts';

export const COMPLIANCE_CHECKLIST = [
  { id: 'algo-framework', text: 'Confirmed with the broker how SEBI\'s retail algo framework applies to my API orders (registration / algo-ID / tagging / order-rate limits), and that my usage is compliant' },
  { id: 'static-ip', text: 'Order-placement host has the static IP whitelisted with the broker if the broker requires it' },
  { id: 'kite-terms', text: 'Read the current Kite Connect terms, pricing and personal-use conditions; API app is in my own name' },
  { id: 'coindcx-terms', text: 'Read the current CoinDCX API terms; key restricted to spot trading; withdrawals disabled on the key; IP-bound if available' },
  { id: 'min-permissions', text: 'API keys created with minimum permissions (read + trade only; no withdraw, no transfer, no futures/margin)' },
  { id: 'tax', text: 'Tax treatment (crypto VDA 30% + 1% TDS, equity STCG/speculative) verified with a tax adviser' },
  { id: 'fees', text: 'Fee model rates verified against current Zerodha and CoinDCX charge sheets' },
  { id: 'kyc-own-funds', text: 'Trading only my own funds in my own KYC accounts; no third-party money or pooled funds' },
  { id: 'holidays', text: 'Current NSE holiday calendar loaded' },
  { id: 'loss-acceptance', text: 'I accept that I can lose money; the 10% daily figure is aspirational, not expected' },
] as const;

export interface PhaseStatus { phase: number; title: string; criteria: { text: string; ok: boolean; detail: string }[]; unlocked: boolean }

export function phaseStatus(x: {
  settings: StrategySettings; connections: APIConnection[]; paperFills: TradeFill[]; paperOrders: TradeOrder[]; backtestTrades: number;
  reconciliations: ReconciliationRecord[]; logs: AutomationLog[]; complianceTicks: Record<string, boolean>; sandboxOrderTests: Record<string, boolean>;
}): PhaseStatus[] {
  const prodConn = x.connections.filter((c) => c.environment === 'production');
  const readOk = (v: string) => prodConn.some((c) => c.venue === v && ['TESTED_READ_ONLY', 'TESTED_ORDERS_SANDBOX'].includes(c.status));
  const noWithdraw = prodConn.every((c) => !c.permissions.withdraw);
  const paperClosed = x.paperOrders.filter((o) => o.side === 'SELL' && o.parentOrderId && o.filledQty > 0).length;
  const paperDays = new Set(x.paperFills.map((f) => new Date(f.ts + 330 * 60_000).toISOString().slice(0, 10))).size;
  const paperRecon = x.reconciliations.filter((r) => r.environment === 'paper');
  const lastPaperRecon = paperRecon.sort((a, b) => b.ts - a.ts)[0];
  const sandboxNeeded = ['place_cancel', 'partial_fill', 'reject', 'duplicate_retry', 'reconcile'];
  const compliance = COMPLIANCE_CHECKLIST.every((c) => x.complianceTicks[c.id]);
  const phases: PhaseStatus[] = [
    { phase: 1, title: 'Frontend, database, ledger, dashboards, simulation', unlocked: true, criteria: [{ text: 'Simulation engine and ledger', ok: true, detail: 'Built in' }] },
    { phase: 2, title: 'Read-only stock and crypto APIs', unlocked: false, criteria: [
      { text: 'Kite read-only connection tested', ok: readOk('KITE'), detail: prodConn.find((c) => c.venue === 'KITE')?.status ?? 'NOT_CONFIGURED' },
      { text: 'CoinDCX read-only connection tested', ok: readOk('COINDCX'), detail: prodConn.find((c) => c.venue === 'COINDCX')?.status ?? 'NOT_CONFIGURED' },
      { text: 'Withdrawal permission disabled on all keys', ok: noWithdraw, detail: noWithdraw ? 'OK' : 'A key reports withdraw permission' },
    ] },
    { phase: 3, title: 'Historical testing and paper trading', unlocked: false, criteria: [
      { text: '≥ 30 backtest trades', ok: x.backtestTrades >= 30, detail: `${x.backtestTrades}` },
      { text: '≥ 30 closed paper trades', ok: paperClosed >= 30, detail: `${paperClosed}` },
      { text: '≥ 20 paper trading days', ok: paperDays >= 20, detail: `${paperDays}` },
      { text: 'Latest paper reconciliation matched', ok: lastPaperRecon?.status === 'MATCHED', detail: lastPaperRecon?.status ?? 'none' },
    ] },
    { phase: 4, title: 'Order APIs in sandbox / controlled testing', unlocked: false, criteria: sandboxNeeded.map((k) => ({ text: `Controlled test: ${k.replace('_', ' ')}`, ok: !!x.sandboxOrderTests[k], detail: x.sandboxOrderTests[k] ? 'passed' : 'not run' })) },
    { phase: 5, title: 'Limited real-money trading', unlocked: false, criteria: [
      { text: 'Compliance checklist ticked by owner', ok: compliance, detail: `${COMPLIANCE_CHECKLIST.filter((c) => x.complianceTicks[c.id]).length}/${COMPLIANCE_CHECKLIST.length}` },
      { text: 'Owner enabled live trading', ok: x.settings.liveTradingEnabled, detail: x.settings.liveTradingEnabled ? 'enabled' : 'disabled' },
    ] },
  ];
  for (let i = 1; i < phases.length; i++) phases[i].unlocked = phases[i - 1].unlocked && phases[i].criteria.every((c) => c.ok);
  return phases;
}
