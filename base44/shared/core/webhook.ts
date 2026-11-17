// Signed internal webhooks (worker → Base44 functions, and Kite postback relay).
// Signature = HMAC-SHA256(secret, `${timestamp}.${nonce}.${body}`), checked in
// constant time, with a 5-minute clock window and nonce replay protection.

import { hmacSha256Hex, timingSafeEqualHex } from './hash.ts';

export const WEBHOOK_HEADERS = { signature: 'x-we-signature', timestamp: 'x-we-timestamp', nonce: 'x-we-nonce' } as const;

export function signWebhook(secret: string, body: string, ts: number, nonce: string): Record<string, string> {
  return {
    [WEBHOOK_HEADERS.signature]: hmacSha256Hex(secret, `${ts}.${nonce}.${body}`),
    [WEBHOOK_HEADERS.timestamp]: String(ts),
    [WEBHOOK_HEADERS.nonce]: nonce,
  };
}

export interface NonceStore { seen(nonce: string): Promise<boolean>; remember(nonce: string, ttlMs: number): Promise<void> }

export class MemoryNonceStore implements NonceStore {
  private m = new Map<string, number>();
  async seen(n: string) { const t = this.m.get(n); return t !== undefined && t > Date.now(); }
  async remember(n: string, ttl: number) { this.m.set(n, Date.now() + ttl); if (this.m.size > 10_000) for (const [k, v] of this.m) if (v < Date.now()) this.m.delete(k); }
}

export async function verifyWebhook(secret: string, body: string, headers: { get(name: string): string | null }, now: number, nonces: NonceStore, windowMs = 5 * 60_000): Promise<{ ok: boolean; reason?: string }> {
  if (!secret) return { ok: false, reason: 'webhook secret not configured' };
  const sig = headers.get(WEBHOOK_HEADERS.signature), ts = Number(headers.get(WEBHOOK_HEADERS.timestamp)), nonce = headers.get(WEBHOOK_HEADERS.nonce);
  if (!sig || !nonce || !Number.isFinite(ts)) return { ok: false, reason: 'missing signature headers' };
  if (Math.abs(now - ts) > windowMs) return { ok: false, reason: 'timestamp outside allowed window' };
  if (!timingSafeEqualHex(hmacSha256Hex(secret, `${ts}.${nonce}.${body}`), sig.toLowerCase())) return { ok: false, reason: 'bad signature' };
  if (await nonces.seen(nonce)) return { ok: false, reason: 'replayed nonce' };
  await nonces.remember(nonce, windowMs * 2);
  return { ok: true };
}
