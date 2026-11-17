import { useState } from 'react';
import { Octagon } from 'lucide-react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, Inr, NotConnected, PageHeader, Section, StatusPill, istTime } from '../components/ui.tsx';

function Gauge({ label, used, limit, note }: { label: string; used: number; limit: number; note?: string }) {
  const pct = limit > 0 ? Math.min(100, (Math.max(0, used) / limit) * 100) : 0;
  const tone = pct >= 100 ? 'bg-rose-500' : pct >= 75 ? 'bg-amber-500' : 'bg-[color:var(--series-1)]';
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <div className="flex justify-between text-xs"><span className="text-slate-300">{label}</span><span className="num text-slate-400"><Inr p={Math.max(0, used)} /> / <Inr p={limit} /> · {pct.toFixed(0)}%{pct >= 100 ? ' · LIMIT' : ''}</span></div>
      <div className="mt-2 h-2 rounded-full bg-ink-700"><div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} /></div>
      {note && <div className="mt-1 text-[11px] text-slate-500">{note}</div>}
    </div>
  );
}

export function Risk() {
  const { state, actions } = useApp();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const s = state.settings, eq = state.equity, a = state.anchors;
  if (!state.connected || !s || !eq) return <><PageHeader title="Risk monitor" /><NotConnected env={state.environment} /></>;
  const ks = state.system?.killSwitch;
  const dayLoss = a ? -(eq.netEquityPaise - a.startOfDay - a.contribDay) : 0;
  const weekLoss = a ? -(eq.netEquityPaise - a.startOfWeek - a.contribWeek) : 0;
  const halted = state.system?.haltedUntil?.[state.environment];
  const env = state.environment;
  return (
    <>
      <PageHeader title="Risk monitor" subtitle="Deterministic limits evaluated before every order. The AI cannot change them; the owner can tighten immediately, and loosening takes effect only from the next trading day." />
      <Section title="Emergency kill switch" className={ks?.active ? 'border-rose-800' : ''}>
        {ks?.active ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 font-semibold text-rose-200"><Octagon size={18} />ACTIVE since {istTime(ks.activatedAt)} — {ks.reason}</span>
            <input className="input !w-64" placeholder='Type "RELEASE" to deactivate' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <button className="btn-ghost" disabled={confirm !== 'RELEASE' || state.busy} onClick={() => { actions.killSwitch(false, 'Released by owner', true); setConfirm(''); }}>Release</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input className="input !w-80" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn-danger" disabled={!reason || state.busy} onClick={() => { actions.killSwitch(true, reason); setReason(''); }}><Octagon size={14} />ACTIVATE KILL SWITCH</button>
            <span className="text-xs text-slate-400">Blocks all new orders in every environment and cancels open orders. Reduce-only protective stop exits still run.</span>
          </div>
        )}
      </Section>
      {halted && <div className="mt-4 rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-200">New entries halted until {halted} (loss limit breached). Exits still work.</div>}
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Gauge label={`Planned risk today (budget ${s.dailyRiskBudgetPct}%)`} used={state.plannedRiskTodayPaise} limit={Math.floor((eq.netEquityPaise * s.dailyRiskBudgetPct) / 100)} note={`Per trade max ${s.maxRiskPerTradePct}% = ₹${((eq.netEquityPaise * s.maxRiskPerTradePct) / 10000).toFixed(2)} incl. costs`} />
        <Gauge label={`Day loss vs stop (${s.dailyLossStopPct}%)`} used={dayLoss} limit={a ? Math.round((a.startOfDay * s.dailyLossStopPct) / 100) : 0} note="of start-of-day equity" />
        <Gauge label={`Week loss vs stop (${s.weeklyLossStopPct}%)`} used={weekLoss} limit={a ? Math.round((a.startOfWeek * s.weeklyLossStopPct) / 100) : 0} note="of start-of-week equity" />
        <Gauge label={`Open exposure (max ${s.maxOpenExposurePct}%)`} used={eq.marketValuePaise} limit={Math.floor((eq.netEquityPaise * s.maxOpenExposurePct) / 100)} note="no leverage: cash-only, CNC / spot" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Section title="Active rules">
          <ul className="space-y-1 text-xs text-slate-300">
            <li>• Stale quote &gt; {s.maxQuoteAgeMs / 1000}s or candle &gt; {s.maxCandleLagMultiple}× TF → blocked</li>
            <li>• Session expired / venue unavailable / unreconciled (prod) → blocked</li>
            <li>• Duplicate idempotency key → original order returned</li>
            <li>• Net-of-costs R:R ≥ {s.minRewardRisk}; costs ≤ {s.maxFeeToRiskPct}% of price risk</li>
            <li>• Max {s.maxTradesPerSector} trades per sector per day; range trades ≤ {s.maxRangeTradePct}%</li>
            <li>• Stock price universe ₹{s.equityPriceMin}–₹{s.equityPriceMax}; timeframe ≥ {s.minTimeframe}</li>
            <li>• Stop-out in a symbol → no re-entry today (no revenge trading)</li>
            <li>• {s.consecutiveLossCooldown} consecutive losses → cooldown</li>
            <li>• No short selling; no leverage, margin, futures or withdrawals</li>
          </ul>
        </Section>
        <Section title="Psychology & discipline" className="lg:col-span-2">
          {state.psychology.length === 0 ? <Empty>No alerts.</Empty> : <ul className="space-y-1 text-sm text-amber-200">{state.psychology.map((p) => <li key={p}>• {p}</li>)}</ul>}
          <div className="mt-3 text-xs text-slate-400">Closed trades {state.closedStats?.count ?? 0} · wins {state.closedStats?.wins ?? 0} · accuracy {state.closedStats?.accuracyPct?.toFixed(0) ?? '—'}% (needs ≥ 30 trades before the daily risk tier can rise above 0.25% outside simulation).</div>
        </Section>
      </div>
      <Section title="Risk events" className="mt-4">
        {state.riskEvents.length === 0 ? <Empty>No risk events.</Empty> : (
          <div className="max-h-[50vh] overflow-auto"><table className="data"><thead><tr><th>Time</th><th>Severity</th><th>Code</th><th>Message</th></tr></thead>
            <tbody>{state.riskEvents.slice(0, 300).map((r) => <tr key={r.id}><td className="whitespace-nowrap text-xs text-slate-400">{istTime(r.ts)}</td><td><StatusPill status={r.severity} /></td><td className="font-mono text-xs">{r.code}</td><td className="text-xs">{r.message}</td></tr>)}</tbody></table></div>
        )}
      </Section>
      <p className="mt-3 text-xs text-slate-500">Environment: {env}. Risk numbers use this environment's own book only.</p>
    </>
  );
}
