import { useState } from 'react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, Inr, NotConnected, PageHeader, Pnl, Section, SourceBadge, StatusPill, istTime, px } from '../components/ui.tsx';
import { FIRST_LIVE_ORDER_PHRASE } from '@core/oms.ts';
import type { AssetClass, Side, Venue } from '@core/types.ts';

export function Trades() {
  const { state, actions } = useApp();
  const [phrase, setPhrase] = useState('');
  if (!state.connected) return <><PageHeader title="Trade history" /><NotConnected env={state.environment} /></>;
  const prod = state.environment === 'production';
  return (
    <>
      <PageHeader title="Trade history" subtitle="Orders carry an idempotency key and a venue client id; status only advances on venue confirmation. Fills are venue-reported and recorded exactly once." />
      <ManualOrder />
      <Section title={`Orders (${state.orders.length})`} className="mt-4">
        {state.orders.length === 0 ? <Empty>No orders.</Empty> : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="data"><thead><tr><th>Created</th><th>Symbol</th><th>Side</th><th className="text-right">Filled/Qty</th><th className="text-right">Limit</th><th className="text-right">Avg</th><th>Status</th><th>By</th><th>Venue id</th><th>Detail</th><th></th></tr></thead>
              <tbody>{state.orders.map((o) => (
                <tr key={o.id}>
                  <td className="whitespace-nowrap text-xs text-slate-400">{istTime(o.createdAt)}</td><td className="font-medium">{o.symbol}</td><td>{o.side}{o.exitReason ? <span className="ml-1 text-[10px] text-slate-500">{o.exitReason}</span> : null}</td>
                  <td className="num text-right">{o.filledQty}/{o.qty}</td><td className="num text-right">{px(o.limitPrice)}</td><td className="num text-right">{px(o.avgFillPrice)}</td>
                  <td><StatusPill status={o.status} /></td><td className="text-xs">{o.createdBy}</td><td className="font-mono text-[10px] text-slate-500">{o.brokerOrderId ?? '—'}</td>
                  <td className="max-w-[340px] text-xs text-slate-400">{o.rejectionReason ?? (o.plannedRiskPaise ? <>risk <Inr p={o.plannedRiskPaise} /></> : '')}</td>
                  <td className="whitespace-nowrap">
                    {o.status === 'AWAITING_OWNER' && <button className="btn-primary !py-0.5 text-xs" disabled={state.busy || (prod && !state.settings?.firstLiveOrderConfirmedAt && phrase !== FIRST_LIVE_ORDER_PHRASE)} onClick={() => actions.confirmOrder(o.id, phrase || undefined)}>Confirm & send</button>}
                    {['OPEN', 'PARTIALLY_FILLED', 'AWAITING_OWNER', 'APPROVED'].includes(o.status) && <button className="btn-ghost ml-1 !py-0.5 text-xs" disabled={state.busy} onClick={() => actions.cancelOrder(o.id)}>Cancel</button>}
                  </td>
                </tr>))}</tbody></table>
          </div>
        )}
        {prod && !state.settings?.firstLiveOrderConfirmedAt && <div className="mt-2 flex items-center gap-2 text-xs"><span className="text-amber-300">First live order: type “{FIRST_LIVE_ORDER_PHRASE}”</span><input className="input !w-80" value={phrase} onChange={(e) => setPhrase(e.target.value)} /></div>}
      </Section>
      <Section title={`Fills (${state.fills.length})`} className="mt-4" right={<SourceBadge env={state.environment} source={prod ? 'BROKER' : undefined} />}>
        {state.fills.length === 0 ? <Empty>No fills.</Empty> : (
          <div className="max-h-[50vh] overflow-auto">
            <table className="data"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th className="text-right">Qty @ Price</th><th className="text-right">Fees</th><th>Fee source</th><th className="text-right">TDS</th><th className="text-right">Realized (gross)</th><th>Reconciled</th><th>Settles</th><th>Trade id</th></tr></thead>
              <tbody>{state.fills.map((f) => (
                <tr key={f.id}><td className="whitespace-nowrap text-xs text-slate-400">{istTime(f.ts)}</td><td>{f.symbol}</td><td>{f.side}</td><td className="num text-right">{f.qty} @ {px(f.price)}</td>
                  <td className="text-right"><Inr p={f.feesPaise} /></td><td><SourceBadge source={f.feesSource === 'BROKER' ? 'BROKER' : 'ESTIMATE'} /></td><td className="text-right"><Inr p={f.tdsPaise} /></td>
                  <td className="text-right">{f.side === 'SELL' ? <Pnl p={f.realizedPnlPaise} /> : '—'}</td><td>{f.reconciled ? <StatusPill status="MATCHED" /> : <StatusPill status="UNKNOWN" />}</td><td className="text-xs">{f.settlementDate}</td><td className="font-mono text-[10px] text-slate-500">{f.venueTradeId}</td></tr>))}</tbody></table>
          </div>
        )}
      </Section>
    </>
  );
}

function ManualOrder() {
  const { state, actions } = useApp();
  const insts = state.instruments.filter((i) => !i.symbol.startsWith('NIFTY'));
  const [f, setF] = useState({ symbol: insts[0]?.symbol ?? '', side: 'BUY' as Side, qty: '', limit: '', stop: '', target: '', confirm: false, key: '' });
  const inst = insts.find((i) => i.symbol === f.symbol);
  const prod = state.environment === 'production';
  const q = state.quotes.find((x) => x.symbol === f.symbol);
  return (
    <Section title="Manual order (owner)" right={<span className="text-xs text-slate-500">passes the same risk engine as AI signals; last price {px(q?.ltp)}</span>}>
      <form className="grid gap-2 sm:grid-cols-4 lg:grid-cols-9" onSubmit={(e) => {
        e.preventDefault();
        if (!inst) return;
        actions.submitOrder({
          environment: state.environment, venue: inst.venue as Venue, symbol: inst.symbol, assetClass: inst.assetClass as AssetClass, side: f.side, qty: Number(f.qty), orderType: 'LIMIT',
          product: inst.assetClass === 'EQUITY' ? 'CNC' : 'SPOT', limitPrice: Number(f.limit), stopPrice: f.stop ? Number(f.stop) : undefined, targetPrice: f.target ? Number(f.target) : undefined,
          idempotencyKey: f.key || `manual-${Date.now()}`,
        }, { ownerConfirmed: f.confirm });
      }}>
        <select className="input" value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value })}>{insts.map((i) => <option key={i.symbol}>{i.symbol}</option>)}</select>
        <select className="input" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value as Side })}><option>BUY</option><option>SELL</option></select>
        <input className="input" placeholder="Qty" required value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        <input className="input" placeholder="Limit ₹" required value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
        <input className="input" placeholder="Stop ₹" value={f.stop} onChange={(e) => setF({ ...f, stop: e.target.value })} />
        <input className="input" placeholder="Target ₹" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
        <input className="input" placeholder="Idempotency key (optional)" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} title="Re-using a key returns the original order instead of creating a new one" />
        <label className="flex items-center gap-1 text-xs text-slate-300">{prod && <><input type="checkbox" checked={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.checked })} />I confirm this real order</>}</label>
        <button className="btn-primary justify-center" disabled={state.busy || (prod && !f.confirm)}>Submit</button>
      </form>
    </Section>
  );
}
