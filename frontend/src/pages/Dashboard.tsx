import { Link } from 'react-router-dom';
import { AlertTriangle, Octagon } from 'lucide-react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, Inr, NotConnected, PageHeader, Pnl, Section, SourceBadge, Stat, StatusPill, istTime, px } from '../components/ui.tsx';
import { TargetProgress } from '../components/TargetProgress.tsx';
import { LineChart } from '../components/charts.tsx';
import type { Position } from '@core/portfolio.ts';

export function useMetrics() {
  const { state } = useApp();
  const eq = state.equity;
  const a = state.anchors;
  const dayRet = eq && a && a.startOfDay > 0 ? ((eq.netEquityPaise - a.startOfDay - a.contribDay) / a.startOfDay) * 100 : state.snapshots.at(-1)?.dayReturnPct;
  const cumRet = eq && eq.netContributionsPaise > 0 ? ((eq.netEquityPaise - eq.netContributionsPaise) / eq.netContributionsPaise) * 100 : undefined;
  const peak = Math.max(eq?.netEquityPaise ?? 0, ...state.snapshots.map((s) => s.peakEquityPaise));
  const dd = eq && peak > 0 ? ((eq.netEquityPaise - peak) / peak) * 100 : undefined;
  return { eq, dayRet, cumRet, dd };
}

function Holdings({ title, list }: { title: string; list: Position[] }) {
  return (
    <Section title={title}>
      {list.length === 0 ? <Empty>No holdings.</Empty> : (
        <table className="data"><thead><tr><th>Symbol</th><th className="text-right">Qty</th><th className="text-right">Avg</th><th className="text-right">Last</th><th className="text-right">Unrealized</th></tr></thead>
          <tbody>{list.map((p) => <tr key={p.key}><td className="font-medium">{p.symbol}</td><td className="num text-right">{p.qty}</td><td className="num text-right">{px(p.avgPrice)}</td><td className="num text-right">{px(p.markPrice)}</td><td className="text-right"><Pnl p={p.unrealizedPaise} /></td></tr>)}</tbody></table>
      )}
    </Section>
  );
}

export function Dashboard() {
  const { state } = useApp();
  const { eq, dayRet, cumRet, dd } = useMetrics();
  const env = state.environment;
  if (!state.connected || !eq) return <><PageHeader title="Dashboard" /><NotConnected env={env} /></>;
  const src = env === 'production' ? 'ACTUAL' : undefined;
  const open = state.orders.filter((o) => ['OPEN', 'PARTIALLY_FILLED', 'AWAITING_OWNER', 'APPROVED', 'SUBMITTING', 'UNKNOWN'].includes(o.status));
  const curve = [...state.snapshots.map((s) => ({ x: s.date, y: s.netEquityPaise })), { x: 'now', y: eq.netEquityPaise }];
  const ks = state.system?.killSwitch;
  const halted = state.system?.haltedUntil?.[env];
  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${env === 'simulation' ? 'Simulated book — synthetic prices, no real money.' : env === 'paper' ? 'Paper book — live prices, simulated fills, no real money.' : 'Production book — real balances from broker-reconciled records.'} Estimates are labelled as such.`} />
      {(ks?.active || halted) && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-rose-800 bg-rose-950/60 p-3 text-sm text-rose-200">
          <Octagon size={16} />{ks?.active ? `Kill switch active: ${ks.reason}` : `New entries halted until ${halted} after a loss-limit breach.`}
        </div>
      )}
      {state.psychology.length > 0 && <div className="mb-4 space-y-1">{state.psychology.map((p) => <div key={p} className="flex items-center gap-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-1.5 text-sm text-amber-200"><AlertTriangle size={14} />{p}</div>)}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Total equity" env={env} source={src} sub="cash + marked holdings + TDS receivable − tax reserve"><Inr p={eq.netEquityPaise} /></Stat>
        <Stat label="Available cash" env={env} source={src} sub={Object.entries(eq.cashByVenue).map(([v, p]) => `${v} ₹${(p / 100).toLocaleString('en-IN')}`).join(' · ')}><Inr p={eq.cashPaise} /></Stat>
        <Stat label="Invested capital" env={env} source={src} sub={<>market value <Inr p={eq.marketValuePaise} /></>}><Inr p={eq.holdingsCostPaise} /></Stat>
        <Stat label="Realized P&L" env={env} source={src} sub="gross, from verified fills"><Pnl p={eq.realizedPaise} /></Stat>
        <Stat label="Unrealized P&L" source="ESTIMATE" sub={eq.marksComplete ? 'marked at last traded price' : 'some marks missing — at cost'}><Pnl p={eq.unrealizedPaise} /></Stat>
        <Stat label="Fees & charges" env={env} source={src} sub="brokerage, STT, GST, DP, exchange"><Inr p={eq.feesPaise} /></Stat>
        <Stat label="Tax reserve" source="ESTIMATE" sub={`TDS receivable ₹${(eq.tdsReceivablePaise / 100).toFixed(2)}`}><Inr p={eq.taxReservePaise} /></Stat>
        <Stat label="Daily return" env={env} source={src} sub="vs start-of-day equity, net of deposits"><Pnl pct={dayRet} /></Stat>
        <Stat label="Cumulative return" env={env} source={src} sub={<>on contributions <Inr p={eq.netContributionsPaise} /></>}><Pnl pct={cumRet} /></Stat>
        <Stat label="Drawdown" env={env} source={src} sub="from peak equity"><Pnl pct={dd} /></Stat>
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Section title="Equity curve" className="xl:col-span-2" right={<SourceBadge env={env} source={src} />}>
          <LineChart points={curve} label="Net equity by day" />
        </Section>
        <TargetProgress settings={state.settings} todayReturnPct={dayRet} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Holdings title="Stock holdings (NSE · CNC)" list={state.positions.filter((p) => p.assetClass === 'EQUITY')} />
        <Holdings title="Crypto holdings (spot)" list={state.positions.filter((p) => p.assetClass === 'CRYPTO')} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Open orders" right={<Link className="text-xs text-indigo-300" to="/trades">all orders →</Link>}>
          {open.length === 0 ? <Empty>No open orders.</Empty> : (
            <table className="data"><thead><tr><th>Symbol</th><th>Side</th><th className="text-right">Qty</th><th className="text-right">Limit</th><th>Status</th></tr></thead>
              <tbody>{open.slice(0, 8).map((o) => <tr key={o.id}><td>{o.symbol}</td><td>{o.side}</td><td className="num text-right">{o.filledQty}/{o.qty}</td><td className="num text-right">{px(o.limitPrice)}</td><td><StatusPill status={o.status} /></td></tr>)}</tbody></table>
          )}
        </Section>
        <Section title="Recent trades (fills)">
          {state.fills.length === 0 ? <Empty>No executions yet. Profits are recorded only from venue-reported fills.</Empty> : (
            <table className="data"><thead><tr><th>Time (IST)</th><th>Symbol</th><th>Side</th><th className="text-right">Qty @ price</th><th className="text-right">Realized</th></tr></thead>
              <tbody>{state.fills.slice(0, 8).map((f) => <tr key={f.id}><td className="text-xs text-slate-400">{istTime(f.ts)}</td><td>{f.symbol}</td><td>{f.side}</td><td className="num text-right">{f.qty} @ {px(f.price)}</td><td className="text-right">{f.side === 'SELL' ? <Pnl p={(f.realizedPnlPaise ?? 0) - f.feesPaise} /> : '—'}</td></tr>)}</tbody></table>
          )}
        </Section>
      </div>
      <Section title="Compounding history" className="mt-4" right={<Link className="text-xs text-indigo-300" to="/ledger">ledger →</Link>}>
        {state.compounding.length === 0 ? <Empty>No daily close yet. Only verified, settled, net realized profit is ever compounded.</Empty> : (
          <table className="data"><thead><tr><th>Date</th><th>Status</th><th className="text-right">New net profit</th><th className="text-right">Reinvested</th><th className="text-right">To reserve</th><th>Note</th></tr></thead>
            <tbody>{state.compounding.slice(0, 6).map((c) => <tr key={c.id}><td>{c.date}</td><td><StatusPill status={c.status} /></td><td className="text-right"><Inr p={c.newProfitPaise} /></td><td className="text-right"><Inr p={c.reinvestedPaise} /></td><td className="text-right"><Inr p={c.toReservePaise} /></td><td className="text-xs text-slate-400">{c.note}</td></tr>)}</tbody></table>
        )}
      </Section>
    </>
  );
}
