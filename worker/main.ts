// Wealth Engine AI — persistent worker (Deno). Single writer and executor.
//   deno run --allow-net --allow-env worker/main.ts
// Run it on a host with a static IP if the broker requires one for order APIs.
// Environments: WORKER_ENVS=paper,production (production only after Phase 4/5).

import { CoinDCXAdapter } from '../core/adapters/coindcx.ts';
import { KiteAdapter } from '../core/adapters/kite.ts';
import { PaperAdapter } from '../core/adapters/paper.ts';
import { TradingEngine } from '../core/engine.ts';
import { SEED_INSTRUMENTS } from '../core/instruments.ts';
import { isNseOpen, istDate, istParts } from '../core/marketHours.ts';
import { MarketDataCache } from '../core/marketData.ts';
import { toPaise } from '../core/money.ts';
import type { Environment, Instrument, Venue } from '../core/types.ts';
import { executeCommand, verifyCommand, type Command } from './commands.ts';
import { CandleStore, startCoindcxPolling, startKiteTicker } from './feeds.ts';
import { Gateway, createGatewayRepo } from './gatewayRepo.ts';

const env = (k: string, required = true) => { const v = Deno.env.get(k); if (!v && required) throw new Error(`Missing env ${k}`); return v ?? ''; };
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`); // never log secrets

const gateway = new Gateway(env('WORKER_GATEWAY_URL'), env('WORKER_GATEWAY_SECRET'));
const COMMAND_SECRET = env('COMMAND_SIGNING_SECRET');
const ENVS = env('WORKER_ENVS', false).split(',').map((s) => s.trim()).filter(Boolean) as Environment[];
if (!ENVS.length) ENVS.push('paper');
if (ENVS.includes('simulation')) throw new Error('Simulation runs in the browser; the worker serves paper/production only');

// Watchlist: "INFY,HCLTECH,TATASTEEL" + "BTCINR,ETHINR"
const STOCKS = env('WATCHLIST_STOCKS', false).split(',').map((s) => s.trim()).filter(Boolean);
const CRYPTO = env('WATCHLIST_CRYPTO', false).split(',').map((s) => s.trim()).filter(Boolean);
const INDEX_SYMBOLS = ['NIFTY 50', 'NIFTY IT', 'NIFTY BANK', 'NIFTY METAL', 'NIFTY FMCG', 'NIFTY PHARMA'];

const market = new MarketDataCache();
const repo = createGatewayRepo(gateway);
const candles = new CandleStore(market);

// ---- token decryption (same AES-GCM scheme as base44/shared/security.ts) ----
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decrypt(blob: string, aad: string) {
  const k = await crypto.subtle.importKey('raw', unb64(env('TOKEN_ENCRYPTION_KEY')), 'AES-GCM', false, ['decrypt']);
  const [, iv, ct] = blob.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, k, unb64(ct)));
}

// ---- live read-only adapters (market data for paper; orders for production) ----
let kite: KiteAdapter | undefined;
let kiteTokenBlob = '';
const cdxKey = env('COINDCX_API_KEY', false), cdxSecret = env('COINDCX_API_SECRET', false);
const cdx = cdxKey && cdxSecret ? new CoinDCXAdapter({ apiKey: cdxKey, apiSecret: cdxSecret }) : undefined;

async function refreshKite(): Promise<void> {
  const r = await gateway.call<{ encryptedSession: string | null; sessionExpiresAt: number | null }>({ op: 'encryptedSession', venue: 'KITE' });
  if (!r.encryptedSession || (r.sessionExpiresAt ?? 0) < Date.now()) { if (kite) log('kite session expired/absent — owner must log in'); kite = undefined; kiteTokenBlob = ''; return; }
  if (r.encryptedSession === kiteTokenBlob) return;
  kiteTokenBlob = r.encryptedSession;
  kite = new KiteAdapter({ apiKey: env('KITE_API_KEY'), accessToken: await decrypt(r.encryptedSession, 'KITE:production') });
  const meta = await kite.loadInstruments([...STOCKS, ...INDEX_SYMBOLS]).catch((e) => { log(`instrument load failed: ${e.message}`); return []; });
  instruments = instruments.map((i) => { const m = meta.find((x) => x.symbol === i.symbol && i.venue === 'KITE'); return m ? { ...i, tickSize: m.tickSize, lotSize: m.lotSize, instrumentToken: m.token } : i; });
  for (const e of Object.values(engines)) e?.setInstruments(instruments);
  log('kite session loaded (token decrypted in memory only)');
}

let instruments: Instrument[] = [
  ...SEED_INSTRUMENTS.filter((i) => (i.venue === 'KITE' && STOCKS.includes(i.symbol)) || (i.venue === 'COINDCX' && CRYPTO.includes(i.symbol))),
  ...STOCKS.filter((s) => !SEED_INSTRUMENTS.some((i) => i.symbol === s)).map((s): Instrument => ({ symbol: s, venue: 'KITE', assetClass: 'EQUITY', exchange: 'NSE', tickSize: 0.05, lotSize: 1, minQty: 1, qtyDecimals: 0, minNotionalPaise: 0, fnoEligible: false })),
];

// ---- engines ----
const engines: Partial<Record<Environment, TradingEngine>> = {};
for (const e of ENVS) {
  const assetClassOf = (s: string) => (instruments.find((i) => i.symbol === s)?.assetClass ?? 'EQUITY');
  const adapters = e === 'paper'
    ? { KITE: new PaperAdapter('KITE', 'PAPER', (s) => market.quote('KITE', s), assetClassOf), COINDCX: new PaperAdapter('COINDCX', 'PAPER', (s) => market.quote('COINDCX', s), assetClassOf) }
    : {};
  engines[e] = new TradingEngine({ repo, environment: e, adapters, market, instruments });
  await engines[e]!.init({ seedCapital: e === 'paper' });
  log(`${e} engine ready`);
}

async function syncProductionAdapters() {
  const p = engines.production;
  if (!p) return;
  await refreshKite().catch((e) => log(`kite refresh failed: ${e.message}`));
  p.setAdapter('KITE', kite);
  p.setAdapter('COINDCX', cdx);
  for (const v of ['KITE', 'COINDCX'] as Venue[]) {
    const c = await repo.connections.get(`conn_production_${v}`);
    if (c && p.hasAdapter(v) && c.status !== 'REVOKED' && v === 'COINDCX' && c.status === 'NOT_CONFIGURED') await repo.connections.update(c.id, { status: 'CREDENTIALS_PRESENT' });
  }
}

// ---- feeds ----
await syncProductionAdapters();
let stopKite: (() => void) | undefined;
const stopCdx = cdx && CRYPTO.length ? startCoindcxPolling(cdx, CRYPTO, market, candles, log) : undefined;
async function ensureKiteFeed() {
  if (kite && isNseOpen(Date.now()) && !stopKite) stopKite = startKiteTicker(kite, [...STOCKS, ...INDEX_SYMBOLS], market, candles, log);
  if ((!kite || !isNseOpen(Date.now())) && stopKite) { stopKite(); stopKite = undefined; }
}
async function bootstrapCandles() {
  const now = Date.now();
  for (const s of CRYPTO) if (cdx) { try { await cdx.loadMarkets(); candles.seed('COINDCX', s, await cdx.getCandles(s, '5m', now - 20 * 86_400_000, now)); } catch (e) { log(`crypto history ${s}: ${(e as Error).message}`); } }
  for (const s of [...STOCKS, ...INDEX_SYMBOLS]) if (kite) { try { candles.seed('KITE', s, await kite.getCandles(s, '5m', now - 30 * 86_400_000, now)); } catch (e) { log(`stock history ${s}: ${(e as Error).message}`); } }
}
await bootstrapCandles();

// ---- loops ----
let busy = false;
async function tick() {
  if (busy) return; // single writer: never overlap
  busy = true;
  const now = Date.now();
  try {
    candles.flush(now);
    // 1. owner commands
    const { items } = await gateway.call<{ items: (Command & { status: string })[] }>({ op: 'pendingCommands' });
    for (const c of items) {
      const { signature } = await gateway.call<{ signature: string | null }>({ op: 'commandSignature', uid: c.uid });
      if (!verifyCommand({ ...c, signature: signature ?? undefined }, COMMAND_SECRET)) { await gateway.call({ op: 'finishCommand', uid: c.uid, status: 'FAILED', result: { error: 'bad signature' } }); continue; }
      await gateway.call({ op: 'finishCommand', uid: c.uid, status: 'RUNNING' });
      try {
        if (c.type === 'SET_COMPLIANCE') { await gateway.call({ op: 'upsertCache', entity: 'UserProfile', doc: { uid: 'owner', email: c.requestedBy, complianceTicks: c.payload.ticks } }); }
        const result = c.type === 'SET_COMPLIANCE' ? { ok: true } : await executeCommand(c, engines, now);
        await gateway.call({ op: 'finishCommand', uid: c.uid, status: 'DONE', result: JSON.parse(JSON.stringify(result)) });
      } catch (e) { await gateway.call({ op: 'finishCommand', uid: c.uid, status: 'FAILED', result: { error: (e as Error).message } }); }
    }
    // 2. market updates → order sync, armed-signal triggers, exits, loss latches
    for (const e of Object.values(engines)) await e!.onMarketUpdate().catch((err) => log(`market update ${e!.env}: ${err.message}`));
  } catch (e) {
    log(`tick error: ${(e as Error).message}`);
  } finally { busy = false; }
}

async function scheduled() {
  const now = Date.now();
  const { date, minutes } = istParts(now);
  for (const e of Object.values(engines)) {
    const s = await e!.settings();
    const nse = isNseOpen(now);
    // signal generation on closed bars (market-hours aware for stocks; crypto only when feed healthy)
    const stockBar = Math.floor(now / (15 * 60_000));
    if (nse) await e!.runJob('signals-stocks', `sig:${e!.env}:15m:${stockBar}`, async () => `${(await e!.generateSignals(STOCKS.map((symbol) => ({ venue: 'KITE' as Venue, symbol })))).length} stock signals`);
    const cryptoBar = Math.floor(now / (60 * 60_000));
    if (CRYPTO.length && market.feedHealth('COINDCX', now, s.maxQuoteAgeMs * 4).healthy) await e!.runJob('signals-crypto', `sig:${e!.env}:1h:${cryptoBar}`, async () => `${(await e!.generateSignals(CRYPTO.map((symbol) => ({ venue: 'COINDCX' as Venue, symbol })))).length} crypto signals`);
    // reconciliation every 30 min (production needs it fresh to trade)
    for (const v of ['KITE', 'COINDCX'] as Venue[]) {
      if (e!.env === 'production' && !e!.hasAdapter(v)) continue;
      await e!.runJob(`reconcile-${v}`, `rec:${e!.env}:${v}:${Math.floor(now / 1_800_000)}`, async () => (await e!.reconcile(v)).message);
    }
    // daily close (tax reserve, compounding, snapshot) at 23:50 IST
    if (minutes >= 23 * 60 + 50) await e!.dailyClose(date);
    // portfolio cache for the dashboard
    const eq = await e!.equity();
    await gateway.call({ op: 'upsertCache', entity: 'Portfolio', doc: { uid: `portfolio_${e!.env}`, environment: e!.env, netEquityPaise: eq.netEquityPaise, cashPaise: eq.cashPaise, marketValuePaise: eq.marketValuePaise, unrealizedPaise: eq.unrealizedPaise, realizedPaise: eq.realizedPaise, feesPaise: eq.feesPaise, taxReservePaise: eq.taxReservePaise, reinvestedPaise: eq.reinvestedPaise, cashByVenue: eq.cashByVenue, exposureByClass: eq.exposureByClass, marksComplete: eq.marksComplete, markSources: eq.markSources, asOf: now } });
    await e!.healthCheck();
  }
  // latest quotes for the UI
  for (const [, q] of market.allQuotes()) await gateway.call({ op: 'upsertCache', entity: 'MarketData', doc: { uid: `md_${q.venue}_${q.symbol}_quote`, venue: q.venue, symbol: q.symbol, timeframe: 'quote', quote: q, source: q.source, exchangeTs: q.exchangeTs, receivedAt: q.receivedAt } }).catch(() => undefined);
  await repo.system.update('system', { workerHeartbeatAt: now } as never).catch(() => undefined);
}

log(`worker started: envs=${ENVS.join(',')} stocks=${STOCKS.length} crypto=${CRYPTO.length} startingCapital=₹${toPaise(10000) / 100}`);
setInterval(tick, 5_000);
setInterval(() => scheduled().catch((e) => log(`scheduler: ${e.message}`)), 60_000);
setInterval(() => syncProductionAdapters().then(ensureKiteFeed).catch((e) => log(`adapter sync: ${e.message}`)), 60_000);
await ensureKiteFeed();
Deno.addSignalListener?.('SIGTERM', () => { stopKite?.(); stopCdx?.(); log('worker stopping'); Deno.exit(0); });
void istDate;
