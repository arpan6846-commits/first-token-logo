// Reconciliation: the venue is the source of truth for cash, holdings and fills.
// Any mismatch flips `balancesReconciled` to false, and the risk engine then
// blocks new production orders until a clean reconciliation.

import type { VenueAdapter } from './adapters/types.ts';
import { newId } from './hash.ts';
import type { Ledger } from './ledger.ts';
import { toPaise } from './money.ts';
import type { OrderManager } from './oms.ts';
import { buildPositions } from './portfolio.ts';
import type { Repo } from './repo.ts';
import type { Environment, ReconciliationRecord, TradeFill, TradeOrder, Venue } from './types.ts';

export interface ReconcileOptions { cashTolerancePaise?: number; qtyTolerance?: number; tradesSince?: number }

export async function reconcileVenue(args: {
  env: Environment; venue: Venue; adapter: VenueAdapter; repo: Repo; ledger: Ledger; oms: OrderManager; now: number; opts?: ReconcileOptions;
}): Promise<ReconciliationRecord> {
  const { env, venue, adapter, repo, ledger, oms, now } = args;
  const tol = args.opts?.cashTolerancePaise ?? 100;
  const diffs: ReconciliationRecord['diffs'] = [];
  const imported: string[] = [];
  try {
    // 1. Fills: import venue trades we have not recorded; mark matched ones reconciled.
    const trades = await adapter.getTrades(args.opts?.tradesSince);
    const orders = await repo.orders.list({ environment: env, venue } as Partial<TradeOrder>);
    const byBroker = new Map(orders.filter((o) => o.brokerOrderId).map((o) => [o.brokerOrderId!, o]));
    const fills = await repo.fills.list({ environment: env, venue } as Partial<TradeFill>);
    const known = new Map(fills.map((f) => [f.venueTradeId, f]));
    for (const t of trades) {
      const f = known.get(t.venueTradeId);
      if (f) {
        if (Math.abs(f.qty - t.qty) > 1e-9 || Math.abs(f.price - t.price) > 1e-6) diffs.push({ field: `fill ${t.venueTradeId}`, internal: `${f.qty}@${f.price}`, venue: `${t.qty}@${t.price}` });
        else if (!f.reconciled) await repo.fills.update(f.id, { reconciled: true });
        continue;
      }
      const o = byBroker.get(t.brokerOrderId);
      if (!o) { diffs.push({ field: `trade ${t.venueTradeId}`, internal: 'missing order', venue: `${t.side} ${t.qty} ${t.symbol}@${t.price} (order ${t.brokerOrderId} placed outside this app)` }); continue; }
      const nf = await oms.recordFill(o, t, { reconciled: true });
      if (nf) imported.push(nf.id);
      await oms.sync(o);
    }
    // 2. Cash
    const bal = await adapter.getBalance();
    const internalCash = (await ledger.balances(env)).get(`ASSET:CASH:${venue}`) ?? 0;
    if (Math.abs(bal.cashPaise - internalCash) > tol) diffs.push({ field: 'cash', internal: internalCash / 100, venue: bal.cashPaise / 100 });
    // 3. Holdings
    const positions = buildPositions(await repo.fills.list({ environment: env } as Partial<TradeFill>));
    const venueHoldings = await adapter.getHoldings();
    const symbols = new Set([...venueHoldings.map((h) => h.symbol), ...[...positions.values()].filter((p) => p.venue === venue).map((p) => p.symbol)]);
    for (const s of symbols) {
      const iq = positions.get(`${venue}:${s}`)?.qty ?? 0;
      const vq = venueHoldings.find((h) => h.symbol === s)?.qty ?? 0;
      if (Math.abs(iq - vq) > (args.opts?.qtyTolerance ?? 1e-8)) diffs.push({ field: `holding ${s}`, internal: iq, venue: vq });
    }
    // 4. UNKNOWN orders: resolve by client order id
    for (const o of orders.filter((x) => x.status === 'UNKNOWN')) {
      const st = await adapter.findOrderByClientId(o.clientOrderId);
      if (st) await oms.applyVenueState(await repo.orders.update(o.id, { brokerOrderId: st.brokerOrderId }), st);
      else diffs.push({ field: `order ${o.id}`, internal: 'UNKNOWN', venue: 'not found — owner may close it as never received' });
    }
    const rec: ReconciliationRecord = {
      id: newId('rec', now), environment: env, venue, ts: now, kind: 'BALANCES', status: diffs.length ? 'MISMATCH' : 'MATCHED', diffs, importedFillIds: imported,
      message: diffs.length ? `${diffs.length} difference(s) — new production orders blocked until resolved` : `Cash ₹${bal.cashPaise / 100}, ${venueHoldings.length} holdings, ${trades.length} trades match`,
    };
    await repo.reconciliations.insert(rec);
    await setReconState(repo, env, venue, now, rec.status === 'MATCHED');
    return rec;
  } catch (e) {
    const rec: ReconciliationRecord = { id: newId('rec', now), environment: env, venue, ts: now, kind: 'BALANCES', status: 'ERROR', diffs, importedFillIds: imported, message: `Reconciliation failed: ${(e as Error).message}` };
    await repo.reconciliations.insert(rec);
    await setReconState(repo, env, venue, now, false);
    return rec;
  }
}

async function setReconState(repo: Repo, env: Environment, venue: Venue, ts: number, ok: boolean) {
  const sys = await repo.system.get('system');
  if (!sys) return;
  await repo.system.update('system', { lastReconciliation: { ...(sys.lastReconciliation ?? {}), [`${env}:${venue}`]: { ts, ok } } });
}

/** Owner-declared deposit into a venue (production): recorded as MANUAL, confirmed by the next reconciliation. */
export function depositLines(venue: Venue | 'BANK', rupees: number) {
  return [{ account: `ASSET:CASH:${venue}`, amountPaise: toPaise(rupees) }, { account: 'EQUITY:CONTRIBUTED', amountPaise: -toPaise(rupees) }];
}
