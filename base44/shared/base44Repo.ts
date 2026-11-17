// Repo implementation over Base44 entities (service role, backend only).
// - Engine `id` ⇄ entity field `uid` (Base44 assigns its own record id).
// - Append-only collections refuse updates here, in addition to RLS.
// - Base44 does not enforce unique indexes, so uniqueness is checked before
//   insert. Writes are serialised through the worker (single writer); the
//   venue-side client order id is the final duplicate guard.

import type { Collection, Repo } from './core/repo.ts';
import { ImmutableRecordError, UniqueConstraintError } from './core/repo.ts';

// deno-lint-ignore no-explicit-any
type EntityApi = { filter(q: Record<string, unknown>, sort?: string, limit?: number, skip?: number): Promise<any[]>; create(d: Record<string, unknown>): Promise<any>; update(id: string, d: Record<string, unknown>): Promise<any> };
// deno-lint-ignore no-explicit-any
export type ServiceEntities = Record<string, any>;

export const COLLECTION_ENTITY: Record<keyof Repo, string> = {
  orders: 'TradeOrders', fills: 'TradeFills', ledger: 'LedgerEntries', signals: 'AI_Signals', riskEvents: 'RiskEvents', logs: 'AutomationLogs',
  snapshots: 'DailySnapshots', reconciliations: 'ReconciliationRecords', compounding: 'CompoundingEvents', connections: 'APIConnections',
  journal: 'JournalEntries', settings: 'StrategySettings', audit: 'AuditLogs', system: 'SystemState',
};
export const APPEND_ONLY = new Set<keyof Repo>(['ledger', 'riskEvents', 'logs', 'reconciliations', 'compounding', 'audit']);
/** Fields that may change after insert on otherwise-immutable fills. */
const FILL_MUTABLE = new Set(['reconciled']);

const UNIQUE: Partial<Record<keyof Repo, (d: Record<string, unknown>) => Record<string, unknown>[]>> = {
  orders: (d) => [{ environment: d.environment, idempotencyKey: d.idempotencyKey }, { environment: d.environment, venue: d.venue, clientOrderId: d.clientOrderId }],
  fills: (d) => [{ environment: d.environment, venue: d.venue, venueTradeId: d.venueTradeId }],
  ledger: (d) => [{ environment: d.environment, idempotencyKey: d.idempotencyKey }, { environment: d.environment, seq: d.seq }],
  snapshots: (d) => [{ environment: d.environment, date: d.date }],
  compounding: (d) => [{ environment: d.environment, date: d.date }],
};

const STRIP = ['id', 'created_date', 'updated_date', 'created_by', 'created_by_id', 'is_sample', 'uid', 'app_id', 'entity_name'];
function fromRecord<T>(r: Record<string, unknown>): T {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) if (!STRIP.includes(k) && v !== null && k !== 'encryptedSession' && k !== 'loginStateHash' && k !== 'signature') o[k] = v;
  o.id = r.uid;
  return o as T;
}
function toRecord(d: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = d;
  const out: Record<string, unknown> = { uid: id };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
  return out;
}

class Base44Collection<T extends { id: string }> implements Collection<T> {
  constructor(private api: EntityApi, private name: keyof Repo) {}
  private async rec(id: string) { return (await this.api.filter({ uid: id }, undefined, 2))[0]; }
  async get(id: string) { const r = await this.rec(id); return r ? fromRecord<T>(r) : undefined; }
  async list(filter: Partial<T> = {}) {
    const q: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(filter)) if (v !== undefined) q[k === 'id' ? 'uid' : k] = v;
    const out: T[] = [];
    for (let skip = 0; ; skip += 500) {
      const page = await this.api.filter(q, 'created_date', 500, skip);
      out.push(...page.map((r) => fromRecord<T>(r)));
      if (page.length < 500) break;
    }
    return out;
  }
  async insert(doc: T) {
    if (await this.rec(doc.id)) throw new UniqueConstraintError(`${this.name}.id=${doc.id}`);
    for (const q of UNIQUE[this.name]?.(doc as unknown as Record<string, unknown>) ?? []) {
      if (Object.values(q).some((v) => v === undefined)) continue;
      if ((await this.api.filter(q, undefined, 1)).length) throw new UniqueConstraintError(`${this.name}.${Object.keys(q).join('+')}`);
    }
    return fromRecord<T>(await this.api.create(toRecord(doc as unknown as Record<string, unknown>)));
  }
  async update(id: string, patch: Partial<T>) {
    if (APPEND_ONLY.has(this.name)) throw new ImmutableRecordError(COLLECTION_ENTITY[this.name]);
    if (this.name === 'fills' && Object.keys(patch).some((k) => !FILL_MUTABLE.has(k))) throw new ImmutableRecordError('TradeFills (only `reconciled` may change)');
    const r = await this.rec(id);
    if (!r) throw new Error(`${this.name} ${id} not found`);
    const { id: _ignore, ...p } = patch as Record<string, unknown>;
    return fromRecord<T>(await this.api.update(r.id, toRecord({ ...p, id }) as Record<string, unknown>));
  }
}

export function createBase44Repo(entities: ServiceEntities): Repo {
  const r = {} as Record<keyof Repo, Collection<{ id: string }>>;
  for (const [k, e] of Object.entries(COLLECTION_ENTITY)) r[k as keyof Repo] = new Base44Collection(entities[e], k as keyof Repo);
  return r as unknown as Repo;
}
