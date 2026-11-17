// Base44 runtime (VITE_DATA_MODE=base44): reads owner-only entities and sends
// every change through the authenticated `ownerCommand` function. The browser
// never writes financial records and never sees API secrets.

import { createClient } from '@base44/sdk';
import type { Environment } from '@core/types.ts';
import type { AppState } from './types.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export function base44Client() {
  return createClient({ appId: import.meta.env.VITE_BASE44_APP_ID as string, requiresAuth: true });
}

const STRIP = ['id', 'created_date', 'updated_date', 'created_by', 'created_by_id', 'is_sample', 'uid'];
const norm = (r: Any) => { const o: Any = {}; for (const [k, v] of Object.entries(r)) if (!STRIP.includes(k) && v !== null) o[k] = v; o.id = r.uid; return o; };

export class Base44Runtime {
  client = base44Client();

  private async list(entity: string, q: Record<string, unknown>, sort = '-created_date', limit = 500): Promise<Any[]> {
    return ((await this.client.entities[entity].filter(q, sort, limit)) as Any[]).map(norm);
  }

  async snapshotState(env: Environment): Promise<Partial<AppState>> {
    const e = { environment: env };
    const [portfolio, orders, fills, signals, ledger, snapshots, compounding, riskEvents, logs, audit, recon, settings, sys, connections, journal, md, profile] = await Promise.all([
      this.list('Portfolio', e, '-asOf', 1), this.list('TradeOrders', e, '-createdAt', 200), this.list('TradeFills', e, '-ts', 200), this.list('AI_Signals', e, '-createdAt', 200),
      this.list('LedgerEntries', e, 'seq', 2000), this.list('DailySnapshots', e, 'date', 400), this.list('CompoundingEvents', e, '-date', 100), this.list('RiskEvents', e, '-ts', 200),
      this.list('AutomationLogs', e, '-ts', 200), this.list('AuditLogs', {}, '-ts', 300), this.list('ReconciliationRecords', e, '-ts', 50), this.list('StrategySettings', e, '-version', 1),
      this.list('SystemState', { uid: 'system' }, '-created_date', 1), this.list('APIConnections', e, '-created_date', 10), this.list('JournalEntries', e, '-ts', 200),
      this.list('MarketData', { timeframe: 'quote' }, '-receivedAt', 200), this.list('UserProfile', {}, '-created_date', 1),
    ]);
    const p = portfolio[0];
    const connected = env === 'production' ? connections.some((c: Any) => ['AUTHENTICATED', 'TESTED_READ_ONLY', 'TESTED_ORDERS_SANDBOX'].includes(c.status)) || !!p : !!p;
    return {
      connected, now: Date.now(),
      equity: p ? { ...p, holdingsCostPaise: (p.marketValuePaise ?? 0) - (p.unrealizedPaise ?? 0), tdsReceivablePaise: 0, netContributionsPaise: snapshots.at(-1)?.netContributionsPaise ?? 0 } : undefined,
      positions: [], orders, fills, signals, ledger, snapshots, compounding, riskEvents, logs, audit, reconciliations: recon, settings: settings[0], system: sys[0],
      connections, journal, quotes: md.map((m: Any) => m.quote).filter(Boolean), psychology: [], plannedRiskTodayPaise: 0,
      complianceTicks: profile[0]?.complianceTicks ?? {}, sandboxTests: profile[0]?.sandboxOrderTests ?? {},
    };
  }

  async command(type: string, environment: Environment, payload: Record<string, unknown>): Promise<Any> {
    const r = await this.client.functions.invoke('ownerCommand', { type, environment, payload });
    const id = r?.data?.commandId;
    // wait briefly for the worker (single writer) to execute it
    for (let i = 0; i < 20 && id; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const [c] = (await this.client.entities.Commands.filter({ uid: id }, '-requestedAt', 1)) as Any[];
      if (c?.status === 'DONE') return c.result;
      if (c?.status === 'FAILED') throw new Error(c.result?.error ?? 'Command failed');
    }
    return { pending: true, note: 'Queued — the worker has not picked it up yet (is it running?)' };
  }

  async invoke(fn: string, data: Record<string, unknown> = {}): Promise<Any> { return (await this.client.functions.invoke(fn, data))?.data; }
}
