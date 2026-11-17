import { Fragment, useMemo, useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, Inr, NotConnected, PageHeader, Pnl, Section, SourceBadge, StatusPill, istTime } from '../components/ui.tsx';
import { eligibleProfit } from '@core/compounding.ts';
import { istDate } from '@core/marketHours.ts';

export function Ledger() {
  const { state, actions } = useApp();
  const [open, setOpen] = useState<string>();
  const s = state.settings;
  const elig = useMemo(() => (s ? eligibleProfit(state.fills, istDate(state.now), s.taxRates) : undefined), [state.fills, state.now, s]);
  if (!state.connected || !s) return <><PageHeader title="Compounding ledger" /><NotConnected env={state.environment} /></>;
  const hw = state.system?.compoundingHighWater?.[state.environment] ?? 0;
  const chain = state.ledgerChain;
  return (
    <>
      <PageHeader title="Compounding ledger" subtitle="Immutable, append-only double-entry ledger (integer paise) with a SHA-256 hash chain. Compounding is an equity reclassification — it never creates money."
        right={<button className="btn-primary" disabled={state.busy} onClick={() => actions.dailyClose()}>Run daily close now</button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="Eligible profit (today)" right={<SourceBadge env={state.environment} />}>
          {elig && <table className="data text-sm"><tbody>
            <tr><td>Realized gross (verified + settled)</td><td className="text-right"><Pnl p={elig.realizedGrossPaise} /></td></tr>
            <tr><td>− Fees & charges</td><td className="text-right"><Inr p={elig.feesPaise} /></td></tr>
            <tr><td>− Estimated tax</td><td className="text-right"><Inr p={elig.taxProvisionPaise} /> <SourceBadge source="ESTIMATE" /></td></tr>
            <tr className="font-semibold"><td>= Net eligible (cumulative)</td><td className="text-right"><Pnl p={elig.netPaise} /></td></tr>
            <tr><td>High-water mark already compounded</td><td className="text-right"><Inr p={hw} /></td></tr>
            <tr><td>Excluded: unreconciled / unsettled fills</td><td className="text-right">{elig.excluded.unreconciled} / {elig.excluded.unsettled}</td></tr>
          </tbody></table>}
          <p className="mt-2 text-xs text-slate-400">Reinvest share {s.reinvestPct}% (Settings). Unrealized gains are never compounded; losses must be recovered above the high-water mark first.</p>
        </Section>
        <Section title="Ledger integrity" className="lg:col-span-2">
          {chain && <div className={`flex items-center gap-2 text-sm ${chain.ok ? 'text-emerald-300' : 'text-rose-300'}`}>{chain.ok ? <ShieldCheck size={16} /> : <ShieldX size={16} />}{chain.ok ? `Hash chain verified — ${chain.entries} entries, all balanced` : `Chain broken at seq ${chain.brokenAtSeq}: ${chain.reason}`}</div>}
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {['ASSET:CASH', 'ASSET:HOLDINGS', 'EXPENSE:FEES', 'LIABILITY:TAX_RESERVE'].map((pfx) => {
              const sum = state.ledger.reduce((a, e) => a + e.lines.filter((l) => l.account.startsWith(pfx)).reduce((b, l) => b + l.amountPaise, 0), 0);
              return <div key={pfx} className="rounded border border-ink-700 bg-ink-850 p-2"><div className="text-[10px] text-slate-500">{pfx}</div><Inr p={pfx.startsWith('LIABILITY') ? -sum : sum} /></div>;
            })}
          </div>
        </Section>
      </div>
      <Section title="Compounding events" className="mt-4">
        {state.compounding.length === 0 ? <Empty>No daily close yet.</Empty> : (
          <table className="data"><thead><tr><th>Date</th><th>Status</th><th className="text-right">Cum. eligible</th><th className="text-right">Prev. HWM</th><th className="text-right">New profit</th><th className="text-right">Reinvested</th><th className="text-right">Reserve</th><th>Note</th></tr></thead>
            <tbody>{state.compounding.map((c) => <tr key={c.id}><td>{c.date}</td><td><StatusPill status={c.status} /></td><td className="text-right"><Inr p={c.cumEligibleNetPaise} /></td><td className="text-right"><Inr p={c.previousHighWaterPaise} /></td><td className="text-right"><Inr p={c.newProfitPaise} /></td><td className="text-right"><Inr p={c.reinvestedPaise} /></td><td className="text-right"><Inr p={c.toReservePaise} /></td><td className="text-xs text-slate-400">{c.note}</td></tr>)}</tbody></table>
        )}
      </Section>
      <Section title={`Ledger entries (${state.ledger.length})`} className="mt-4">
        <div className="max-h-[60vh] overflow-auto">
          <table className="data"><thead><tr><th>#</th><th>Time</th><th>Type</th><th>Memo</th><th>Source</th><th>Hash</th></tr></thead>
            <tbody>{[...state.ledger].reverse().map((e) => (<Fragment key={e.id}>
              <tr className="cursor-pointer" onClick={() => setOpen(open === e.id ? undefined : e.id)}>
                <td className="num text-xs">{e.seq}</td><td className="whitespace-nowrap text-xs text-slate-400">{istTime(e.ts)}</td><td className="text-xs">{e.type}</td><td className="text-xs">{e.memo}</td><td><SourceBadge source={e.source} /></td><td className="font-mono text-[10px] text-slate-500">{e.hash.slice(0, 12)}…</td>
              </tr>
              {open === e.id && <tr key={`${e.id}-l`}><td /><td colSpan={5}><table className="w-full text-xs"><tbody>{e.lines.map((l) => <tr key={l.account}><td className="py-0.5 font-mono text-slate-400">{l.account}</td><td className="num text-right">{l.amountPaise > 0 ? <Inr p={l.amountPaise} /> : ''}</td><td className="num text-right">{l.amountPaise < 0 ? <Inr p={-l.amountPaise} /> : ''}</td></tr>)}</tbody></table><div className="mt-1 font-mono text-[10px] text-slate-500">prev {e.prevHash.slice(0, 16)}… · key {e.idempotencyKey}</div></td></tr>}
            </Fragment>))}</tbody></table>
        </div>
        <p className="mt-2 text-xs text-slate-500">Click an entry for its debit/credit lines.</p>
      </Section>
    </>
  );
}
