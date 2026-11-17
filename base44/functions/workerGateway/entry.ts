// Data gateway for the external worker (the single writer). Every request is
// HMAC-signed with WORKER_GATEWAY_SECRET (timestamp + nonce). Append-only
// entities cannot be updated; only known entities are reachable; secrets are
// never returned (the encrypted Kite session is returned still encrypted).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { MemoryNonceStore, verifyWebhook } from '../../shared/core/webhook.ts';
import { createBase44Repo, COLLECTION_ENTITY } from '../../shared/base44Repo.ts';
import type { Repo } from '../../shared/core/repo.ts';
import { errorResponse, HttpError, json, secret } from '../../shared/security.ts';

const nonces = new MemoryNonceStore(); // per-isolate; ops are idempotent so cross-isolate replays are harmless
const CACHE_ENTITIES = new Set(['MarketData', 'Portfolio', 'Asset']);

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const raw = await req.text();
    const v = await verifyWebhook(secret('WORKER_GATEWAY_SECRET'), raw, req.headers, Date.now(), nonces, 2 * 60_000);
    if (!v.ok) throw new HttpError(401, `Gateway auth failed: ${v.reason}`);
    const b = JSON.parse(raw);
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole.entities;

    if (b.op === 'upsertCache') {
      if (!CACHE_ENTITIES.has(b.entity)) throw new HttpError(400, 'not a cache entity');
      const [cur] = await svc[b.entity].filter({ uid: b.doc.uid }, undefined, 1);
      return json({ ok: true, rec: cur ? await svc[b.entity].update(cur.id, b.doc) : await svc[b.entity].create(b.doc) });
    }
    if (b.op === 'pendingCommands') return json({ items: await svc.Commands.filter({ status: 'PENDING' }, 'requestedAt', 50) });
    if (b.op === 'commandSignature') {
      const [c] = await svc.Commands.filter({ uid: b.uid }, undefined, 1);
      return json({ signature: c?.signature ?? null });
    }
    if (b.op === 'finishCommand') {
      const [c] = await svc.Commands.filter({ uid: b.uid }, undefined, 1);
      if (!c) throw new HttpError(404, 'command not found');
      if (!['RUNNING', 'DONE', 'FAILED'].includes(b.status)) throw new HttpError(400, 'bad status');
      await svc.Commands.update(c.id, { status: b.status, result: b.result ?? {}, finishedAt: Date.now() });
      return json({ ok: true });
    }
    if (b.op === 'encryptedSession') {
      const [c] = await svc.APIConnections.filter({ uid: `conn_production_${b.venue}` }, undefined, 1);
      return json({ encryptedSession: c?.encryptedSession ?? null, sessionExpiresAt: c?.sessionExpiresAt ?? null });
    }
    if (b.op === 'userProfile') return json({ items: await svc.UserProfile.filter({}, undefined, 1) });

    const col = b.collection as keyof Repo;
    if (!(col in COLLECTION_ENTITY)) throw new HttpError(400, 'unknown collection');
    const repo = createBase44Repo(svc)[col];
    switch (b.op) {
      case 'get': return json({ doc: (await repo.get(b.id)) ?? null });
      case 'list': return json({ items: await repo.list(b.filter ?? {}) });
      case 'insert': return json({ doc: await repo.insert(b.doc) });
      case 'update': return json({ doc: await repo.update(b.id, b.patch) });
      default: throw new HttpError(400, 'unknown op');
    }
  } catch (e) {
    const name = (e as Error)?.constructor?.name;
    if (name === 'UniqueConstraintError') return json({ error: (e as Error).message, code: 'UNIQUE' }, 409);
    if (name === 'ImmutableRecordError') return json({ error: (e as Error).message, code: 'IMMUTABLE' }, 409);
    return errorResponse(e);
  }
});
