import { useState } from 'react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, NotConnected, PageHeader, Section, istTime } from '../components/ui.tsx';
import { DISCLAIMER_HI, NEVER_RULES, dailyRiskBudgetPct, insideBarPlan, profileScenario, pyramidSchedule, qtyFromRisk, rewardRisk, spreadPeRule, spreadReviewDue, traderStage } from '@core/propDesk.ts';
import type { BacktestResult } from '@core/backtest.ts';
import type { Trend3 } from '@core/types.ts';

const num = (s: string) => Number(s);

export function PropDesk() {
  const { state } = useApp();
  if (!state.connected) return <><PageHeader title="Prop desk" /><NotConnected env={state.environment} /></>;
  return (
    <>
      <PageHeader title="Prop trading desk" subtitle="Rulebook tools from “The Language of Price”: R:R and quantity with reverse checks, daily risk tiers, written journal, stock profile grid, long–short spread tracker, backtests. Analysis aid only — not financial advice." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Calculators />
        <RiskTier />
        <Journal />
        <Profile />
        <Spread />
        <Backtest />
      </div>
      <Section title="NEVER rules (enforced or checked in Final Check)" className="mt-4">
        <ol className="grid list-decimal gap-x-6 gap-y-1 pl-5 text-xs text-slate-300 md:grid-cols-2">{NEVER_RULES.map((r) => <li key={r}>{r}</li>)}</ol>
        <p className="mt-3 text-xs text-slate-500">{DISCLAIMER_HI}</p>
      </Section>
    </>
  );
}

function Calculators() {
  const [f, setF] = useState({ side: 'LONG', entry: '576', stop: '568', target: '600', risk: '50', mh: '110', ml: '100' });
  const rr = rewardRisk(f.side as 'LONG' | 'SHORT', num(f.entry), num(f.stop), num(f.target));
  const q = qtyFromRisk(num(f.risk), num(f.entry), num(f.stop));
  const ib = insideBarPlan({ high: num(f.mh), low: num(f.ml), bullish: true }, false);
  const field = (k: keyof typeof f, label: string) => <label className="text-xs text-slate-400">{label}<input className="input mt-0.5" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <Section title="R:R & quantity (step 22, with reverse checks)">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <label className="text-xs text-slate-400">Side<select className="input mt-0.5" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}><option>LONG</option><option>SHORT</option></select></label>
        {field('entry', 'Entry')}{field('stop', 'Stop')}{field('target', 'Target (PA level)')}{field('risk', 'Trade risk ₹')}
      </div>
      <div className="mt-3 space-y-1 rounded-lg border border-ink-700 bg-ink-850 p-2 font-mono text-[11px] text-slate-200">
        <div>{rr.text} {rr.reverseOk ? '✓' : '✗'}</div>
        <div>{q.text} {q.reverseOk ? '✓' : '✗'}</div>
        <div>Pyramid adds (impulsive candles only): {pyramidSchedule(q.qty).join(' → ')}</div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">{field('mh', 'Mother high')}{field('ml', 'Mother low')}<div className="text-[11px] text-slate-300">Inside bar (bullish, S/R near): entry {ib.entry}, stop {ib.stop}, target {ib.target.toFixed(2)}</div></div>
      <p className="mt-2 text-[11px] text-slate-500">Targets must be price-action levels — fixed 1:4 / 1:5 multiples are forbidden (NEVER 16).</p>
    </Section>
  );
}

function RiskTier() {
  const { state } = useApp();
  const c = state.closedStats;
  const tier = dailyRiskBudgetPct(c?.accuracyPct, c?.count ?? 0, { smallCapital: (state.settings?.initialCapitalPaise ?? 0) < 10_000_000 });
  const tradesPerDay = state.orders.filter((o) => o.side === 'BUY' && o.filledQty > 0).length / Math.max(1, new Set(state.fills.map((f) => new Date(f.ts + 330 * 60_000).toISOString().slice(0, 10))).size);
  return (
    <Section title="Daily risk tier & trader stage (3.7, 3.8)">
      <p className="text-sm text-slate-200">Recommended daily risk: <span className="font-semibold">{tier.pct}%</span> <span className="text-slate-400">— {tier.reason}</span></p>
      <p className="mt-1 text-sm text-slate-200">Configured: {state.settings?.dailyRiskBudgetPct}% (never &gt; 1%). The engine uses the lower of the two outside simulation.</p>
      <p className="mt-2 text-sm text-slate-300">Stage: {traderStage(tradesPerDay)}</p>
      <table className="data mt-3 text-xs"><tbody>
        <tr><td>~50% accuracy</td><td>0.25%</td></tr><tr><td>~70% accuracy</td><td>0.5%</td></tr><tr><td>~90% accuracy</td><td>0.75–1%</td></tr><tr><td>Between anchors / small capital</td><td>use the lower</td></tr>
      </tbody></table>
    </Section>
  );
}

function Journal() {
  const { state, actions } = useApp();
  const [f, setF] = useState({ kind: 'POST_TRADE', symbol: '', whatHappened: '', followed: '', broken: '', outcome: 'SCRATCH' });
  const closed = state.orders.filter((o) => o.side === 'SELL' && o.parentOrderId && o.filledQty > 0);
  const [orderId, setOrderId] = useState('');
  return (
    <Section title="Written journal (pre/post-trade, psychology)">
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); actions.addJournal({ kind: f.kind as 'POST_TRADE', symbol: f.symbol || undefined, orderId: orderId || undefined, whatHappened: f.whatHappened, rulesFollowed: f.followed.split(',').map((x) => x.trim()).filter(Boolean), rulesBroken: f.broken.split(',').map((x) => x.trim()).filter(Boolean), outcome: f.outcome as 'WIN' }); setF({ ...f, whatHappened: '', followed: '', broken: '' }); }}>
        <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="POST_TRADE">Post-trade review</option><option value="PSYCHOLOGY">Psychology note</option></select>
        <select className="input" value={orderId} onChange={(e) => { setOrderId(e.target.value); const o = closed.find((x) => x.id === e.target.value); if (o) setF({ ...f, symbol: o.symbol }); }}><option value="">— link closed trade —</option>{closed.map((o) => <option key={o.id} value={o.parentOrderId}>{o.symbol} {o.exitReason} {istTime(o.updatedAt)}</option>)}</select>
        <textarea className="input min-h-[70px] sm:col-span-2" required placeholder="What happened and why (map to rules)" value={f.whatHappened} onChange={(e) => setF({ ...f, whatHappened: e.target.value })} />
        <input className="input" placeholder="Rules followed (e.g. M2, M7)" value={f.followed} onChange={(e) => setF({ ...f, followed: e.target.value })} />
        <input className="input" placeholder="Rules broken (e.g. N8)" value={f.broken} onChange={(e) => setF({ ...f, broken: e.target.value })} />
        <select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}><option>WIN</option><option>LOSS</option><option>SCRATCH</option></select>
        <button className="btn-primary justify-center">Save</button>
      </form>
      <div className="mt-3 max-h-56 overflow-auto">{state.journal.length === 0 ? <Empty>No journal entries.</Empty> : state.journal.slice(0, 50).map((j) => (
        <div key={j.id} className="border-b border-ink-800 py-1.5 text-xs"><span className="text-slate-500">{istTime(j.ts)} · {j.kind}{j.symbol ? ` · ${j.symbol}` : ''}{j.outcome ? ` · ${j.outcome}` : ''}</span><div className="text-slate-300">{j.whatHappened ?? j.stockWhy ?? j.notes}</div>{(j.rulesBroken?.length ?? 0) > 0 && <div className="text-rose-300">Broken: {j.rulesBroken!.join(', ')}</div>}</div>
      ))}</div>
    </Section>
  );
}

function Profile() {
  const [s, setS] = useState<{ n: Trend3; sec: Trend3; st: Trend3 }>({ n: 'UP', sec: 'CONSOLIDATION', st: 'UP' });
  const T: Trend3[] = ['UP', 'DOWN', 'CONSOLIDATION'];
  return (
    <Section title="Stock profile — 3×3×3 scenario grid">
      <div className="flex flex-wrap gap-2 text-xs">
        {(['n', 'sec', 'st'] as const).map((k) => <label key={k} className="text-slate-400">{{ n: 'Nifty', sec: 'Sector', st: 'Stock' }[k]}<select className="input mt-0.5" value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value as Trend3 })}>{T.map((t) => <option key={t}>{t}</option>)}</select></label>)}
      </div>
      <p className="mt-3 text-sm text-slate-200">{profileScenario(s.n, s.sec, s.st)}</p>
      <p className="mt-2 text-xs text-slate-500">The rulebook keeps the year-long profile on pen & paper (~8 stocks per sector, ~45 min each evening). Record the scenario on each pre-trade journal entry here so the Final Check can confirm it was read.</p>
    </Section>
  );
}

function Spread() {
  const [f, setF] = useState({ lp: '60', sp: '20', sec: '40', last: new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10), lc: '', sc: '', stop: '' });
  const pe = spreadPeRule(num(f.lp), num(f.sp), num(f.sec));
  const spread = num(f.lc) > 0 && num(f.sc) > 0 ? num(f.lc) / num(f.sc) : undefined;
  const field = (k: keyof typeof f, label: string, type = 'text') => <label className="text-xs text-slate-400">{label}<input type={type} className="input mt-0.5" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <Section title="Long–short spread tracker (mode G) — analysis only">
      <div className="grid grid-cols-3 gap-2">{field('lp', 'Long P/E')}{field('sp', 'Short P/E')}{field('sec', 'Sector P/E')}{field('lc', 'Long adj. close')}{field('sc', 'Short adj. close')}{field('stop', 'Spread stop')}{field('last', 'Last review', 'date')}</div>
      <ul className="mt-3 space-y-1 text-xs">
        <li className={pe.ok ? 'text-emerald-300' : 'text-amber-300'}>{pe.reason}</li>
        <li className="text-slate-300">Spread = long ÷ short = {spread ? spread.toFixed(4) : '—'}{spread && num(f.stop) ? (spread <= num(f.stop) ? ' · AT/BELOW SPREAD STOP' : ' · above stop') : ''}</li>
        <li className={spreadReviewDue(f.last, new Date().toISOString()) ? 'text-amber-300' : 'text-slate-400'}>{spreadReviewDue(f.last, new Date().toISOString()) ? '2-week review due' : 'Review not yet due'}</li>
      </ul>
      <p className="mt-2 text-[11px] text-slate-500">Execution of the short leg is not supported: this account is cash/spot only with no shorting, futures or margin. Use for analysis and paper tracking.</p>
    </Section>
  );
}

function Backtest() {
  const { state, actions } = useApp();
  const syms = state.instruments.filter((i) => !i.symbol.startsWith('NIFTY')).map((i) => i.symbol);
  const [sym, setSym] = useState(syms[0] ?? '');
  const [r, setR] = useState<BacktestResult>();
  const [running, setRunning] = useState(false);
  return (
    <Section title="Historical test (Phase 3)" right={<span className="text-xs text-slate-500">{state.environment === 'simulation' ? 'on SIMULATED history' : 'needs historical data from the worker'}</span>}>
      <div className="flex gap-2">
        <select className="input" value={sym} onChange={(e) => setSym(e.target.value)}>{syms.map((s) => <option key={s}>{s}</option>)}</select>
        <button className="btn-primary" disabled={running || state.environment !== 'simulation'} onClick={async () => { setRunning(true); setR(await actions.backtest(sym)); setRunning(false); }}>{running ? 'Running…' : 'Run'}</button>
      </div>
      {r && (
        <div className="mt-3 text-xs">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {[['Signals seen', r.signalsSeen], ['Trades', r.trades.length], ['Win rate', `${r.winRatePct.toFixed(0)}%`], ['Net P&L', `₹${(r.netPnlPaise / 100).toFixed(2)}`], ['Profit factor', Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'], ['Max DD', `${r.maxDrawdownPct}%`]].map(([k, v]) => <div key={k as string} className="rounded border border-ink-700 bg-ink-850 p-1.5"><div className="text-[10px] text-slate-500">{k}</div><div className="num text-slate-100">{v}</div></div>)}
          </div>
          <div className="mt-2 text-slate-400">Top rejection reasons: {Object.entries(r.rejectedByReason).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}</div>
          <ul className="mt-2 list-disc pl-4 text-amber-200/80">{r.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
    </Section>
  );
}
