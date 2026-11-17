// Kite postback (webhook) receiver. Authenticated by Kite's checksum
// sha256(order_id + order_timestamp + api_secret). It never changes balances
// itself: it queues a VENUE_ORDER_UPDATE so the worker re-fetches the order and
// trades from Kite and reconciles (the broker remains the source of truth).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { verifyKitePostback } from '../../shared/core/adapters/kite.ts';
import { newId } from '../../shared/core/hash.ts';
import { json, secret, signCommand } from '../../shared/security.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const raw = await req.text();
  let p: Record<string, string>;
  try { p = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  if (!verifyKitePostback(p as never, secret('KITE_API_SECRET'))) return json({ error: 'bad checksum' }, 401);
  const base44 = createClientFromRequest(req);
  const cmd = { uid: newId('cmd'), type: 'VENUE_ORDER_UPDATE', environment: 'production', payload: { venue: 'KITE', brokerOrderId: String(p.order_id), status: String(p.status), tag: p.tag ?? null }, requestedBy: 'kite-postback', requestedAt: Date.now() };
  await base44.asServiceRole.entities.Commands.create({ ...cmd, signature: signCommand(cmd), status: 'PENDING' });
  return json({ ok: true });
});
