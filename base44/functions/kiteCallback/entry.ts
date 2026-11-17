// Kite redirect URL. Verifies the one-time state, exchanges request_token for an
// access token server-side (checksum uses KITE_API_SECRET), stores it AES-GCM
// encrypted, and redirects back to the app. The token never reaches the browser.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { kiteCreateSession } from '../../shared/core/adapters/kite.ts';
import { sha256Hex, timingSafeEqualHex } from '../../shared/core/hash.ts';
import { encryptToken, secret } from '../../shared/security.ts';

/** Kite access tokens expire around 06:00 IST the next day. */
function nextKiteExpiry(now: number) {
  const ist = new Date(now + 330 * 60_000);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (ist.getUTCHours() >= 6 ? 1 : 0), 6, 0, 0));
  return d.getTime() - 330 * 60_000;
}

Deno.serve(async (req) => {
  const appUrl = Deno.env.get('APP_URL') ?? '/';
  const back = (q: string) => Response.redirect(`${appUrl}/connections?${q}`, 302);
  try {
    const u = new URL(req.url);
    const requestToken = u.searchParams.get('request_token'), state = u.searchParams.get('state'), status = u.searchParams.get('status');
    if (status !== 'success' || !requestToken || !state) return back('kite=failed');
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole.entities;
    const [conn] = await svc.APIConnections.filter({ uid: 'conn_production_KITE' }, undefined, 1);
    const [hash, exp] = String(conn?.loginStateHash ?? '').split(':');
    if (!hash || Number(exp) < Date.now() || !timingSafeEqualHex(sha256Hex(state), hash)) return back('kite=invalid_state');
    const { accessToken } = await kiteCreateSession((a, b) => fetch(a, b), secret('KITE_API_KEY'), requestToken, secret('KITE_API_SECRET'));
    await svc.APIConnections.update(conn.id, {
      encryptedSession: await encryptToken(accessToken, 'KITE:production'), loginStateHash: '', status: 'AUTHENTICATED',
      sessionExpiresAt: nextKiteExpiry(Date.now()), lastError: '',
      permissions: { read: true, trade: true, withdraw: false },
    });
    return back('kite=ok');
  } catch (e) {
    console.error('kiteCallback failed', (e as Error).message); // message never contains the token
    return back('kite=error');
  }
});
