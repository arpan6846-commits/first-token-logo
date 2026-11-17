// Owner authentication, secret access, AES-GCM token encryption and command signing.
// Secrets live only in Base44 backend secrets (Deno.env) and the worker's env.
// Nothing here ever returns a secret to the browser or writes one to a log.

import { canonicalJson, hmacSha256Hex, timingSafeEqualHex } from './core/hash.ts';

// deno-lint-ignore no-explicit-any
type Base44 = any;

export function secret(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new HttpError(503, `Server secret ${name} is not configured`);
  return v;
}
export function optionalSecret(name: string): string | undefined { return Deno.env.get(name) || undefined; }

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Only the single configured owner (Base44 admin with OWNER_EMAIL) may act. */
export async function requireOwner(base44: Base44): Promise<{ email: string; id: string }> {
  const user = await base44.auth.me().catch(() => null);
  if (!user) throw new HttpError(401, 'Not authenticated');
  const owner = secret('OWNER_EMAIL').toLowerCase();
  if (String(user.email).toLowerCase() !== owner || user.role !== 'admin') throw new HttpError(403, 'Only the owner can use this application');
  return { email: user.email, id: user.id };
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
export function errorResponse(e: unknown) {
  const status = e instanceof HttpError ? e.status : 500;
  const msg = e instanceof Error ? e.message : 'Internal error';
  return json({ error: msg }, status);
}

// ---- AES-GCM (key = 32 random bytes, base64, in TOKEN_ENCRYPTION_KEY) ----
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function key() {
  const raw = unb64(secret('TOKEN_ENCRYPTION_KEY'));
  if (raw.length !== 32) throw new HttpError(503, 'TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptToken(plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await key(), new TextEncoder().encode(plain)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function decryptToken(blob: string, aad: string): Promise<string> {
  const [v, iv, ct] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown token format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, await key(), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---- Commands (owner intents for the worker) ----
export const COMMAND_TYPES = [
  'APPROVE_SIGNAL', 'CANCEL_SIGNAL', 'SUBMIT_ORDER', 'CONFIRM_ORDER', 'CANCEL_ORDER', 'KILL_SWITCH', 'UPDATE_SETTINGS', 'CASH_FLOW',
  'RECONCILE', 'GENERATE_SIGNALS', 'DAILY_CLOSE', 'CONFIRM_FIRST_LIVE_ORDER', 'JOURNAL', 'APPLY_AI_REVIEW', 'CLOSE_UNKNOWN_ORDER', 'VENUE_ORDER_UPDATE', 'SET_COMPLIANCE',
] as const;
export type CommandType = typeof COMMAND_TYPES[number];

export function signCommand(c: { uid: string; type: string; environment: string; payload: unknown; requestedBy: string; requestedAt: number }): string {
  return hmacSha256Hex(secret('COMMAND_SIGNING_SECRET'), canonicalJson(c));
}
export function verifyCommandSignature(c: { uid: string; type: string; environment: string; payload: unknown; requestedBy: string; requestedAt: number }, sig: string, signingSecret: string): boolean {
  return timingSafeEqualHex(hmacSha256Hex(signingSecret, canonicalJson(c)), sig);
}
