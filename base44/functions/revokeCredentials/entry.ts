// Emergency credential revocation: kill switch ON, Kite session invalidated at
// Kite (DELETE /session/token), stored session ciphertext erased, connections
// marked REVOKED. CoinDCX keys cannot be deleted via API — the response tells
// the owner to delete them in the CoinDCX dashboard and remove the secrets.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { KITE_API } from '../../shared/core/adapters/kite.ts';
import { newId } from '../../shared/core/hash.ts';
import { decryptToken, errorResponse, json, requireOwner, secret, signCommand } from '../../shared/security.ts';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const owner = await requireOwner(base44);
    const svc = base44.asServiceRole.entities;
    const ks = { active: true, reason: 'Credentials revoked by owner', activatedAt: Date.now(), activatedBy: 'owner' };
    const [sys] = await svc.SystemState.filter({ uid: 'system' }, undefined, 1);
    if (sys) await svc.SystemState.update(sys.id, { killSwitch: ks }); else await svc.SystemState.create({ uid: 'system', killSwitch: ks });
    const cmd = { uid: newId('cmd'), type: 'KILL_SWITCH', environment: 'production', payload: { active: true, reason: ks.reason, cancelOpenOrders: true }, requestedBy: owner.email, requestedAt: Date.now() };
    await svc.Commands.create({ ...cmd, signature: signCommand(cmd), status: 'PENDING' });

    const steps: string[] = ['Kill switch activated; worker will cancel open orders.'];
    const [kite] = await svc.APIConnections.filter({ uid: 'conn_production_KITE' }, undefined, 1);
    if (kite?.encryptedSession) {
      try {
        const tok = await decryptToken(kite.encryptedSession, 'KITE:production');
        const key = secret('KITE_API_KEY');
        await fetch(`${KITE_API}/session/token?api_key=${encodeURIComponent(key)}&access_token=${encodeURIComponent(tok)}`, { method: 'DELETE', headers: { 'X-Kite-Version': '3' } });
        steps.push('Kite access token invalidated at Kite.');
      } catch { steps.push('Could not reach Kite to invalidate the token — it expires at 06:00 IST; log out of Kite to be sure.'); }
    }
    for (const c of await svc.APIConnections.filter({ environment: 'production' })) {
      await svc.APIConnections.update(c.id, { status: 'REVOKED', encryptedSession: '', sessionExpiresAt: Date.now(), permissions: { read: false, trade: false, withdraw: false } });
    }
    steps.push('Stored session ciphertext erased; connections marked REVOKED.');
    steps.push('Manual: delete the CoinDCX API key in CoinDCX → API dashboard, regenerate the Kite API secret in the Kite developer console, and remove/rotate the corresponding Base44 secrets.');
    return json({ ok: true, steps });
  } catch (e) {
    return errorResponse(e);
  }
});
