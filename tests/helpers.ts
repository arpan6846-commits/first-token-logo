import { PaperAdapter } from '../core/adapters/paper.ts';
import type { AdapterMode } from '../core/adapters/types.ts';
import { TradingEngine } from '../core/engine.ts';
import { SEED_INSTRUMENTS } from '../core/instruments.ts';
import { MarketDataCache } from '../core/marketData.ts';
import { createMemoryRepo, type Repo } from '../core/repo.ts';
import { RISK_CONFIRMATION_PHRASE } from '../core/settings.ts';
import type { Environment, Quote, Venue } from '../core/types.ts';

// Tuesday 2026-11-17 11:00 IST (NSE open)
export const T0 = Date.parse('2026-11-17T05:30:00Z');

export class Clock { t = T0; now = () => this.t; advance(ms: number) { this.t += ms; } }

export interface Harness {
  engine: TradingEngine; repo: Repo; market: MarketDataCache; clock: Clock; kite: PaperAdapter; cdx: PaperAdapter; placeCalls: { n: number };
  quote: (symbol: string, ltp: number, venue?: Venue, spread?: number) => Quote;
}

export async function harness(env: Environment = 'simulation', opts: { repo?: Repo; seed?: boolean } = {}): Promise<Harness> {
  const clock = new Clock();
  const repo = opts.repo ?? createMemoryRepo();
  const market = new MarketDataCache();
  const mode: AdapterMode = env === 'production' ? 'LIVE' : env === 'paper' ? 'PAPER' : 'SIMULATION';
  const ac = (s: string) => (SEED_INSTRUMENTS.find((i) => i.symbol === s)?.assetClass ?? 'EQUITY');
  const placeCalls = { n: 0 };
  // Holdings/cash reported by the "venue" mirror the internal book so reconciliation can match.
  let engineRef: TradingEngine | undefined;
  const venueCash = (v: Venue) => async () => ((await engineRef!.ledger.balances(env)).get(`ASSET:CASH:${v}`) ?? 0);
  const mk = (v: Venue) => {
    const a = new PaperAdapter(v, mode, (s) => market.quote(v, s), ac, clock.now);
    const orig = a.placeOrder.bind(a);
    a.placeOrder = async (r) => { placeCalls.n++; return orig(r); };
    return a;
  };
  const kite = mk('KITE'), cdx = mk('COINDCX');
  const engine = new TradingEngine({ repo, environment: env, adapters: { KITE: kite, COINDCX: cdx }, market, instruments: SEED_INSTRUMENTS, clock: clock.now });
  engineRef = engine;
  void venueCash;
  await engine.init({ seedCapital: opts.seed ?? env !== 'production' });
  const quote = (symbol: string, ltp: number, venue: Venue = ac(symbol) === 'CRYPTO' ? 'COINDCX' : 'KITE', spread = 0.1) => {
    const q: Quote = { symbol, venue, ltp, bid: ltp - spread / 2, ask: ltp + spread / 2, exchangeTs: clock.now(), receivedAt: clock.now(), source: env === 'production' ? 'LIVE' : env === 'paper' ? 'PAPER_FEED' : 'SIMULATED' };
    market.upsertQuote(q);
    return q;
  };
  return { engine, repo, market, clock, kite, cdx, placeCalls, quote };
}

/** Puts a production harness into a state where a live order is allowed (all gates satisfied). */
export async function makeProductionReady(h: Harness, rupees = { KITE: 5000, COINDCX: 2000, BANK: 3000 }) {
  const e = h.engine;
  for (const [v, r] of Object.entries(rupees)) await e.recordDeposit(v as Venue, r, 'owner', `dep-${v}`);
  const s = await e.settings();
  await h.repo.settings.update(s.id, { phase: 5, liveTradingEnabled: true, firstLiveOrderConfirmedAt: h.clock.now(), executionMode: 'manual_approval' });
  for (const v of ['KITE', 'COINDCX']) await h.repo.connections.update(`conn_production_${v}`, { status: 'AUTHENTICATED', permissions: { read: true, trade: true, withdraw: false }, sessionExpiresAt: h.clock.now() + 3600_000 });
  const sys = await e.system();
  await h.repo.system.update('system', { lastReconciliation: { ...(sys.lastReconciliation ?? {}), 'production:KITE': { ts: h.clock.now(), ok: true }, 'production:COINDCX': { ts: h.clock.now(), ok: true } } });
}

export const buyProposal = (env: Environment, over: Record<string, unknown> = {}) => ({
  environment: env, venue: 'KITE' as Venue, symbol: 'INFY', assetClass: 'EQUITY' as const, side: 'BUY' as const, qty: 1, orderType: 'LIMIT' as const,
  product: 'CNC' as const, limitPrice: 1500.05, stopPrice: 1480, targetPrice: 1560, idempotencyKey: `k-${Math.random()}`, ...over,
});

export { RISK_CONFIRMATION_PHRASE };
