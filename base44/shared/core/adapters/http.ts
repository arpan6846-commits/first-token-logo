// Small fetch wrapper shared by the live adapters: timeouts, error
// classification, and no secret ever placed in an error message or log.

import { AdapterError, type AdapterErrorKind } from './types.ts';

export interface HttpOpts { method?: 'GET' | 'POST' | 'DELETE' | 'PUT'; headers?: Record<string, string>; body?: string; timeoutMs?: number; isOrderPlacement?: boolean }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function httpJson<T = unknown>(fetchFn: FetchLike, url: string, o: HttpOpts = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetchFn(url, { method: o.method ?? 'GET', headers: o.headers, body: o.body, signal: ctrl.signal });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    throw new AdapterError(aborted ? 'TIMEOUT' : 'NETWORK', `${aborted ? 'Timeout' : 'Network error'} calling ${redact(url)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    let kind: AdapterErrorKind = 'INVALID';
    if (res.status === 401 || res.status === 403) kind = 'AUTH';
    else if (res.status === 429) kind = 'RATE_LIMIT';
    else if (res.status >= 500) kind = o.isOrderPlacement ? 'NETWORK' : 'UNAVAILABLE'; // 5xx on placement ⇒ outcome unknown
    else if (o.isOrderPlacement) kind = 'REJECTED';
    const msg = (data as { message?: string })?.message ?? `HTTP ${res.status}`;
    throw new AdapterError(kind, `${msg} (${res.status} ${redact(url)})`, data);
  }
  return data as T;
}

function redact(url: string) { return url.replace(/(api_key|access_token|token)=[^&]+/gi, '$1=***'); }

/** Parses "YYYY-MM-DD HH:MM:SS" in IST to epoch ms. */
export function parseIst(s?: string | null): number {
  if (!s) return Date.now();
  return Date.parse(s.replace(' ', 'T') + '+05:30');
}
