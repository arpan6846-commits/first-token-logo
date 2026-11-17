import { useState } from 'react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, Inr, NotConnected, PageHeader, Pnl, Section, SourceBadge, ago, px } from '../components/ui.tsx';
import type { Venue } from '@core/types.ts';

function Bar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs"><span className="text-slate-300">{label}</span><span className="num text-slate-400"><Inr p={used} /> / <Inr p={cap} /></span></div>
      <div className="mt-1 h-2 rounded-full bg-ink-700"><div className="h-full rounded-full bg-[color:var(--series-1)]" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Portfolio() {
  const { state, actions } = useApp();
  const [venue, setVenue] = useState<Venue | 'BANK'>('KITE');
  const [amt, setAmt] = useState('');
  const [ref, setRef] = useState('');
  const eq = state.equity, s = state.settings;
  if (!state.connected || !eq || !s) return <><PageHeader title="Portfolio" /><NotConnected env={state.environment} /></>;
  const reinvShare = (b: number) => (eq.reinvestedPaise > 0 ? Math.round(eq.reinvestedPaise * (b / Math.max(1, s.allocation.stocksPaise + s.allocation.cryptoPaise))) : 0);
  return (
    <>
      <PageHeader title="Portfolio" subtitle="Positions are rebuilt from fills (FIFO lots); cash from the double-entry ledger." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Allocation vs configured buckets" className="lg:col-span-2" right={<span className="text-xs text-slate-500">starting configuration, not a requirement to trade</span>}>
          <div className="space-y-3">
            <Bar label="Stocks (NSE, CNC)" used={eq.exposureByClass.EQUITY} cap={s.allocation.stocksPaise + reinvShare(s.allocation.stocksPaise)} />
            <Bar label="Crypto (spot)" used={eq.exposureByClass.CRYPTO} cap={s.allocation.cryptoPaise + reinvShare(s.allocation.cryptoPaise)} />
            <Bar label={`Total exposure (max ${s.maxOpenExposurePct}% of equity)`} used={eq.marketValuePaise} cap={Math.floor((eq.netEquityPaise * s.maxOpenExposurePct) / 100)} />
            <p className="text-xs text-slate-400">Cash reserve target <Inr p={s.allocation.reservePaise} />; reinvested profit so far <Inr p={eq.reinvestedPaise} /> (spread across buckets pro-rata).</p>
          </div>
        </Section>
        <Section title="Cash by venue" right={<SourceBadge env={state.environment} />}>
          <table className="data"><tbody>{Object.entries(eq.cashByVenue).map(([v, p]) => <tr key={v}><td>{v === 'BANK' ? 'Bank / reserve' : v}</td><td className="text-right"><Inr p={p} /></td></tr>)}</tbody></table>
        </Section>
      </div>
      <Section title="Positions" className="mt-4">
        {state.positions.length === 0 ? <Empty>No open positions.</Empty> : (
          <div className="overflow-x-auto"><table className="data"><thead><tr><th>Symbol</th><th>Venue</th><th className="text-right">Qty</th><th className="text-right">Avg cost</th><th className="text-right">Cost</th><th className="text-right">Last</th><th>Mark source</th><th className="text-right">Value</th><th className="text-right">Unrealized (est.)</th><th>Lots</th></tr></thead>
            <tbody>{state.positions.map((p) => <tr key={p.key}><td className="font-medium">{p.symbol}</td><td>{p.venue}</td><td className="num text-right">{p.qty}</td><td className="num text-right">{px(p.avgPrice)}</td><td className="text-right"><Inr p={p.costPaise} /></td><td className="num text-right">{px(p.markPrice)}</td><td><SourceBadge source={p.markSource ?? 'NONE'} /> <span className="text-xs text-slate-500">{ago(p.markTs, state.now)}</span></td><td className="text-right"><Inr p={p.marketValuePaise} /></td><td className="text-right"><Pnl p={p.unrealizedPaise} /></td><td className="text-xs text-slate-400">{p.lots.length}</td></tr>)}</tbody></table></div>
        )}
      </Section>
      <Section title="Deposits & withdrawals" className="mt-4" right={<span className="text-xs text-slate-500">owner-declared; production amounts are confirmed by the next reconciliation</span>}>
        <form className="grid gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); actions.cashFlow(venue, Number(amt), ref || `manual-${Date.now()}`); setAmt(''); setRef(''); }}>
          <select className="input" value={venue} onChange={(e) => setVenue(e.target.value as Venue)}><option value="KITE">Kite (stocks)</option><option value="COINDCX">CoinDCX (crypto)</option><option value="BANK">Bank / reserve</option></select>
          <input className="input" type="number" step="0.01" placeholder="₹ amount (negative = withdrawal)" value={amt} onChange={(e) => setAmt(e.target.value)} required />
          <input className="input sm:col-span-2" placeholder="Reference (bank UTR / note) — makes it idempotent" value={ref} onChange={(e) => setRef(e.target.value)} />
          <button className="btn-primary justify-center" disabled={!amt || state.busy}>Record</button>
        </form>
      </Section>
    </>
  );
}
