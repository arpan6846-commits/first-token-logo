// In-browser SIMULATION runtime: the real engine (core/) on a memory repo with a
// seeded synthetic market. Everything it produces is labelled SIMULATED and
// lives in a separate "simulation" book. State persists in localStorage as a
// compact replay log (seed + steps + owner actions are re-derived from the repo dump).

import { PaperAdapter } from '@core/adapters/paper.ts';
import { backtest } from '@core/backtest.ts';
import { TradingEngine } from '@core/engine.ts';
import { newId } from '@core/hash.ts';
import { SECTOR_INDEX, SEED_INSTRUMENTS, SYNTHETIC_UNIVERSE } from '@core/instruments.ts';
import { isNseOpen, istDate } from '@core/marketHours.ts';
import { MarketDataCache, SyntheticMarket, type SyntheticSymbol } from '@core/marketData.ts';
import { resample } from '@core/priceAction.ts';
import { createMemoryRepo } from '@core/repo.ts';
import { scriptedLongSetup } from '@core/scenarios.ts';
import type { Candle, JournalEntry, Timeframe, Venue } from '@core/types.ts';
import { TIMEFRAME_MINUTES } from '@core/types.ts';
import type { AppState } from './types.ts';

const KEY = 'wealth-engine-sim-v1';
const STEP = 5 * 60_000;
const TFS: Timeframe[] = ['15m', '1h', '4h', '1d'];

interface Persisted { seed: number; startTs: number; steps: number; scenarios: { atStep: number; symbol: string }[]; repo: Record<string, unknown[]> }

function lastSessionOpen(now: number): number {
  // most recent weekday 09:15 IST at or before now
  let t = now;
  for (let i = 0; i < 8; i++) {
    const d = new Date(t + 330 * 60_000);
    const open = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 15) - 330 * 60_000;
    const wd = new Date(open + 330 * 60_000).getUTCDay();
    if (wd !== 0 && wd !== 6 && open <= now) return open;
    t -= 86_400_000;
  }
  return now;
}

export class SimRuntime {
  repo = createMemoryRepo();
  market = new MarketDataCache();
  engine!: TradingEngine;
  private synth!: SyntheticMarket;
  private base = new Map<string, Candle[]>();
  private clock = 0;
  private p!: Persisted;

  async init(): Promise<void> {
    let saved: Persisted | undefined;
    try { const raw = localStorage.getItem(KEY); if (raw) saved = JSON.parse(raw); } catch { saved = undefined; }
    this.p = saved ?? { seed: Math.floor(Math.random() * 1e9), startTs: lastSessionOpen(Date.now()), steps: 0, scenarios: [], repo: {} };
    this.clock = this.p.startTs;
    this.synth = new SyntheticMarket(SYNTHETIC_UNIVERSE, this.p.seed);
    for (const s of SYNTHETIC_UNIVERSE) this.base.set(s.symbol, this.synth.history(s, this.clock, 1500));
    const ac = (s: string) => SEED_INSTRUMENTS.find((i) => i.symbol === s)?.assetClass ?? 'EQUITY';
    const now = () => this.clock;
    this.engine = new TradingEngine({
      repo: this.repo, environment: 'simulation', market: this.market, instruments: SEED_INSTRUMENTS, clock: now,
      adapters: { KITE: new PaperAdapter('KITE', 'SIMULATION', (s) => this.market.quote('KITE', s), ac, now), COINDCX: new PaperAdapter('COINDCX', 'SIMULATION', (s) => this.market.quote('COINDCX', s), ac, now) },
    });
    // replay the market (deterministic from the seed), then restore the books
    const replay = this.p.steps;
    for (let i = 0; i < replay; i++) { this.advanceMarket(); for (const sc of this.p.scenarios.filter((x) => x.atStep === i + 1)) this.injectScenario(sc.symbol); }
    this.publish(true);
    if (saved) for (const [name, rows] of Object.entries(saved.repo)) this.repo.all[name]?.load(rows as { id: string }[]);
    await this.engine.init({ seedCapital: true });
    // The simulated venue's order book is not persisted: resting orders from a previous
    // browser session cannot fill any more, so close them explicitly (never silently).
    for (const o of await this.engine.orders()) {
      if (['OPEN', 'PARTIALLY_FILLED', 'SUBMITTING', 'UNKNOWN'].includes(o.status)) {
        await this.repo.orders.update(o.id, { status: o.filledQty > 0 ? 'CANCELLED' : 'EXPIRED', rejectionReason: 'Simulation venue restarted (page reload) — resting order closed', updatedAt: this.clock });
      }
    }
    this.save();
  }

  now() { return this.clock; }

  private sym(symbol: string): SyntheticSymbol { return SYNTHETIC_UNIVERSE.find((s) => s.symbol === symbol)!; }

  private advanceMarket() {
    this.clock += STEP;
    const t = this.clock - STEP;
    for (const s of SYNTHETIC_UNIVERSE) {
      if (s.session === 'NSE' && !isNseOpen(t)) continue;
      const arr = this.base.get(s.symbol)!;
      arr.push(this.synth.nextCandle(s, t));
      if (arr.length > 2600) arr.splice(0, arr.length - 2600);
    }
  }

  private publish(all = false) {
    for (const s of SYNTHETIC_UNIVERSE) {
      const b = this.base.get(s.symbol)!;
      this.market.upsertCandles(s.venue, s.symbol, '5m', b);
      if (all || this.clock % (15 * 60_000) === 0) for (const tf of TFS) this.market.upsertCandles(s.venue, s.symbol, tf, resample(b, TIMEFRAME_MINUTES[tf] * 60_000));
      const last = b[b.length - 1];
      const live = s.session === '24x7' || isNseOpen(this.clock - 1);
      // Outside NSE hours the last quote keeps its old timestamp, so the engine sees it as stale.
      if (last && (live || !this.market.quote(s.venue, s.symbol))) this.market.upsertQuote(this.synth.quoteFrom(s, last, live ? this.clock : last.ts + STEP));
    }
  }

  private injectScenario(symbol: string) {
    const s = this.sym(symbol);
    const tf = s.session === 'NSE' ? 15 * 60_000 : 60 * 60_000;
    const end = Math.floor(this.clock / tf) * tf;
    const ref = this.base.get(symbol)!.at(-1)!.close;
    const setup = scriptedLongSetup(end, tf, ref, s.tick);
    // expand each scripted bar into 5m bars so every timeframe is consistent
    const per = tf / STEP;
    const out: Candle[] = [];
    for (const c of setup) for (let k = 0; k < per; k++) {
      const f = (k + 1) / per, o = k === 0 ? c.open : out[out.length - 1].close;
      const cl = c.open + (c.close - c.open) * f;
      out.push({ ts: c.ts + k * STEP, open: o, high: k === per - 1 ? c.high : Math.max(o, cl), low: k === 0 ? c.low : Math.min(o, cl), close: Number(cl.toFixed(4)), volume: Math.round(c.volume / per) });
    }
    // The scripted setup replaces this symbol's history so its own levels (not random-walk
    // pivots) define territory and the price-action target.
    this.base.set(symbol, out);
    // keep the synthetic walk continuing from the scenario's last price
    (this.synth as unknown as { state: Map<string, { price: number }> }).state.get(symbol)!.price = out[out.length - 1].close;
  }

  async step(bars: number) {
    let lastDay = istDate(this.clock);
    for (let i = 0; i < bars; i++) {
      this.advanceMarket();
      this.p.steps++;
      this.publish();
      await this.engine.onMarketUpdate();
      const day = istDate(this.clock);
      if (day !== lastDay) { await this.engine.dailyClose(lastDay); lastDay = day; }
    }
    this.publish(true);
    await this.engine.onMarketUpdate();
    this.save();
  }

  async loadScenario(symbol: string) {
    const sector = SEED_INSTRUMENTS.find((i) => i.symbol === symbol)?.sector;
    const index = sector ? SECTOR_INDEX[sector] : undefined;
    for (const sym of [symbol, ...(index && SYNTHETIC_UNIVERSE.some((x) => x.symbol === index) ? [index] : [])]) {
      this.injectScenario(sym);
      this.p.scenarios.push({ atStep: this.p.steps, symbol: sym });
    }
    this.publish(true);
    await this.engine.audit('owner', 'SIM_SCENARIO_LOADED', { symbol, sectorIndex: index, note: 'Scripted SIMULATED setup injected for demonstration' });
    this.save();
  }

  async journal(entry: Omit<JournalEntry, 'id' | 'environment' | 'ts'>) {
    await this.repo.journal.insert({ ...entry, id: newId('jrn'), environment: 'simulation', ts: this.clock } as JournalEntry);
    this.save();
  }

  candles(venue: Venue, symbol: string, tf: Timeframe) { return this.market.closedCandles(venue, symbol, tf, this.clock); }

  runBacktest(symbol: string) {
    const inst = SEED_INSTRUMENTS.find((i) => i.symbol === symbol);
    if (!inst) return undefined;
    const ttf = inst.assetClass === 'EQUITY' ? '15m' : '1h';
    return backtest({ instrument: inst, base: this.base.get(symbol)!, baseTf: '5m', ttf, step: 2 });
  }

  save() {
    const repo: Record<string, unknown[]> = {};
    for (const [k, c] of Object.entries(this.repo.all)) repo[k] = c.dump();
    try { localStorage.setItem(KEY, JSON.stringify({ ...this.p, repo })); } catch { /* storage full or blocked: the session still works in memory */ }
  }

  static reset() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

  async snapshotState(): Promise<Partial<AppState>> {
    const e = this.engine;
    const [eq, orders, fills, signals, ledger, snapshots, compounding, riskEvents, logs, audit, reconciliations, settings, system, connections, journal] = await Promise.all([
      e.equity(), e.orders(), e.fills(), this.repo.signals.list(), e.ledger.entries('simulation'), this.repo.snapshots.list(), this.repo.compounding.list(),
      this.repo.riskEvents.list(), this.repo.logs.list(), this.repo.audit.list(), this.repo.reconciliations.list(), e.settings(), e.system(), this.repo.connections.list({ environment: 'simulation' }), this.repo.journal.list(),
    ]);
    const today = istDate(this.clock);
    const { positions, ...equity } = eq;
    return {
      connected: true, now: this.clock, equity: { ...equity }, positions: [...positions.values()], orders: orders.sort((a, b) => b.createdAt - a.createdAt),
      fills: fills.sort((a, b) => b.ts - a.ts), signals: signals.sort((a, b) => b.createdAt - a.createdAt), ledger, ledgerChain: await e.ledger.verifyChain('simulation'),
      auditChain: await e.verifyAudit(), snapshots: snapshots.sort((a, b) => a.date.localeCompare(b.date)), compounding: compounding.sort((a, b) => b.date.localeCompare(a.date)),
      riskEvents: riskEvents.sort((a, b) => b.ts - a.ts), logs: logs.sort((a, b) => b.ts - a.ts), audit: audit.sort((a, b) => b.ts - a.ts), reconciliations: reconciliations.sort((a, b) => b.ts - a.ts),
      settings, system, connections, journal: journal.sort((a, b) => b.ts - a.ts), quotes: [...this.market.allQuotes().values()], instruments: e.listInstruments(),
      psychology: await e.psychology(), anchors: await e.anchors(), closedStats: await e.closedTradeStats(),
      plannedRiskTodayPaise: orders.filter((o) => o.side === 'BUY' && istDate(o.createdAt) === today && !['RISK_REJECTED', 'REJECTED'].includes(o.status)).reduce((a, o) => a + (o.plannedRiskPaise ?? 0), 0),
    };
  }
}
