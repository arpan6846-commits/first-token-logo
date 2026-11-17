import { useMemo, useState } from 'react';
import { Bot, Play, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, Inr, NotConnected, PageHeader, Section, SourceBadge, StatusPill, istTime, px } from '../components/ui.tsx';
import { DISCLAIMER_HI, qtyFromRisk, rewardRisk } from '@core/propDesk.ts';
import type { AISignal, Trend3 } from '@core/types.ts';

const FILTERS = ['ALL', 'VALIDATED', 'APPROVED', 'WATCHLIST', 'REJECTED', 'EXECUTED', 'EXPIRED'] as const;

export function Signals() {
  const { state, actions } = useApp();
  const [f, setF] = useState<(typeof FILTERS)[number]>('ALL');
  const [selId, setSel] = useState<string>();
  if (!state.connected) return <><PageHeader title="AI signals" /><NotConnected env={state.environment} /></>;
  const list = state.signals.filter((s) => f === 'ALL' || s.status === f).slice(0, 300);
  const sel = state.signals.find((s) => s.id === selId) ?? list[0];
  const counts = Object.fromEntries(FILTERS.map((k) => [k, k === 'ALL' ? state.signals.length : state.signals.filter((s) => s.status === k).length]));
  return (
    <>
      <PageHeader title="AI signals" subtitle="Deterministic prop-desk analysis (The Language of Price rulebook). Every signal, decision and rejection is logged. The AI reviewer can only downgrade or reject — never upgrade, size up or bypass risk."
        right={<button className="btn-primary" disabled={state.busy} onClick={() => actions.generateSignals()}><Play size={14} />Generate now</button>} />
      <div className="mb-3 flex flex-wrap gap-1">{FILTERS.map((k) => <button key={k} onClick={() => setF(k)} className={`rounded-md border px-2 py-1 text-xs ${f === k ? 'border-indigo-500 bg-indigo-950 text-indigo-200' : 'border-ink-600 text-slate-400'}`}>{k} <span className="text-slate-500">{counts[k]}</span></button>)}</div>
      <div className="grid gap-4 xl:grid-cols-5">
        <Section title="Signals" className="xl:col-span-2">
          {list.length === 0 ? <Empty>No signals. Generate after enough closed candles exist; most analyses end as WATCHLIST or REJECTED — "no trade" is a valid outcome.</Empty> : (
            <div className="max-h-[70vh] overflow-y-auto">
              <table className="data"><thead><tr><th>Time</th><th>Symbol</th><th>Status</th><th>Why</th></tr></thead>
                <tbody>{list.map((s) => <tr key={s.id} onClick={() => setSel(s.id)} className={`cursor-pointer ${sel?.id === s.id ? 'bg-ink-800' : ''}`}>
                  <td className="whitespace-nowrap text-xs text-slate-400">{istTime(s.createdAt)}</td><td className="font-medium">{s.symbol}<div className="text-[10px] text-slate-500">{s.timeframe}/{s.htf}</div></td>
                  <td><StatusPill status={s.status} /></td><td className="max-w-[220px] truncate text-xs text-slate-400">{s.rejectionReasons[0] ?? `R:R ${s.rrNetOfCosts.toFixed(2)} net`}</td></tr>)}</tbody></table>
            </div>
          )}
        </Section>
        <div className="xl:col-span-3">{sel ? <SignalDetail key={sel.id} s={sel} /> : <Empty>Select a signal.</Empty>}</div>
      </div>
    </>
  );
}

function SignalDetail({ s }: { s: AISignal }) {
  const { state, actions } = useApp();
  const fc = s.finalCheck;
  const [ticks, setTicks] = useState<Record<number, boolean>>(() => Object.fromEntries((fc?.items ?? []).filter((i) => i.mode === 'manual' && i.pass !== null).map((i) => [i.id, !!i.pass])));
  const journal = state.journal.find((j) => j.signalId === s.id && j.kind === 'PRE_TRADE');
  const rr = s.entry && s.stop && s.target ? rewardRisk('LONG', s.entry, s.stop, s.target) : undefined;
  const q = s.entry && s.stop ? qtyFromRisk(Math.max(0, (s.plannedRiskPaise - s.estFeesPaise / 2) / 100), s.entry, s.stop, 6) : undefined;
  const blocks = useMemo(() => { const m = new Map<string, NonNullable<typeof fc>['items']>(); for (const it of fc?.items ?? []) m.set(it.block, [...(m.get(it.block) ?? []), it]); return m; }, [fc]);
  const failedAuto = (fc?.items ?? []).filter((i) => i.mode === 'auto' && i.pass === false && i.id !== 100);
  const manualIds = (fc?.items ?? []).filter((i) => i.mode === 'manual').map((i) => i.id);
  const needJournal = state.environment !== 'simulation';
  const canArm = s.status === 'VALIDATED' && (state.environment === 'simulation' || (failedAuto.length === 0 && manualIds.every((id) => ticks[id]) && !!journal));
  return (
    <div className="space-y-4">
      <Section title={`${s.symbol} · ${s.setupType}`} right={<div className="flex items-center gap-2"><SourceBadge source={s.dataSource} /><StatusPill status={s.status} /></div>}>
        <div className="grid gap-2 text-sm sm:grid-cols-4">
          <Box k="Entry (break confirm)" v={px(s.entry)} /><Box k="Stop" v={px(s.stop)} /><Box k="Target (price-action level)" v={px(s.target)} /><Box k="Qty" v={String(s.qty)} />
          <Box k="R:R gross" v={s.rr.toFixed(2)} /><Box k="R:R net of costs" v={s.rrNetOfCosts.toFixed(2)} /><Box k="Planned risk incl. costs" v={<Inr p={s.plannedRiskPaise} />} /><Box k="Est. fees + slippage" v={<><Inr p={s.estFeesPaise} /> + <Inr p={s.estSlippagePaise} /></>} />
        </div>
        {s.rejectionReasons.length > 0 && <ul className="mt-3 space-y-1 text-xs">{s.rejectionReasons.map((r) => <li key={r} className="rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-amber-200">{r}</li>)}</ul>}
        {s.expiryReason && <p className="mt-2 text-xs text-slate-400">Expired: {s.expiryReason}</p>}
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div><div className="label mb-1">Rationale</div><ul className="list-disc space-y-1 pl-4 text-xs text-slate-300">{s.rationale.map((r) => <li key={r}>{r}</li>)}</ul></div>
          <div><div className="label mb-1">Invalidation</div><ul className="list-disc space-y-1 pl-4 text-xs text-slate-300">{s.invalidation.map((r) => <li key={r}>{r}</li>)}</ul>
            {s.retailIllusion && <><div className="label mb-1 mt-3">Retail illusion</div><p className="text-xs text-slate-300">{s.retailIllusion}</p></>}</div>
        </div>
        {s.areaAnswers && <div className="mt-3"><div className="label mb-1">Five area questions</div><table className="data text-xs"><tbody>{Object.entries(s.areaAnswers).map(([k, v]) => <tr key={k}><td className="w-48 text-slate-400">{k}</td><td>{v}</td></tr>)}</tbody></table></div>}
        {rr && <div className="mt-3 rounded-lg border border-ink-700 bg-ink-850 p-2 font-mono text-[11px] text-slate-300"><div>{rr.text} {rr.reverseOk ? '✓' : '✗'}</div>{q && <div>{q.text} {q.reverseOk ? '✓' : '✗'} (price risk only; engine sizing also subtracts costs)</div>}</div>}
        {s.aiReview && <div className="mt-3 rounded-lg border border-indigo-900 bg-indigo-950/30 p-2 text-xs"><div className="flex items-center gap-1 font-semibold text-indigo-200"><Bot size={13} />AI review ({s.aiReview.model}): {s.aiReview.verdict}</div><p className="mt-1 whitespace-pre-wrap text-slate-300">{s.aiReview.notes}</p></div>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={!canArm || state.busy} onClick={() => actions.approveSignal(s.id, ticks)}><ShieldCheck size={14} />Approve & arm</button>
          <button className="btn-ghost" disabled={!['VALIDATED', 'WATCHLIST', 'APPROVED'].includes(s.status) || state.busy} onClick={() => actions.cancelSignal(s.id)}><X size={14} />Cancel</button>
          <button className="btn-ghost" disabled={state.busy} onClick={() => actions.aiReview(s.id)}><Sparkles size={14} />AI review (can only downgrade)</button>
        </div>
        <p className="mt-2 text-xs text-slate-500">Arming does not buy immediately: the order is sent only after a closed {s.timeframe} candle confirms the build-up break, price has not run &gt; 0.5 ATR, and the risk engine re-approves. {DISCLAIMER_HI}</p>
      </Section>

      {needJournal && <PreTradeJournal s={s} existing={!!journal} />}

      {fc && (
        <Section title={`Final Check — ${fc.items.filter((i) => i.pass).length}/100 pass`} right={<span className="text-xs text-slate-400">{failedAuto.length} auto fails · {manualIds.filter((id) => !ticks[id]).length} owner items open</span>}>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
            {[...blocks.entries()].map(([b, items]) => (
              <div key={b}><div className="label mb-1">Block {b}</div>
                <div className="grid gap-1 sm:grid-cols-2">{items.map((it) => {
                  const pass = it.mode === 'manual' ? ticks[it.id] : it.pass;
                  return (
                    <label key={it.id} className={`flex items-start gap-2 rounded border px-2 py-1 text-xs ${pass ? 'border-emerald-900/60 text-slate-300' : 'border-rose-900/60 text-slate-200'}`} title={it.note}>
                      {it.mode === 'manual' ? <input type="checkbox" className="mt-0.5" checked={!!ticks[it.id]} onChange={(e) => setTicks({ ...ticks, [it.id]: e.target.checked })} /> : <span className="mt-0.5 w-3 text-center">{pass ? '✓' : '✗'}</span>}
                      <span><span className="text-slate-500">{it.id}.</span> {it.text}{it.mode === 'manual' && <span className="ml-1 text-amber-300">(owner)</span>}{it.note && !pass && <span className="block text-slate-500">{it.note}</span>}</span>
                    </label>
                  );
                })}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function PreTradeJournal({ s, existing }: { s: AISignal; existing: boolean }) {
  const { actions } = useApp();
  const [form, setForm] = useState({ sectorWhy: '', stockWhy: '', positionWhy: '', againstMePlan: '' });
  const [sc, setSc] = useState<{ nifty: Trend3; sector: Trend3; stock: Trend3 }>({ nifty: 'UP', sector: 'UP', stock: 'UP' });
  if (existing) return <Section title="Pre-trade written analysis"><p className="text-sm text-emerald-300">Written pre-trade analysis recorded for this signal (Final Check items 15–17).</p></Section>;
  return (
    <Section title="Pre-trade written analysis (required before arming in paper/production)">
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); actions.addJournal({ kind: 'PRE_TRADE', signalId: s.id, symbol: s.symbol, ...form, profileScenario: sc }); }}>
        {(['sectorWhy', 'stockWhy', 'positionWhy', 'againstMePlan'] as const).map((k) => (
          <textarea key={k} className="input min-h-[64px]" required value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            placeholder={{ sectorWhy: 'Sector + why', stockWhy: 'Stock + why', positionWhy: 'Position (entry/stop/target) + why', againstMePlan: 'If the market goes against me: first action, stop, correlation' }[k]} />
        ))}
        <div className="flex flex-wrap items-center gap-2 text-xs sm:col-span-2">Profile scenario:
          {(['nifty', 'sector', 'stock'] as const).map((k) => <select key={k} className="input !w-auto" value={sc[k]} onChange={(e) => setSc({ ...sc, [k]: e.target.value as Trend3 })}>{['UP', 'DOWN', 'CONSOLIDATION'].map((t) => <option key={t}>{t}</option>)}</select>)}
          <button className="btn-primary ml-auto">Save analysis</button>
        </div>
      </form>
    </Section>
  );
}

function Box({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div><div className="num text-slate-100">{v}</div></div>;
}
