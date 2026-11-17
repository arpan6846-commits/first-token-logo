// Integration tests for the Base44 + worker layers without network:
// fake Base44 entity API, real Base44Repo, real engine, real gateway protocol.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { createBase44Repo } from '../base44/shared/base44Repo.ts';
import { canonicalJson, hmacSha256Hex } from '../core/hash.ts';
import { ImmutableRecordError, UniqueConstraintError } from '../core/repo.ts';
import { MemoryNonceStore, verifyWebhook } from '../core/webhook.ts';
import { executeCommand, verifyCommand, type Command } from '../worker/commands.ts';
import { Gateway, createGatewayRepo } from '../worker/gatewayRepo.ts';
import { buyProposal, harness } from './helpers.ts';

/** Minimal in-memory imitation of the Base44 entities API (filter/create/update). */
function fakeEntities() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  let n = 0;
  return new Proxy({}, {
    get(_t, name: string) {
      if (!tables.has(name)) tables.set(name, new Map());
      const t = tables.get(name)!;
      return {
        async filter(q: Record<string, unknown> = {}, _sort?: string, limit = 50, skip = 0) {
          const rows = [...t.values()].filter((r) => Object.entries(q).every(([k, v]) => JSON.stringify(r[k]) === JSON.stringify(v)));
          return structuredClone(rows.slice(skip, skip + limit));
        },
        async create(d: Record<string, unknown>) { const id = `rec${++n}`; const r = { ...structuredClone(d), id, created_date: new Date().toISOString() }; t.set(id, r); return structuredClone(r); },
        async update(id: string, d: Record<string, unknown>) { const r = t.get(id); if (!r) throw new Error('nf'); Object.assign(r, structuredClone(d)); return structuredClone(r); },
      };
    },
  }) as Record<string, unknown>;
}

describe('Base44Repo mapping', () => {
  it('maps id⇄uid, paginates, enforces unique keys and append-only rules', async () => {
    const repo = createBase44Repo(fakeEntities());
    await repo.ledger.insert({ id: 'l1', environment: 'paper', seq: 1, idempotencyKey: 'k', ts: 1, type: 'DEPOSIT', memo: '', lines: [], source: 'PAPER_FEED', prevHash: '0', hash: '1' });
    assert.equal((await repo.ledger.get('l1'))?.id, 'l1');
    await assert.rejects(() => repo.ledger.insert({ id: 'l2', environment: 'paper', seq: 2, idempotencyKey: 'k', ts: 1, type: 'DEPOSIT', memo: '', lines: [], source: 'PAPER_FEED', prevHash: '0', hash: '1' }), { name: 'UniqueConstraintError' });
    await assert.rejects(() => repo.ledger.update('l1', { memo: 'x' }), { name: 'ImmutableRecordError' });
    for (let i = 0; i < 1203; i++) await repo.riskEvents.insert({ id: `r${i}`, environment: 'paper', ts: i, code: 'X', severity: 'INFO', message: '' });
    assert.equal((await repo.riskEvents.list({ environment: 'paper' })).length, 1203);
  });
  it('the full engine runs on Base44Repo (orders, fills, ledger chain, audit chain)', async () => {
    const repo = createBase44Repo(fakeEntities());
    const h = await harness('simulation', { repo });
    const s = await h.engine.settings();
    await repo.settings.update(s.id, { maxFeeToRiskPct: 1000, minRewardRisk: 0.5 });
    h.quote('INFY', 1500);
    const r = await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    assert.equal(r.order.status, 'FILLED');
    const dup = await h.engine.submitOrder({ ...buyProposal('simulation'), idempotencyKey: r.order.idempotencyKey }, { actor: 'owner' });
    assert.equal(dup.duplicate, true);
    assert.ok((await h.engine.ledger.verifyChain('simulation')).ok);
    assert.ok((await h.engine.verifyAudit()).ok);
    const fill = (await h.engine.fills())[0];
    await assert.rejects(() => repo.fills.update(fill.id, { price: 1 }), { name: 'ImmutableRecordError' });
    await repo.fills.update(fill.id, { reconciled: true });
  });
});

describe('worker ⇄ gateway protocol', () => {
  it('signed requests work; unsigned/tampered requests are refused', async () => {
    const backing = createBase44Repo(fakeEntities());
    const nonces = new MemoryNonceStore();
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c;
      const v = await verifyWebhook('gw-secret', raw, { get: (k) => (req.headers[k] as string) ?? null }, Date.now(), nonces);
      if (!v.ok) { res.writeHead(401); res.end(JSON.stringify({ error: v.reason })); return; }
      const b = JSON.parse(raw);
      const col = (backing as unknown as Record<string, { get: Function; list: Function; insert: Function; update: Function }>)[b.collection];
      try {
        const out = b.op === 'get' ? { doc: (await col.get(b.id)) ?? null } : b.op === 'list' ? { items: await col.list(b.filter) } : b.op === 'insert' ? { doc: await col.insert(b.doc) } : { doc: await col.update(b.id, b.patch) };
        res.writeHead(200); res.end(JSON.stringify(out));
      } catch (e) {
        const n = (e as Error).constructor.name;
        const code = n === 'UniqueConstraintError' ? 'UNIQUE' : n === 'ImmutableRecordError' ? 'IMMUTABLE' : undefined;
        res.writeHead(code ? 409 : 500); res.end(JSON.stringify({ error: (e as Error).message, code }));
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const repo = createGatewayRepo(new Gateway(url, 'gw-secret'));
      const h = await harness('paper', { repo });
      const s = await h.engine.settings();
      await repo.settings.update(s.id, { maxFeeToRiskPct: 1000, minRewardRisk: 0.5 });
      h.quote('INFY', 1500);
      const r = await h.engine.submitOrder(buyProposal('paper'), { actor: 'owner' });
      assert.equal(r.order.status, 'FILLED');
      assert.ok((await h.engine.ledger.verifyChain('paper')).ok);
      const firstAudit = (await repo.audit.list())[0];
      await assert.rejects(() => repo.audit.update(firstAudit.id, { action: 'x' } as never), ImmutableRecordError);
      const bad = await fetch(url, { method: 'POST', body: '{"op":"list","collection":"orders"}' });
      assert.equal(bad.status, 401);
      await assert.rejects(() => createGatewayRepo(new Gateway(url, 'wrong')).orders.list(), /bad signature/);
    } finally { server.close(); }
  });
});

describe('owner commands executed by the worker', () => {
  const sign = (c: Omit<Command, 'signature'>, secret: string) => hmacSha256Hex(secret, canonicalJson({ uid: c.uid, type: c.type, environment: c.environment, payload: c.payload, requestedBy: c.requestedBy, requestedAt: c.requestedAt }));
  it('verifies signatures and refuses tampered or stale commands', async () => {
    const c: Command = { uid: 'c1', type: 'KILL_SWITCH', environment: 'paper', payload: { active: true, reason: 'x' }, requestedBy: 'owner@x', requestedAt: Date.now() };
    assert.ok(verifyCommand({ ...c, signature: sign(c, 's') }, 's'));
    assert.ok(!verifyCommand({ ...c, payload: { active: false }, signature: sign(c, 's') }, 's'));
    const h = await harness('paper');
    await assert.rejects(() => executeCommand({ ...c, type: 'GENERATE_SIGNALS', requestedAt: h.clock.now() - 2 * 3600_000 }, { paper: h.engine }, h.clock.now()), /older than 1 hour/);
  });
  it('kill switch command blocks orders; journal and settings commands go through owner rules', async () => {
    const h = await harness('paper');
    const now = h.clock.now();
    await executeCommand({ uid: 'c2', type: 'KILL_SWITCH', environment: 'paper', payload: { active: true, reason: 'test' }, requestedBy: 'o', requestedAt: now }, { paper: h.engine }, now);
    h.quote('INFY', 1500);
    const r = await executeCommand({ uid: 'c3', type: 'SUBMIT_ORDER', environment: 'paper', payload: { proposal: buyProposal('paper') }, requestedBy: 'o', requestedAt: now }, { paper: h.engine }, now);
    assert.equal(r.status, 'RISK_REJECTED');
    const set = await executeCommand({ uid: 'c4', type: 'UPDATE_SETTINGS', environment: 'paper', payload: { patch: { maxRiskPerTradePct: 0.75 } }, requestedBy: 'o', requestedAt: now }, { paper: h.engine }, now);
    assert.equal(set.ok, false, 'risk change without phrase refused');
    const j = await executeCommand({ uid: 'c5', type: 'JOURNAL', environment: 'paper', payload: { entry: { kind: 'POST_TRADE', whatHappened: 'stop hit', rulesBroken: ['M7'] } }, requestedBy: 'o', requestedAt: now }, { paper: h.engine }, now);
    assert.ok(j.id);
  });
});

describe('entity schemas match engine records (no drift)', () => {
  it('every field written by the engine exists in the Base44 entity schema', async () => {
    const schemas = Object.fromEntries(readdirSync('base44/entities').map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(`base44/entities/${f}`, 'utf8'))]));
    const h = await harness('simulation');
    const s = await h.engine.settings();
    await h.repo.settings.update(s.id, { maxFeeToRiskPct: 1000, minRewardRisk: 0.5 });
    h.quote('INFY', 1500);
    await h.engine.submitOrder(buyProposal('simulation'), { actor: 'owner' });
    h.quote('INFY', 1570);
    await h.engine.onMarketUpdate();
    h.clock.advance(86_400_000);
    await h.engine.dailyClose('2026-11-18');
    await h.engine.reconcile('KITE');
    await h.engine.generateSignals([{ venue: 'KITE', symbol: 'INFY' }]);
    await h.engine.setKillSwitch(true, 'x', 'owner');
    const map: Record<string, string> = { orders: 'TradeOrders', fills: 'TradeFills', ledger: 'LedgerEntries', signals: 'AI_Signals', riskEvents: 'RiskEvents', logs: 'AutomationLogs', snapshots: 'DailySnapshots', reconciliations: 'ReconciliationRecords', compounding: 'CompoundingEvents', connections: 'APIConnections', settings: 'StrategySettings', audit: 'AuditLogs', system: 'SystemState' };
    for (const [col, ent] of Object.entries(map)) {
      const rows = await (h.repo as unknown as Record<string, { list(): Promise<Record<string, unknown>[]> }>)[col].list();
      assert.ok(rows.length > 0, `${col} produced no rows in this scenario`);
      const props = schemas[ent].properties as Record<string, unknown>;
      for (const r of rows) for (const k of Object.keys(r)) if (k !== 'id') assert.ok(k in props, `${ent} schema lacks field '${k}'`);
      for (const req of schemas[ent].required as string[]) if (req !== 'uid') for (const r of rows) assert.ok(req in r, `${ent}.${req} required but missing on a ${col} row`);
    }
  });
});
