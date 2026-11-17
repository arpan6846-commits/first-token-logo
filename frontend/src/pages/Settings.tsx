import { useState } from 'react';
import { useApp } from '../runtime/AppContext.tsx';
import { TargetProgress } from '../components/TargetProgress.tsx';
import { NotConnected, PageHeader, Section, StatusPill } from '../components/ui.tsx';
import { HARD_LIMITS, RISK_CONFIRMATION_PHRASE } from '@core/settings.ts';
import { COMPLIANCE_CHECKLIST, phaseStatus } from '@core/phases.ts';
import { FIRST_LIVE_ORDER_PHRASE } from '@core/oms.ts';
import { toPaise } from '@core/money.ts';
import type { StrategySettings } from '@core/types.ts';

const FIELDS: [keyof StrategySettings, string, number?][] = [
  ['maxRiskPerTradePct', 'Max risk per trade % of equity', HARD_LIMITS.maxRiskPerTradePct], ['dailyLossStopPct', 'Daily loss stop %', HARD_LIMITS.dailyLossStopPct],
  ['weeklyLossStopPct', 'Weekly loss stop %', HARD_LIMITS.weeklyLossStopPct], ['maxOpenExposurePct', 'Max open exposure %', HARD_LIMITS.maxOpenExposurePct],
  ['dailyRiskBudgetPct', 'Daily planned-risk budget % (prop desk)', HARD_LIMITS.dailyRiskBudgetPct], ['minRewardRisk', 'Min net R:R'],
  ['maxFeeToRiskPct', 'Max costs as % of price risk'], ['maxTradesPerSector', 'Max trades per sector / day', HARD_LIMITS.maxTradesPerSector],
  ['reinvestPct', 'Reinvest % of eligible profit', 100], ['consecutiveLossCooldown', 'Cooldown after N consecutive losses'],
];

export function SettingsPage() {
  const { state, actions } = useApp();
  const s = state.settings;
  const [patch, setPatch] = useState<Record<string, string>>({});
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [phrase, setPhrase] = useState('');
  const [live, setLive] = useState('');
  const [ticks, setTicks] = useState<Record<string, boolean>>(state.complianceTicks);
  if (!state.connected || !s) return <><PageHeader title="Settings" /><NotConnected env={state.environment} /></>;
  const changes: Partial<StrategySettings> = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
  if (Object.values(alloc).some((v) => v !== '')) changes.allocation = { stocksPaise: alloc.s ? toPaise(Number(alloc.s)) : s.allocation.stocksPaise, cryptoPaise: alloc.c ? toPaise(Number(alloc.c)) : s.allocation.cryptoPaise, reservePaise: alloc.r ? toPaise(Number(alloc.r)) : s.allocation.reservePaise };
  const phases = phaseStatus({ settings: s, connections: state.connections, paperFills: state.environment === 'paper' ? state.fills : [], paperOrders: state.environment === 'paper' ? state.orders : [], backtestTrades: state.backtestTrades, reconciliations: state.reconciliations, logs: state.logs, complianceTicks: ticks, sandboxOrderTests: state.sandboxTests });
  const pending = state.system?.pendingSettings?.[state.environment];
  return (
    <>
      <PageHeader title="Settings" subtitle={`Environment ${state.environment} · version ${s.version} · last changed by ${s.updatedBy}. Only the owner can change settings; the AI never can. Risk changes need typed confirmation, and loosening applies from the next trading day.`} />
      {pending && <div className="mb-4 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200">Pending change (version {pending.settings.version}) takes effect on {pending.effectiveDate}.</div>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Risk & strategy">
          <div className="grid gap-2 sm:grid-cols-2">
            {FIELDS.map(([k, label, max]) => (
              <label key={k} className="text-xs text-slate-400">{label}{max !== undefined && <span className="text-slate-600"> (hard max {max})</span>}
                <input className="input mt-0.5" type="number" step="any" placeholder={String(s[k])} value={patch[k] ?? ''} onChange={(e) => setPatch({ ...patch, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="label mt-4">Allocation (₹) — starting configuration, not a requirement to trade</div>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {[['s', 'Stocks', s.allocation.stocksPaise], ['c', 'Crypto', s.allocation.cryptoPaise], ['r', 'Cash reserve', s.allocation.reservePaise]].map(([k, l, v]) => (
              <label key={k as string} className="text-xs text-slate-400">{l}<input className="input mt-0.5" type="number" placeholder={String((v as number) / 100)} value={alloc[k as string] ?? ''} onChange={(e) => setAlloc({ ...alloc, [k as string]: e.target.value })} /></label>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-ink-700 bg-ink-850 p-3">
            <div className="text-xs text-slate-400">Type exactly: <span className="font-mono text-slate-200">{RISK_CONFIRMATION_PHRASE}</span></div>
            <input className="input mt-1" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
            <button className="btn-primary mt-2" disabled={state.busy || Object.keys(changes).length === 0} onClick={async () => { const r = await actions.changeSettings(changes, phrase || undefined); if (r?.ok) { setPatch({}); setAlloc({}); setPhrase(''); } }}>Save {Object.keys(changes).length} change(s)</button>
          </div>
          <div className="mt-3"><TargetProgress settings={s} /></div>
        </Section>
        <Section title="Implementation phases">
          <div className="space-y-2">
            {phases.map((p) => (
              <div key={p.phase} className="rounded-lg border border-ink-700 p-2">
                <div className="flex items-center justify-between text-sm"><span className="font-medium text-slate-100">Phase {p.phase}: {p.title}</span><StatusPill status={p.unlocked ? 'DONE' : 'NOT_CONFIGURED'} /></div>
                <ul className="mt-1 space-y-0.5 text-xs">{p.criteria.map((c) => <li key={c.text} className={c.ok ? 'text-emerald-300' : 'text-slate-400'}>{c.ok ? '✓' : '○'} {c.text} <span className="text-slate-500">({c.detail})</span></li>)}</ul>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Configured phase: {s.phase}. Production orders are refused by the risk engine unless phase = 5 and live trading is enabled.</p>
        </Section>
        <Section title="Compliance checklist (owner, before Phase 5)">
          <div className="space-y-1">{COMPLIANCE_CHECKLIST.map((c) => <label key={c.id} className="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" className="mt-0.5" checked={!!ticks[c.id]} onChange={(e) => setTicks({ ...ticks, [c.id]: e.target.checked })} />{c.text}</label>)}</div>
          <button className="btn-ghost mt-3" disabled={state.busy} onClick={() => actions.setCompliance(ticks)}>Save checklist</button>
        </Section>
        <Section title="First live order confirmation">
          {s.firstLiveOrderConfirmedAt ? <p className="text-sm text-emerald-300">Confirmed {new Date(s.firstLiveOrderConfirmedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.</p> : (
            <>
              <p className="text-xs text-slate-400">Required once before any real-money order or armed production signal. Type exactly: <span className="font-mono text-slate-200">{FIRST_LIVE_ORDER_PHRASE}</span></p>
              <input className="input mt-1" value={live} onChange={(e) => setLive(e.target.value)} />
              <button className="btn-danger mt-2" disabled={state.environment !== 'production' || live !== FIRST_LIVE_ORDER_PHRASE || state.busy} onClick={() => actions.confirmFirstLiveOrder(live)}>Confirm</button>
            </>
          )}
        </Section>
      </div>
    </>
  );
}
