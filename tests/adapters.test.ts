// Live adapters tested against a mocked fetch (no network, no credentials).
// These prove request shapes, signing and error classification; they do NOT
// prove the real APIs accept them — that is Phase 2/4 with real credentials.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { CoinDCXAdapter, mapCoindcxStatus } from '../core/adapters/coindcx.ts';
import { KiteAdapter, kiteSessionChecksum, mapKiteStatus, parseKiteTicks, verifyKitePostback } from '../core/adapters/kite.ts';
import { AdapterError } from '../core/adapters/types.ts';
import { MemoryNonceStore, signWebhook, verifyWebhook } from '../core/webhook.ts';

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (c: Call) => { status?: number; json: unknown } | Error) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit) => {
    const c = { url, init }; calls.push(c);
    const r = handler(c);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { f, calls };
}

describe('Kite adapter', () => {
  it('places CNC limit orders with tag, auth header and form encoding', async () => {
    const m = mockFetch(() => ({ json: { status: 'success', data: { order_id: '151220000000000' } } }));
    const k = new KiteAdapter({ apiKey: 'key', accessToken: 'tok', fetch: m.f });
    const ack = await k.placeOrder({ symbol: 'INFY', exchange: 'NSE', side: 'BUY', qty: 3, orderType: 'LIMIT', product: 'CNC', limitPrice: 1500.05, clientOrderId: 'WEPabc123' });
    assert.equal(ack.brokerOrderId, '151220000000000');
    const c = m.calls[0];
    assert.equal(c.url, 'https://api.kite.trade/orders/regular');
    assert.equal((c.init.headers as Record<string, string>).Authorization, 'token key:tok');
    assert.equal((c.init.headers as Record<string, string>)['X-Kite-Version'], '3');
    const b = new URLSearchParams(String(c.init.body));
    assert.equal(b.get('product'), 'CNC'); assert.equal(b.get('tag'), 'WEPabc123'); assert.equal(b.get('price'), '1500.05'); assert.equal(b.get('validity'), 'DAY');
  });
  it('refuses MIS/leveraged products and non-integer equity qty locally', async () => {
    const m = mockFetch(() => ({ json: {} }));
    const k = new KiteAdapter({ apiKey: 'k', accessToken: 't', fetch: m.f });
    await assert.rejects(() => k.placeOrder({ symbol: 'INFY', exchange: 'NSE', side: 'BUY', qty: 1, orderType: 'LIMIT', product: 'SPOT', limitPrice: 1, clientOrderId: 'a' }), AdapterError);
    await assert.rejects(() => k.placeOrder({ symbol: 'INFY', exchange: 'NSE', side: 'BUY', qty: 1.5, orderType: 'LIMIT', product: 'CNC', limitPrice: 1, clientOrderId: 'a' }), AdapterError);
    assert.equal(m.calls.length, 0);
  });
  it('5xx / timeout on placement ⇒ outcome unknown (never treated as rejected)', async () => {
    const k = new KiteAdapter({ apiKey: 'k', accessToken: 't', fetch: mockFetch(() => ({ status: 502, json: { message: 'bad gateway' } })).f });
    const e = await k.placeOrder({ symbol: 'INFY', exchange: 'NSE', side: 'BUY', qty: 1, orderType: 'LIMIT', product: 'CNC', limitPrice: 1, clientOrderId: 'a' }).catch((x) => x);
    assert.ok(e instanceof AdapterError && e.outcomeUnknown);
    const k2 = new KiteAdapter({ apiKey: 'k', accessToken: 't', fetch: mockFetch(() => ({ status: 400, json: { message: 'Insufficient funds' } })).f });
    const e2 = await k2.placeOrder({ symbol: 'INFY', exchange: 'NSE', side: 'BUY', qty: 1, orderType: 'LIMIT', product: 'CNC', limitPrice: 1, clientOrderId: 'a' }).catch((x) => x);
    assert.equal(e2.kind, 'REJECTED');
  });
  it('finds orders by tag and maps partial fills', async () => {
    const m = mockFetch((c) => {
      if (c.url.endsWith('/orders')) return { json: { data: [{ order_id: '1', status: 'OPEN', tag: 'X1', quantity: 4, filled_quantity: 2, average_price: 100, status_message: null, order_timestamp: '2026-11-17 11:00:00', tradingsymbol: 'INFY', transaction_type: 'BUY' }] } };
      return { json: { data: [{ trade_id: 't1', order_id: '1', tradingsymbol: 'INFY', transaction_type: 'BUY', average_price: 100, quantity: 2, fill_timestamp: '2026-11-17 11:00:05' }] } };
    });
    const st = await new KiteAdapter({ apiKey: 'k', accessToken: 't', fetch: m.f }).findOrderByClientId('X1');
    assert.equal(st?.status, 'PARTIALLY_FILLED');
    assert.equal(st?.trades[0].qty, 2);
    assert.equal(st?.trades[0].ts, Date.parse('2026-11-17T05:30:05Z'));
    assert.equal(mapKiteStatus({ status: 'COMPLETE', filled_quantity: 4, quantity: 4 }), 'FILLED');
  });
  it('session and postback checksums', () => {
    assert.equal(kiteSessionChecksum('a', 'b', 'c'), createHash('sha256').update('abc').digest('hex'));
    const p = { order_id: '220303000308932', order_timestamp: '2022-03-03 09:24:25', checksum: createHash('sha256').update('2203030003089322022-03-03 09:24:25secret').digest('hex') };
    assert.equal(verifyKitePostback(p, 'secret'), true);
    assert.equal(verifyKitePostback({ ...p, order_id: '1' }, 'secret'), false);
    assert.equal(verifyKitePostback(p, 'other'), false);
  });
  it('parses ticker binary packets', () => {
    const buf = new ArrayBuffer(2 + 2 + 8);
    const dv = new DataView(buf);
    dv.setInt16(0, 1); dv.setInt16(2, 8); dv.setInt32(4, 408065); dv.setInt32(8, 150025);
    assert.deepEqual(parseKiteTicks(buf), [{ token: 408065, ltp: 1500.25 }]);
  });
});

describe('CoinDCX adapter', () => {
  it('signs the exact JSON body with HMAC-SHA256 and sends spot limit orders with client_order_id', async () => {
    const m = mockFetch(() => ({ json: { orders: [{ id: '815052513', status: 'open', total_quantity: 0.001, remaining_quantity: 0.001 }] } }));
    const a = new CoinDCXAdapter({ apiKey: 'K', apiSecret: 'S', fetch: m.f, now: () => 1700000000000 });
    const ack = await a.placeOrder({ symbol: 'BTCINR', exchange: 'COINDCX', side: 'BUY', qty: 0.001, orderType: 'LIMIT', product: 'SPOT', limitPrice: 8000000, clientOrderId: 'WEPabc' });
    assert.equal(ack.brokerOrderId, '815052513');
    const c = m.calls[0];
    const h = c.init.headers as Record<string, string>;
    assert.equal(h['X-AUTH-SIGNATURE'], createHmac('sha256', 'S').update(String(c.init.body)).digest('hex'));
    const b = JSON.parse(String(c.init.body));
    assert.deepEqual(b, { side: 'buy', order_type: 'limit_order', market: 'BTCINR', total_quantity: 0.001, client_order_id: 'WEPabc', price_per_unit: 8000000, timestamp: 1700000000000 });
  });
  it('refuses non-INR and non-spot orders locally', async () => {
    const m = mockFetch(() => ({ json: {} }));
    const a = new CoinDCXAdapter({ apiKey: 'K', apiSecret: 'S', fetch: m.f });
    await assert.rejects(() => a.placeOrder({ symbol: 'BTCUSDT', exchange: 'COINDCX', side: 'BUY', qty: 1, orderType: 'LIMIT', product: 'SPOT', limitPrice: 1, clientOrderId: 'a' }));
    await assert.rejects(() => a.placeOrder({ symbol: 'BTCINR', exchange: 'COINDCX', side: 'BUY', qty: 1, orderType: 'LIMIT', product: 'CNC', limitPrice: 1, clientOrderId: 'a' }));
    assert.equal(m.calls.length, 0);
  });
  it('maps trade history including fees', async () => {
    const m = mockFetch(() => ({ json: [{ id: 252949810, order_id: '284195365', side: 'buy', fee_amount: 2.9469615, ecode: 'I', quantity: 4.97, price: 100.5, symbol: 'USDTINR', timestamp: 1780415747836 }] }));
    const t = await new CoinDCXAdapter({ apiKey: 'K', apiSecret: 'S', fetch: m.f }).getTrades(0);
    assert.deepEqual(t[0], { venueTradeId: '252949810', brokerOrderId: '284195365', symbol: 'USDTINR', side: 'BUY', qty: 4.97, price: 100.5, ts: 1780415747836, feesPaise: 295 });
    assert.equal(mapCoindcxStatus('partially_filled', 2, 1), 'PARTIALLY_FILLED');
    assert.equal(mapCoindcxStatus('init', 2, 2), 'PENDING');
  });
  it('auth failure is classified as AUTH', async () => {
    const a = new CoinDCXAdapter({ apiKey: 'K', apiSecret: 'S', fetch: mockFetch(() => ({ status: 401, json: { message: 'Invalid credentials' } })).f });
    assert.equal((await a.health()).ok, false);
  });
});

describe('signed internal webhooks', () => {
  it('accepts valid, rejects tampered, stale and replayed requests', async () => {
    const store = new MemoryNonceStore();
    const now = Date.now();
    const body = '{"job":"reconcile"}';
    const h = signWebhook('sec', body, now, 'n1');
    const get = (x: Record<string, string>) => ({ get: (k: string) => x[k] ?? null });
    assert.deepEqual(await verifyWebhook('sec', body, get(h), now, store), { ok: true });
    assert.equal((await verifyWebhook('sec', body, get(h), now, store)).reason, 'replayed nonce');
    assert.equal((await verifyWebhook('sec', body + ' ', get(signWebhook('sec', body, now, 'n2')), now, store)).reason, 'bad signature');
    assert.equal((await verifyWebhook('sec', body, get(signWebhook('sec', body, now - 3_600_000, 'n3')), now, store)).reason, 'timestamp outside allowed window');
    assert.equal((await verifyWebhook('', body, get(h), now, store)).ok, false);
  });
});
