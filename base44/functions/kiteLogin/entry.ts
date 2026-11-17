// Owner starts the daily Kite login. Returns the official Kite login URL with a
// one-time state nonce (only its hash is stored) so the callback can prove the
// redirect belongs to a login the owner started. No password/TOTP is ever handled here.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { kiteLoginUrl } from '../../shared/core/adapters/kite.ts';
import { sha256Hex, toHex } from '../../shared/core/hash.ts';
import { errorResponse, json, requireOwner, secret } from '../../shared/security.ts';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    await requireOwner(base44);
    const state = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const svc = base44.asServiceRole.entities;
    const [conn] = await svc.APIConnections.filter({ uid: 'conn_production_KITE' }, undefined, 1);
    const stored = `${sha256Hex(state)}:${Date.now() + 10 * 60_000}`;
    if (conn) await svc.APIConnections.update(conn.id, { loginStateHash: stored });
    else await svc.APIConnections.create({ uid: 'conn_production_KITE', venue: 'KITE', environment: 'production', status: 'CREDENTIALS_PRESENT', permissions: { read: true, trade: false, withdraw: false }, loginStateHash: stored });
    const url = `${kiteLoginUrl(secret('KITE_API_KEY'))}&redirect_params=${encodeURIComponent(`state=${state}`)}`;
    return json({ url, expiresInSec: 600 });
  } catch (e) {
    return errorResponse(e);
  }
});
