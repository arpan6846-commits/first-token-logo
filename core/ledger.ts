// Immutable, append-only, double-entry ledger with a SHA-256 hash chain per
// environment. There is no update or delete API. Corrections are new
// RECONCILIATION_ADJUSTMENT entries that reference the original.

import { canonicalJson, newId, sha256Hex } from './hash.ts';
import type { Paise } from './money.ts';
import { assertPaise } from './money.ts';
import { Mutex, type Collection } from './repo.ts';
import type { DataSource, Environment, LedgerEntry, LedgerEntryType, LedgerLine, Venue } from './types.ts';

export const GENESIS_HASH = '0'.repeat(64);

export const Accounts = {
  cash: (v: Venue | 'BANK') => `ASSET:CASH:${v}`,
  holdings: (v: Venue, symbol: string) => `ASSET:HOLDINGS:${v}:${symbol}`,
  tdsReceivable: 'ASSET:TDS_RECEIVABLE',
  fees: (v: Venue) => `EXPENSE:FEES:${v}`,
  taxProvision: 'EXPENSE:TAX_PROVISION',
  realized: (v: Venue) => `INCOME:REALIZED:${v}`,
  taxReserve: 'LIABILITY:TAX_RESERVE',
  contributed: 'EQUITY:CONTRIBUTED',
  withdrawn: 'EQUITY:WITHDRAWN',
  retained: 'EQUITY:RETAINED',
  reinvested: 'EQUITY:REINVESTED',
  reconciliation: 'EQUITY:RECONCILIATION_ADJUSTMENTS',
} as const;

export interface PostInput {
  environment: Environment;
  type: LedgerEntryType;
  memo: string;
  lines: LedgerLine[];
  idempotencyKey: string;
  source: DataSource;
  refType?: string;
  refId?: string;
  ts?: number;
}

export class LedgerError extends Error { override name = 'LedgerError'; }

const PROD_ALLOWED_SOURCES: DataSource[] = ['BROKER', 'MANUAL', 'ESTIMATE'];

export function hashEntry(e: Omit<LedgerEntry, 'hash'>): string {
  const { id: _id, ...rest } = e;
  return sha256Hex(canonicalJson(rest));
}

export class Ledger {
  private locks = new Map<Environment, Mutex>();
  constructor(private col: Collection<LedgerEntry>, private clock: () => number = Date.now) {}

  private lock(env: Environment) {
    let m = this.locks.get(env);
    if (!m) { m = new Mutex(); this.locks.set(env, m); }
    return m;
  }

  /** Posts a balanced entry. Idempotent: the same key returns the original entry. */
  post(input: PostInput): Promise<LedgerEntry> {
    return this.lock(input.environment).run(async () => {
      validateLines(input.lines);
      if (input.environment === 'production' && !PROD_ALLOWED_SOURCES.includes(input.source)) {
        throw new LedgerError(`Production ledger refuses source '${input.source}' — simulated or paper data can never touch real balances`);
      }
      if (input.environment !== 'production' && input.source === 'BROKER') {
        throw new LedgerError('Broker-sourced data belongs to the production book');
      }
      const existing = await this.col.list({ environment: input.environment, idempotencyKey: input.idempotencyKey } as Partial<LedgerEntry>);
      if (existing.length) return existing[0];
      const all = await this.entries(input.environment);
      const last = all[all.length - 1];
      const body: Omit<LedgerEntry, 'hash'> = {
        id: newId('led'),
        environment: input.environment,
        seq: (last?.seq ?? 0) + 1,
        ts: input.ts ?? this.clock(),
        type: input.type,
        memo: input.memo,
        lines: input.lines.map((l) => ({ account: l.account, amountPaise: l.amountPaise })),
        refType: input.refType,
        refId: input.refId,
        idempotencyKey: input.idempotencyKey,
        source: input.source,
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const entry: LedgerEntry = Object.freeze({ ...body, hash: hashEntry(body) }) as LedgerEntry;
      return this.col.insert(entry);
    });
  }

  async entries(env: Environment): Promise<LedgerEntry[]> {
    return (await this.col.list({ environment: env } as Partial<LedgerEntry>)).sort((a, b) => a.seq - b.seq);
  }

  async balances(env: Environment, asOf?: number): Promise<Map<string, Paise>> {
    const m = new Map<string, Paise>();
    for (const e of await this.entries(env)) {
      if (asOf !== undefined && e.ts > asOf) continue;
      for (const l of e.lines) m.set(l.account, (m.get(l.account) ?? 0) + l.amountPaise);
    }
    return m;
  }

  /** Recomputes every hash and link; any edit to a stored entry is detected. */
  async verifyChain(env: Environment): Promise<{ ok: boolean; entries: number; brokenAtSeq?: number; reason?: string }> {
    const es = await this.entries(env);
    let prev = GENESIS_HASH;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.seq !== i + 1) return { ok: false, entries: es.length, brokenAtSeq: e.seq, reason: 'sequence gap' };
      if (e.prevHash !== prev) return { ok: false, entries: es.length, brokenAtSeq: e.seq, reason: 'prevHash mismatch' };
      const { hash, ...body } = e;
      if (hashEntry(body) !== hash) return { ok: false, entries: es.length, brokenAtSeq: e.seq, reason: 'content hash mismatch' };
      if (e.lines.reduce((s, l) => s + l.amountPaise, 0) !== 0) return { ok: false, entries: es.length, brokenAtSeq: e.seq, reason: 'unbalanced' };
      prev = hash;
    }
    return { ok: true, entries: es.length };
  }
}

export function validateLines(lines: LedgerLine[]): void {
  if (lines.length < 2) throw new LedgerError('A double-entry posting needs at least two lines');
  let sum = 0;
  for (const l of lines) {
    if (!l.account || typeof l.account !== 'string') throw new LedgerError('Line without account');
    assertPaise(l.amountPaise, `line ${l.account}`);
    if (l.amountPaise === 0) throw new LedgerError(`Zero-amount line on ${l.account}`);
    sum += l.amountPaise;
  }
  if (sum !== 0) throw new LedgerError(`Entry is unbalanced by ${sum} paise`);
}

export function sumPrefix(b: Map<string, Paise>, prefix: string): Paise {
  let s = 0;
  for (const [k, v] of b) if (k.startsWith(prefix)) s += v;
  return s;
}

/** Drops zero-amount lines (e.g. no TDS on a buy) before posting. */
export function lines(...ls: [string, Paise][]): LedgerLine[] {
  return ls.filter(([, a]) => a !== 0).map(([account, amountPaise]) => ({ account, amountPaise }));
}
