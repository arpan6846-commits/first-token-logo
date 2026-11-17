// Repo over the Base44 `workerGateway` function. Every request is HMAC-signed.
import { newId } from '../core/hash.ts';
import { ImmutableRecordError, UniqueConstraintError, type Collection, type Repo } from '../core/repo.ts';
import { signWebhook } from '../core/webhook.ts';

export class Gateway {
  constructor(private url: string, private secret: string) {}
  async call<T>(body: Record<string, unknown>): Promise<T> {
    const raw = JSON.stringify(body);
    const ts = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signWebhook(this.secret, raw, ts + attempt, newId('n')) }, body: raw }).catch((e) => e as Error);
      if (res instanceof Error) { if (attempt === 2) throw new Error(`gateway unreachable: ${res.message}`); await sleep(500 * 2 ** attempt); continue; }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === 'UNIQUE') throw new UniqueConstraintError(data.error);
      if (res.status === 409 && data.code === 'IMMUTABLE') throw new ImmutableRecordError(data.error);
      if (res.status >= 500 && attempt < 2 && body.op !== 'insert') { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`gateway ${body.op} ${String(body.collection ?? body.entity ?? '')}: ${data.error ?? res.status}`);
      return data as T;
    }
    throw new Error('unreachable');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class GatewayCollection<T extends { id: string }> implements Collection<T> {
  constructor(private g: Gateway, private collection: string) {}
  async get(id: string) { return (await this.g.call<{ doc: T | null }>({ op: 'get', collection: this.collection, id })).doc ?? undefined; }
  async list(filter: Partial<T> = {}) { return (await this.g.call<{ items: T[] }>({ op: 'list', collection: this.collection, filter })).items; }
  async insert(doc: T) { return (await this.g.call<{ doc: T }>({ op: 'insert', collection: this.collection, doc })).doc; }
  async update(id: string, patch: Partial<T>) { return (await this.g.call<{ doc: T }>({ op: 'update', collection: this.collection, id, patch })).doc; }
}

export function createGatewayRepo(g: Gateway): Repo {
  const names = ['orders', 'fills', 'ledger', 'signals', 'riskEvents', 'logs', 'snapshots', 'reconciliations', 'compounding', 'connections', 'journal', 'settings', 'audit', 'system'];
  return Object.fromEntries(names.map((n) => [n, new GatewayCollection(g, n)])) as unknown as Repo;
}
