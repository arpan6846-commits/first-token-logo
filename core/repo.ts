// Storage abstraction. The engine only talks to `Repo`; the browser simulation
// and tests use MemoryRepo, Base44 backend functions use Base44Repo
// (base44/functions/_shared/base44Repo.ts) mapped to entities with the same names.

import type {
  AISignal, APIConnection, AutomationLog, CompoundingEvent, DailySnapshot, JournalEntry, KillSwitchState,
  LedgerEntry, ReconciliationRecord, RiskEvent, StrategySettings, TradeFill, TradeOrder,
} from './types.ts';

export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  list(filter?: Partial<T>): Promise<T[]>;
  insert(doc: T): Promise<T>;
  update(id: string, patch: Partial<T>): Promise<T>;
}

export interface AuditRecord {
  id: string;
  ts: number;
  actor: string;
  action: string;
  environment: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface SystemState {
  id: 'system';
  killSwitch: KillSwitchState;
  haltedUntil?: Record<string, string>; // env -> YYYY-MM-DD (IST) after a loss-stop breach
  lastReconciliation?: Record<string, { ts: number; ok: boolean }>; // `${env}:${venue}`
  compoundingHighWater?: Record<string, number>; // env -> paise
  lastCompoundingDate?: Record<string, string>;
  pendingSettings?: Record<string, { effectiveDate: string; settings: StrategySettings }>;
}

export interface Repo {
  orders: Collection<TradeOrder>;
  fills: Collection<TradeFill>;
  ledger: Collection<LedgerEntry>;
  signals: Collection<AISignal>;
  riskEvents: Collection<RiskEvent>;
  logs: Collection<AutomationLog>;
  snapshots: Collection<DailySnapshot>;
  reconciliations: Collection<ReconciliationRecord>;
  compounding: Collection<CompoundingEvent>;
  connections: Collection<APIConnection>;
  journal: Collection<JournalEntry>;
  settings: Collection<StrategySettings>;
  audit: Collection<AuditRecord>;
  system: Collection<SystemState>;
}

export class UniqueConstraintError extends Error {
  override name = 'UniqueConstraintError';
  constructor(public key: string) { super(`Unique constraint violated: ${key}`); }
}
export class ImmutableRecordError extends Error {
  override name = 'ImmutableRecordError';
  constructor(entity: string) { super(`${entity} records are append-only and cannot be updated`); }
}

interface MemoryOpts<T> { name: string; unique?: (d: T) => string[]; appendOnly?: boolean; }

export class MemoryCollection<T extends { id: string }> implements Collection<T> {
  private rows = new Map<string, T>();
  private keys = new Map<string, string>();
  constructor(private opts: MemoryOpts<T>) {}

  async get(id: string) { const r = this.rows.get(id); return r ? structuredClone(r) : undefined; }
  async list(filter?: Partial<T>) {
    const out: T[] = [];
    for (const r of this.rows.values()) {
      if (!filter || Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) out.push(structuredClone(r));
    }
    return out;
  }
  async insert(doc: T) {
    if (this.rows.has(doc.id)) throw new UniqueConstraintError(`${this.opts.name}.id=${doc.id}`);
    const ks = this.opts.unique?.(doc) ?? [];
    for (const k of ks) if (this.keys.has(k)) throw new UniqueConstraintError(`${this.opts.name}.${k}`);
    for (const k of ks) this.keys.set(k, doc.id);
    this.rows.set(doc.id, structuredClone(doc));
    return structuredClone(doc);
  }
  async update(id: string, patch: Partial<T>) {
    if (this.opts.appendOnly) throw new ImmutableRecordError(this.opts.name);
    const cur = this.rows.get(id);
    if (!cur) throw new Error(`${this.opts.name} ${id} not found`);
    const next = { ...cur, ...structuredClone(patch), id } as T;
    const oldKeys = this.opts.unique?.(cur) ?? [];
    const newKeys = this.opts.unique?.(next) ?? [];
    for (const k of newKeys) if (!oldKeys.includes(k) && this.keys.has(k)) throw new UniqueConstraintError(`${this.opts.name}.${k}`);
    for (const k of oldKeys) this.keys.delete(k);
    for (const k of newKeys) this.keys.set(k, id);
    this.rows.set(id, next);
    return structuredClone(next);
  }
  /** Serialise for browser persistence. */
  dump(): T[] { return [...this.rows.values()]; }
  load(rows: T[]) { this.rows.clear(); this.keys.clear(); for (const r of rows) { this.rows.set(r.id, r); for (const k of this.opts.unique?.(r) ?? []) this.keys.set(k, r.id); } }
}

export function createMemoryRepo(): Repo & { all: Record<string, MemoryCollection<{ id: string }>> } {
  const repo = {
    orders: new MemoryCollection<TradeOrder>({ name: 'TradeOrders', unique: (d) => [`idem:${d.environment}:${d.idempotencyKey}`, `cid:${d.environment}:${d.venue}:${d.clientOrderId}`] }),
    fills: new MemoryCollection<TradeFill>({ name: 'TradeFills', unique: (d) => [`trade:${d.environment}:${d.venue}:${d.venueTradeId}`], appendOnly: false }),
    ledger: new MemoryCollection<LedgerEntry>({ name: 'LedgerEntries', unique: (d) => [`idem:${d.environment}:${d.idempotencyKey}`, `seq:${d.environment}:${d.seq}`], appendOnly: true }),
    signals: new MemoryCollection<AISignal>({ name: 'AI_Signals' }),
    riskEvents: new MemoryCollection<RiskEvent>({ name: 'RiskEvents', appendOnly: true }),
    logs: new MemoryCollection<AutomationLog>({ name: 'AutomationLogs', appendOnly: true }),
    snapshots: new MemoryCollection<DailySnapshot>({ name: 'DailySnapshots', unique: (d) => [`day:${d.environment}:${d.date}`] }),
    reconciliations: new MemoryCollection<ReconciliationRecord>({ name: 'ReconciliationRecords', appendOnly: true }),
    compounding: new MemoryCollection<CompoundingEvent>({ name: 'CompoundingEvents', unique: (d) => [`day:${d.environment}:${d.date}`], appendOnly: true }),
    connections: new MemoryCollection<APIConnection>({ name: 'APIConnections' }),
    journal: new MemoryCollection<JournalEntry>({ name: 'JournalEntries' }),
    settings: new MemoryCollection<StrategySettings>({ name: 'StrategySettings' }),
    audit: new MemoryCollection<AuditRecord>({ name: 'AuditLogs', appendOnly: true }),
    system: new MemoryCollection<SystemState>({ name: 'SystemState' }),
  };
  return { ...repo, all: repo as unknown as Record<string, MemoryCollection<{ id: string }>> };
}

/** Simple async mutex so ledger sequence numbers and hash chains stay linear. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
}
