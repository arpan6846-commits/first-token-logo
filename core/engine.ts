// TradingEngine: one instance per environment (simulation | paper | production).
// The browser simulation, Base44 backend functions and the external worker all
// drive the same engine; only the Repo and adapters differ.

import type { VenueAdapter } from './adapters/types.ts';
import { eligibleProfit, decideCompounding, postCompounding, postTaxProvision } from './compounding.ts';
import { canonicalJson, newId, sha256Hex } from './hash.ts';
import { Accounts, Ledger } from './ledger.ts';
import { isNseOpen, istDate, istWeekStart, NSE_CALENDAR, type MarketCalendar } from './marketHours.ts';
import type { MarketDataCache } from './marketData.ts';
import { toPaise, type Paise } from './money.ts';
import { OrderManager, type SubmitOptions, type SubmitResult } from './oms.ts';
import { buildPositions, equityView, posKey, type EquityView } from './portfolio.ts';
import { dailyRiskBudgetPct, evaluateFinalCheck, FINAL_CHECK, psychologyAlerts } from './propDesk.ts';
import { reconcileVenue } from './reconciliation.ts';
import type { AuditRecord, Repo, SystemState } from './repo.ts';
import type { OrderProposal, RiskContext } from './risk.ts';
import { applySettingsChange, defaultSettings, type SettingsChangeResult } from './settings.ts';
import { buildSignal, HTF_OF, type SignalContext } from './signals.ts';
import { territory } from './priceAction.ts';
import type {
  Actor, AISignal, APIConnection, AutomationLog, DailySnapshot, DataSource, Environment, Instrument, JournalEntry, KillSwitchState,
  StrategySettings, TradeFill, TradeOrder, Venue,
} from './types.ts';
import { TERMINAL_STATUSES } from './types.ts';

export interface EngineDeps {
  repo: Repo;
  environment: Environment;
  adapters: Partial<Record<Venue, VenueAdapter>>;
  market: MarketDataCache;
  instruments: Instrument[];
  clock?: () => number;
  calendar?: MarketCalendar;
}

const GENESIS = '0'.repeat(64);

export class TradingEngine {
  readonly env: Environment;
  readonly ledger: Ledger;
  readonly oms: OrderManager;
  readonly repo: Repo;
  readonly market: MarketDataCache;
  readonly clock: () => number;
  readonly calendar: MarketCalendar;
  private instruments: Map<string, Instrument>;
  private adapters: Partial<Record<Venue, VenueAdapter>>;

  constructor(d: EngineDeps) {
    this.env = d.environment;
    this.repo = d.repo;
    this.market = d.market;
    this.clock = d.clock ?? Date.now;
    this.calendar = d.calendar ?? NSE_CALENDAR;
    this.adapters = d.adapters;
    this.instruments = new Map(d.instruments.map((i) => [`${i.venue}:${i.symbol}`, i]));
    this.ledger = new Ledger(d.repo.ledger, this.clock);
    this.oms = new OrderManager(this.env, d.repo, this.ledger, d.adapters, this.clock, this.calendar);
  }

  get source(): DataSource { return this.env === 'production' ? 'BROKER' : this.env === 'paper' ? 'PAPER_FEED' : 'SIMULATED'; }
  instrument(venue: Venue, symbol: string) { return this.instruments.get(`${venue}:${symbol}`); }
  listInstruments() { return [...this.instruments.values()]; }
  setInstruments(list: Instrument[]) { for (const i of list) this.instruments.set(`${i.venue}:${i.symbol}`, i); }

  // ---------------- bootstrap ----------------
  async init(opts: { seedCapital?: boolean } = {}): Promise<void> {
    if (!(await this.repo.settings.get(`settings_${this.env}`))) await this.repo.settings.insert(defaultSettings(this.env, this.clock()));
    if (!(await this.repo.system.get('system'))) await this.repo.system.insert({ id: 'system', killSwitch: { active: false } });
    for (const v of ['KITE', 'COINDCX'] as Venue[]) {
      const id = `conn_${this.env}_${v}`;
      if (!(await this.repo.connections.get(id))) {
        const a = this.adapters[v];
        await this.repo.connections.insert({
          id, venue: v, environment: this.env, permissions: { read: !!a, trade: !!a && this.env !== 'production', withdraw: false },
          status: this.env === 'production' ? 'NOT_CONFIGURED' : a ? 'AUTHENTICATED' : 'NOT_CONFIGURED',
          capabilityNotes: this.env === 'production' ? 'Awaiting credentials and capability verification' : `${this.env} adapter (no real money)`,
        });
      }
    }
    if (opts.seedCapital && this.env !== 'production') {
      const s = await this.settings();
      const src = this.source;
      await this.ledger.post({ environment: this.env, type: 'DEPOSIT', idempotencyKey: 'seed:deposit', source: src, memo: `Initial capital ₹${s.initialCapitalPaise / 100} (${this.env})`, lines: [{ account: Accounts.cash('BANK'), amountPaise: s.initialCapitalPaise }, { account: Accounts.contributed, amountPaise: -s.initialCapitalPaise }] });
      await this.ledger.post({ environment: this.env, type: 'TRANSFER', idempotencyKey: 'seed:to-kite', source: src, memo: 'Allocate to stock broker', lines: [{ account: Accounts.cash('KITE'), amountPaise: s.allocation.stocksPaise }, { account: Accounts.cash('BANK'), amountPaise: -s.allocation.stocksPaise }] });
      await this.ledger.post({ environment: this.env, type: 'TRANSFER', idempotencyKey: 'seed:to-coindcx', source: src, memo: 'Allocate to crypto exchange', lines: [{ account: Accounts.cash('COINDCX'), amountPaise: s.allocation.cryptoPaise }, { account: Accounts.cash('BANK'), amountPaise: -s.allocation.cryptoPaise }] });
      await this.audit('system', 'SEED_CAPITAL', { capital: s.initialCapitalPaise / 100, allocation: s.allocation });
    }
  }

  async settings(): Promise<StrategySettings> {
    const s = await this.repo.settings.get(`settings_${this.env}`);
    if (!s) throw new Error('Settings not initialised');
    // apply pending (loosened) settings whose effective date has arrived
    const sys = await this.system();
    const pend = sys.pendingSettings?.[this.env];
    if (pend && pend.effectiveDate <= istDate(this.clock())) {
      await this.repo.settings.update(s.id, pend.settings);
      const { [this.env]: _done, ...rest } = sys.pendingSettings ?? {};
      await this.repo.system.update('system', { pendingSettings: rest });
      await this.audit('system', 'PENDING_SETTINGS_APPLIED', { version: pend.settings.version });
      return pend.settings;
    }
    return s;
  }

  async system(): Promise<SystemState> {
    return (await this.repo.system.get('system')) ?? (await this.repo.system.insert({ id: 'system', killSwitch: { active: false } }));
  }

  // ---------------- audit (hash-chained, append-only) ----------------
  async audit(actor: Actor | string, action: string, details: Record<string, unknown>): Promise<AuditRecord> {
    const all = (await this.repo.audit.list()).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    const prev = all[all.length - 1]?.hash ?? GENESIS;
    const ts = Math.max(this.clock(), all[all.length - 1]?.ts ?? 0);
    const body = { ts, actor: String(actor), action, environment: this.env, details, prevHash: prev };
    return this.repo.audit.insert({ id: newId('aud', ts), ...body, hash: sha256Hex(canonicalJson(body)) });
  }

  async verifyAudit(): Promise<{ ok: boolean; records: number; brokenAt?: string }> {
    const all = (await this.repo.audit.list()).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    let prev = GENESIS;
    for (const r of all) {
      const { id: _i, hash, ...body } = r;
      if (r.prevHash !== prev || sha256Hex(canonicalJson(body)) !== hash) return { ok: false, records: all.length, brokenAt: r.id };
      prev = hash;
    }
    return { ok: true, records: all.length };
  }

  // ---------------- settings & safety controls ----------------
  async changeSettings(patch: Partial<StrategySettings>, actor: Actor, confirmationPhrase?: string): Promise<SettingsChangeResult> {
    const cur = await this.settings();
    const r = applySettingsChange(cur, { patch, actor, confirmationPhrase, now: this.clock() });
    await this.audit(actor, r.ok ? 'SETTINGS_CHANGE' : 'SETTINGS_CHANGE_REFUSED', { patch, errors: r.errors, loosened: r.loosenedFields, effectiveFrom: r.effectiveFrom });
    if (!r.ok || !r.next) return r;
    if (r.effectiveFrom === 'next_trading_day') {
      const sys = await this.system();
      const tomorrow = istDate(this.clock() + 86_400_000);
      await this.repo.system.update('system', { pendingSettings: { ...(sys.pendingSettings ?? {}), [this.env]: { effectiveDate: tomorrow, settings: r.next } } });
      // tightening parts of the same patch still apply immediately? No: keep it simple and explicit — whole patch waits.
    } else {
      await this.repo.settings.update(cur.id, r.next);
    }
    return r;
  }

  async setKillSwitch(active: boolean, reason: string, actor: Actor, opts: { confirm?: boolean; cancelOpenOrders?: boolean } = {}): Promise<KillSwitchState> {
    if (!active && (actor !== 'owner' || !opts.confirm)) throw new Error('Only the owner can deactivate the kill switch, with explicit confirmation');
    if (actor === 'ai') throw new Error('AI cannot operate the kill switch');
    const ks: KillSwitchState = active ? { active: true, reason, activatedAt: this.clock(), activatedBy: actor } : { active: false };
    await this.repo.system.update('system', { killSwitch: ks });
    await this.riskEvent(active ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', active ? 'HALT' : 'INFO', reason);
    await this.audit(actor, active ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', { reason });
    if (active && opts.cancelOpenOrders !== false) {
      const n = await this.oms.cancelAllOpen(actor);
      await this.audit(actor, 'CANCEL_ALL_OPEN', { cancelled: n });
    }
    return ks;
  }

  async confirmFirstLiveOrder(actor: Actor) {
    if (actor !== 'owner') throw new Error('Only the owner');
    const s = await this.settings();
    await this.repo.settings.update(s.id, { firstLiveOrderConfirmedAt: this.clock() });
    await this.audit(actor, 'FIRST_LIVE_ORDER_CONFIRMED', {});
  }

  // ---------------- accounting views ----------------
  async fills(): Promise<TradeFill[]> { return this.repo.fills.list({ environment: this.env } as Partial<TradeFill>); }
  async orders(): Promise<TradeOrder[]> { return this.repo.orders.list({ environment: this.env } as Partial<TradeOrder>); }

  async equity(asOf?: number): Promise<EquityView & { positions: ReturnType<typeof buildPositions> }> {
    const balances = await this.ledger.balances(this.env, asOf);
    const positions = buildPositions((await this.fills()).filter((f) => asOf === undefined || f.ts <= asOf));
    const ev = equityView(balances, positions, this.market.allQuotes());
    return { ...ev, positions };
  }

  async recordDeposit(venue: Venue | 'BANK', rupees: number, actor: Actor, ref: string) {
    if (actor !== 'owner') throw new Error('Only the owner records deposits/withdrawals');
    const p = toPaise(rupees);
    if (p === 0) throw new Error('Amount must be non-zero');
    const e = await this.ledger.post({
      environment: this.env, type: p > 0 ? 'DEPOSIT' : 'WITHDRAWAL', idempotencyKey: `cash:${ref}`, source: this.env === 'production' ? 'MANUAL' : this.source,
      memo: `${p > 0 ? 'Deposit to' : 'Withdrawal from'} ${venue} (owner-declared; confirmed by next reconciliation)`,
      lines: p > 0 ? [{ account: Accounts.cash(venue), amountPaise: p }, { account: Accounts.contributed, amountPaise: -p }] : [{ account: Accounts.withdrawn, amountPaise: -p }, { account: Accounts.cash(venue), amountPaise: p }],
    });
    await this.audit(actor, p > 0 ? 'DEPOSIT' : 'WITHDRAWAL', { venue, rupees, ledgerEntryId: e.id });
    return e;
  }

  private async contributionsSince(ts: number): Promise<Paise> {
    return (await this.ledger.entries(this.env)).filter((e) => e.ts >= ts && (e.type === 'DEPOSIT' || e.type === 'WITHDRAWAL'))
      .reduce((s, e) => s + e.lines.filter((l) => l.account.startsWith('ASSET:CASH:')).reduce((a, l) => a + l.amountPaise, 0), 0);
  }

  async anchors(): Promise<{ startOfDay: Paise; startOfWeek: Paise; contribDay: Paise; contribWeek: Paise; today: string }> {
    const now = this.clock();
    const today = istDate(now), week = istWeekStart(now);
    const snaps = (await this.repo.snapshots.list({ environment: this.env } as Partial<DailySnapshot>)).sort((a, b) => a.date.localeCompare(b.date));
    const before = (d: string) => [...snaps].reverse().find((s) => s.date < d);
    const startOfDayTs = Date.parse(`${today}T00:00:00+05:30`), startOfWeekTs = Date.parse(`${week}T00:00:00+05:30`);
    const eqAt = async (ts: number) => (await this.equity(ts - 1)).netEquityPaise;
    const sod = before(today)?.netEquityPaise ?? (await eqAt(startOfDayTs));
    const sow = before(week)?.netEquityPaise ?? (await eqAt(startOfWeekTs));
    const fallback = (await this.settings()).initialCapitalPaise;
    return { startOfDay: sod || fallback, startOfWeek: sow || fallback, contribDay: sod ? await this.contributionsSince(startOfDayTs) : 0, contribWeek: sow ? await this.contributionsSince(startOfWeekTs) : 0, today };
  }

  async stopOutsToday(): Promise<{ symbol: string; ts: number }[]> {
    const today = istDate(this.clock());
    return (await this.orders()).filter((o) => o.side === 'SELL' && o.exitReason === 'STOP' && o.filledQty > 0 && istDate(o.updatedAt) === today).map((o) => ({ symbol: o.symbol, ts: o.updatedAt }));
  }

  async consecutiveLossesToday(): Promise<number> {
    const today = istDate(this.clock());
    const sells = (await this.fills()).filter((f) => f.side === 'SELL' && istDate(f.ts) === today).sort((a, b) => b.ts - a.ts);
    let n = 0;
    for (const f of sells) { if ((f.realizedPnlPaise ?? 0) - f.feesPaise < 0) n++; else break; }
    return n;
  }

  async riskContext(p: Pick<OrderProposal, 'venue' | 'symbol' | 'assetClass'> & { signal?: AISignal }): Promise<RiskContext> {
    const now = this.clock();
    const [settings, sys, eq, anchors, orders, stopOuts, losses] = await Promise.all([
      this.settings(), this.system(), this.equity(), this.anchors(), this.orders(), this.stopOutsToday(), this.consecutiveLossesToday(),
    ]);
    const conn = await this.repo.connections.get(`conn_${this.env}_${p.venue}`);
    const adapter = this.adapters[p.venue];
    let venueAvailable = false;
    if (adapter) { try { venueAvailable = (await adapter.health()).ok; } catch { venueAvailable = false; } }
    const tf = p.signal?.timeframe;
    const candles = tf ? this.market.closedCandles(p.venue, p.symbol, tf, now) : [];
    return {
      now, settings, killSwitch: sys.killSwitch, haltedUntilDate: sys.haltedUntil?.[this.env], todayIst: anchors.today, equity: eq,
      startOfDayEquityPaise: anchors.startOfDay, startOfWeekEquityPaise: anchors.startOfWeek, contributionsTodayPaise: anchors.contribDay,
      contributionsWeekPaise: anchors.contribWeek, instrument: this.instrument(p.venue, p.symbol), quote: this.market.quote(p.venue, p.symbol),
      lastCandleTs: candles[candles.length - 1]?.ts, connection: conn, venueAvailable, reconciliation: sys.lastReconciliation?.[`${this.env}:${p.venue}`],
      marketOpen: p.assetClass === 'CRYPTO' ? true : isNseOpen(now, this.calendar), positions: eq.positions, orders, stopOutsToday: stopOuts,
      consecutiveLossesToday: losses, finalCheck: p.signal?.finalCheck, requireFinalCheck: !!p.signal && this.env !== 'simulation',
    };
  }

  // ---------------- signals ----------------
  async journalFor(signalId: string): Promise<JournalEntry | undefined> {
    return (await this.repo.journal.list({ environment: this.env, signalId, kind: 'PRE_TRADE' } as Partial<JournalEntry>))[0];
  }

  async signalContext(inst: Instrument, ttf: StrategySettings['stockTimeframe']): Promise<SignalContext> {
    const now = this.clock();
    const today = istDate(now);
    const orders = await this.orders();
    const todaysBuys = orders.filter((o) => o.side === 'BUY' && istDate(o.createdAt) === today && !['RISK_REJECTED', 'REJECTED'].includes(o.status));
    const entries = orders.filter((o) => o.side === 'BUY' && o.filledQty > 0);
    const s = await this.settings();
    const htf = HTF_OF[ttf];
    const idxSym = inst.assetClass === 'CRYPTO' ? 'BTCINR' : 'NIFTY 50';
    const secSym = inst.assetClass === 'CRYPTO' ? 'BTCINR' : ({ IT: 'NIFTY IT', BANK: 'NIFTY BANK', METAL: 'NIFTY METAL', FMCG: 'NIFTY FMCG', PHARMA: 'NIFTY PHARMA' } as Record<string, string>)[inst.sector ?? ''];
    const side = (sym?: string) => {
      if (!sym) return undefined;
      const c = this.market.closedCandles(inst.venue, sym, htf, now);
      return c.length >= 40 ? territory(c).side : undefined;
    };
    const closed = await this.closedTradeStats();
    const journals = await this.repo.journal.list({ environment: this.env, kind: 'POST_TRADE' } as Partial<JournalEntry>);
    const reviewed = new Set(journals.map((j) => j.orderId));
    const tier = dailyRiskBudgetPct(closed.accuracyPct, closed.count, { smallCapital: s.initialCapitalPaise < toPaise(100_000) });
    return {
      indexSide: side(idxSym), sectorSide: side(secSym), tradesToday: todaysBuys.length,
      sectorTradesToday: todaysBuys.filter((o) => o.sector === inst.sector).length,
      rangeShareOk: entries.length < 5 || (entries.filter((o) => o.isRangeTrade).length / entries.length) * 100 <= s.maxRangeTradePct,
      stopOutSymbols: (await this.stopOutsToday()).map((x) => x.symbol),
      postTradeUpToDate: closed.closedEntryIds.every((id) => reviewed.has(id)) || this.env === 'simulation',
      plannedRiskTodayPaise: todaysBuys.reduce((a, o) => a + (o.plannedRiskPaise ?? 0), 0),
      accuracyTierPct: this.env === 'simulation' ? 1 : tier.pct,
    };
  }

  async closedTradeStats(): Promise<{ count: number; wins: number; accuracyPct?: number; closedEntryIds: string[] }> {
    const orders = await this.orders();
    const exits = orders.filter((o) => o.side === 'SELL' && o.parentOrderId && o.filledQty > 0);
    const fills = await this.fills();
    let wins = 0;
    for (const x of exits) { const pnl = fills.filter((f) => f.orderId === x.id).reduce((s, f) => s + (f.realizedPnlPaise ?? 0) - f.feesPaise, 0); if (pnl > 0) wins++; }
    return { count: exits.length, wins, accuracyPct: exits.length ? (wins / exits.length) * 100 : undefined, closedEntryIds: [...new Set(exits.map((x) => x.parentOrderId!))] };
  }

  async generateSignals(symbols?: { venue: Venue; symbol: string }[], manualTicks?: Record<number, boolean>): Promise<AISignal[]> {
    const now = this.clock();
    const s = await this.settings();
    const eq = await this.equity();
    const list = symbols ?? this.listInstruments().map((i) => ({ venue: i.venue, symbol: i.symbol }));
    const out: AISignal[] = [];
    for (const { venue, symbol } of list) {
      const inst = this.instrument(venue, symbol);
      if (!inst) continue;
      if (inst.assetClass === 'EQUITY' && !isNseOpen(now, this.calendar) && this.env !== 'simulation') continue; // market-hours aware
      const ttf = inst.assetClass === 'EQUITY' ? s.stockTimeframe : s.cryptoTimeframe;
      const ctx = await this.signalContext(inst, ttf);
      const sig = buildSignal({
        environment: this.env, instrument: inst, ttf, ttfCandles: this.market.closedCandles(venue, symbol, ttf, now),
        htfCandles: this.market.closedCandles(venue, symbol, HTF_OF[ttf], now), quote: this.market.quote(venue, symbol), now, settings: s,
        equityPaise: eq.netEquityPaise, dataSource: this.market.quote(venue, symbol)?.source ?? 'ESTIMATE', ctx: { ...ctx, manualTicks },
      });
      await this.repo.signals.insert(sig);
      out.push(sig);
    }
    await this.log('signal-generation', `sig:${now}`, 'SUCCESS', `${out.length} analysed, ${out.filter((x) => x.status === 'VALIDATED').length} validated, ${out.filter((x) => x.status === 'REJECTED').length} rejected`, 'system');
    return out;
  }

  /** Owner (or auto mode, after Phase 5) turns a validated signal into an order. Risk is re-checked. */
  async executeSignal(signalId: string, opts: SubmitOptions & { manualTicks?: Record<number, boolean> }): Promise<SubmitResult> {
    const sig = await this.repo.signals.get(signalId);
    if (!sig) throw new Error('Signal not found');
    if (sig.environment !== this.env) throw new Error('Signal belongs to another environment');
    if (sig.status !== 'VALIDATED' && sig.status !== 'APPROVED') throw new Error(`Signal is ${sig.status}; only VALIDATED signals can be executed`);
    if (opts.actor === 'ai') throw new Error('AI cannot execute signals');
    const s = await this.settings();
    if (opts.actor !== 'owner' && !(s.executionMode === 'auto' && s.phase >= 3)) throw new Error('Automatic execution requires owner-enabled auto mode');
    // apply owner manual ticks to the Final Check
    let fc = sig.finalCheck;
    if (fc && opts.manualTicks) {
      const facts: Record<string, boolean> = {};
      for (const it of fc.items) { const def = FINAL_CHECK.find((d) => d[0] === it.id); if (def?.[3] && it.pass !== null) facts[def[3]] = it.pass || facts[def[3]] === true; }
      const j = await this.journalFor(signalId);
      if (j) { facts.writtenReasons = !!(j.sectorWhy && j.stockWhy && j.positionWhy); facts.againstMePlan = !!j.againstMePlan; facts.profileScenario = !!j.profileScenario; }
      fc = evaluateFinalCheck({ ...facts, processComplete: true }, opts.manualTicks);
      await this.repo.signals.update(sig.id, { finalCheck: fc });
    }
    const p: OrderProposal = {
      environment: this.env, venue: sig.venue, symbol: sig.symbol, assetClass: sig.assetClass, side: 'BUY', qty: sig.qty,
      orderType: 'LIMIT', product: sig.assetClass === 'EQUITY' ? 'CNC' : 'SPOT', limitPrice: sig.entry, stopPrice: sig.stop,
      targetPrice: sig.target, timeframe: sig.timeframe, sector: sig.sector, isRangeTrade: sig.isRangeTrade,
      idempotencyKey: `signal:${sig.id}`, signalId: sig.id,
    };
    const ctx = await this.riskContext({ venue: sig.venue, symbol: sig.symbol, assetClass: sig.assetClass, signal: { ...sig, finalCheck: fc } });
    const res = await this.oms.submit(p, ctx, opts);
    if (!res.duplicate) {
      await this.repo.signals.update(sig.id, { status: res.order.status === 'RISK_REJECTED' ? 'REJECTED' : 'EXECUTED', rejectionReasons: res.order.status === 'RISK_REJECTED' ? [...sig.rejectionReasons, `RISK: ${res.order.rejectionReason}`] : sig.rejectionReasons });
      await this.audit(opts.actor, 'EXECUTE_SIGNAL', { signalId, orderId: res.order.id, status: res.order.status });
    }
    return res;
  }

  async submitOrder(p: OrderProposal, opts: SubmitOptions): Promise<SubmitResult> {
    const ctx = await this.riskContext(p);
    const res = await this.oms.submit(p, ctx, opts);
    if (!res.duplicate) await this.audit(opts.actor, 'SUBMIT_ORDER', { orderId: res.order.id, status: res.order.status, symbol: p.symbol, side: p.side, qty: p.qty });
    return res;
  }

  async confirmOrder(orderId: string, opts: SubmitOptions): Promise<SubmitResult> {
    const o = await this.repo.orders.get(orderId);
    if (!o) throw new Error('Order not found');
    const sig = o.signalId ? await this.repo.signals.get(o.signalId) : undefined;
    const ctx = await this.riskContext({ venue: o.venue, symbol: o.symbol, assetClass: o.assetClass, signal: sig });
    const r = await this.oms.confirmAwaiting(orderId, ctx, opts);
    await this.audit(opts.actor, 'CONFIRM_ORDER', { orderId, status: r.order.status });
    return r;
  }

  // ---------------- market events & exits ----------------
  async onMarketUpdate(): Promise<void> {
    for (const a of Object.values(this.adapters)) (a as { processQuotes?: () => void } | undefined)?.processQuotes?.();
    await this.oms.syncAllOpen();
    await this.runExitManager();
    await this.checkLossLimits();
  }

  /** Watches stop/target of filled entries and sends reduce-only exits. */
  async runExitManager(): Promise<TradeOrder[]> {
    const orders = await this.orders();
    const placed: TradeOrder[] = [];
    for (const entry of orders.filter((o) => o.side === 'BUY' && o.filledQty > 0 && (o.stopPrice || o.targetPrice))) {
      const exits = orders.filter((o) => o.parentOrderId === entry.id && !['RISK_REJECTED', 'REJECTED'].includes(o.status) && !(o.status === 'CANCELLED' && o.filledQty === 0));
      const committed = exits.reduce((s, o) => s + (TERMINAL_STATUSES.includes(o.status) ? o.filledQty : o.qty), 0);
      const remaining = Math.round((entry.filledQty - committed) * 1e8) / 1e8;
      if (remaining <= 0) continue;
      const q = this.market.quote(entry.venue, entry.symbol);
      if (!q) continue;
      const reason = entry.stopPrice && q.ltp <= entry.stopPrice ? 'STOP' : entry.targetPrice && q.ltp >= entry.targetPrice ? 'TARGET' : undefined;
      if (!reason) continue;
      const inst = this.instrument(entry.venue, entry.symbol);
      const px = q.bid ?? q.ltp;
      const limit = inst ? Math.floor((reason === 'STOP' ? px * 0.995 : px) / inst.tickSize) * inst.tickSize : px;
      const res = await this.submitOrder({
        environment: this.env, venue: entry.venue, symbol: entry.symbol, assetClass: entry.assetClass, side: 'SELL', qty: remaining,
        orderType: 'LIMIT', product: entry.product, limitPrice: Number(limit.toFixed(6)), idempotencyKey: `exit:${entry.id}:${reason}:${exits.length}`,
        protectiveExit: reason === 'STOP',
      }, { actor: 'system', parentOrderId: entry.id, exitReason: reason });
      placed.push(res.order);
    }
    return placed;
  }

  /** Latches a halt when daily/weekly loss stops are breached (no new entries until next day / week). */
  async checkLossLimits(): Promise<void> {
    const s = await this.settings();
    const eq = await this.equity();
    const a = await this.anchors();
    const day = eq.netEquityPaise - a.startOfDay - a.contribDay;
    const week = eq.netEquityPaise - a.startOfWeek - a.contribWeek;
    const sys = await this.system();
    const already = sys.haltedUntil?.[this.env];
    if (day <= -Math.round((a.startOfDay * s.dailyLossStopPct) / 100) && (!already || already < a.today)) {
      await this.repo.system.update('system', { haltedUntil: { ...(sys.haltedUntil ?? {}), [this.env]: a.today } });
      await this.riskEvent('DAILY_LOSS_STOP_BREACHED', 'HALT', `Day P&L ₹${day / 100} breached ${s.dailyLossStopPct}% — new entries halted for today`);
      await this.audit('system', 'HALT_DAILY', { dayPnl: day / 100 });
    }
    if (week <= -Math.round((a.startOfWeek * s.weeklyLossStopPct) / 100)) {
      const sunday = istDate(Date.parse(`${istWeekStart(this.clock())}T00:00:00+05:30`) + 6 * 86_400_000);
      if (!already || already < sunday) {
        await this.repo.system.update('system', { haltedUntil: { ...(sys.haltedUntil ?? {}), [this.env]: sunday } });
        await this.riskEvent('WEEKLY_LOSS_STOP_BREACHED', 'HALT', `Week P&L ₹${week / 100} breached ${s.weeklyLossStopPct}% — new entries halted until ${sunday}`);
      }
    }
  }

  // ---------------- reconciliation, daily close, snapshots ----------------
  async reconcile(venue: Venue) {
    const a = this.adapters[venue];
    if (!a) throw new Error(`No adapter for ${venue}`);
    const rec = await reconcileVenue({ env: this.env, venue, adapter: a, repo: this.repo, ledger: this.ledger, oms: this.oms, now: this.clock() });
    await this.audit('system', 'RECONCILE', { venue, status: rec.status, diffs: rec.diffs.length });
    if (rec.status !== 'MATCHED') await this.riskEvent('RECONCILIATION_' + rec.status, 'BLOCK', rec.message);
    return rec;
  }

  async dailyClose(date = istDate(this.clock())) {
    return this.runJob('daily-close', `close:${date}`, async () => {
      const s = await this.settings();
      const fills = await this.fills();
      const eligible = eligibleProfit(fills, date, s.taxRates);
      const bal = await this.ledger.balances(this.env);
      const reserve = -(bal.get(Accounts.taxReserve) ?? 0);
      const src: DataSource = this.env === 'production' ? 'ESTIMATE' : this.source;
      await postTaxProvision(this.ledger, this.env, date, eligible.taxProvisionPaise, reserve, src);
      const sys = await this.system();
      const hw = sys.compoundingHighWater?.[this.env] ?? 0;
      const dec = decideCompounding(this.env, date, eligible, hw, s.reinvestPct, this.clock());
      const entry = await postCompounding(this.ledger, dec.event, this.env === 'production' ? 'MANUAL' : this.source);
      const exists = (await this.repo.compounding.list({ environment: this.env, date } as Partial<typeof dec.event>))[0];
      if (!exists) await this.repo.compounding.insert({ ...dec.event, ledgerEntryId: entry?.id });
      await this.repo.system.update('system', { compoundingHighWater: { ...(sys.compoundingHighWater ?? {}), [this.env]: dec.newHighWaterPaise }, lastCompoundingDate: { ...(sys.lastCompoundingDate ?? {}), [this.env]: date } });
      const snap = await this.snapshot(date);
      return `Eligible net ₹${eligible.netPaise / 100} (${eligible.excluded.unreconciled} unreconciled, ${eligible.excluded.unsettled} unsettled excluded); ${dec.event.note}; equity ₹${snap.netEquityPaise / 100}`;
    });
  }

  async snapshot(date = istDate(this.clock())): Promise<DailySnapshot> {
    const existing = (await this.repo.snapshots.list({ environment: this.env, date } as Partial<DailySnapshot>))[0];
    const s = await this.settings();
    const eq = await this.equity();
    const snaps = (await this.repo.snapshots.list({ environment: this.env } as Partial<DailySnapshot>)).filter((x) => x.date < date).sort((a, b) => a.date.localeCompare(b.date));
    const prev = snaps[snaps.length - 1];
    const fills = await this.fills();
    const dayFills = fills.filter((f) => istDate(f.ts) === date);
    const startTs = Date.parse(`${date}T00:00:00+05:30`);
    const contribDay = await this.contributionsSince(startTs);
    const prevEq = prev?.netEquityPaise ?? eq.netContributionsPaise - contribDay;
    const peak = Math.max(prev?.peakEquityPaise ?? 0, eq.netEquityPaise);
    const dayRet = prevEq > 0 ? ((eq.netEquityPaise - prevEq - (prev ? contribDay : 0)) / prevEq) * 100 : 0;
    const snap: DailySnapshot = {
      id: existing?.id ?? newId('snp'), environment: this.env, date, cashPaise: eq.cashPaise, investedCostPaise: eq.holdingsCostPaise,
      marketValuePaise: eq.marketValuePaise, unrealizedPnlPaise: eq.unrealizedPaise,
      realizedPnlDayPaise: dayFills.reduce((a, f) => a + (f.realizedPnlPaise ?? 0), 0), realizedPnlCumPaise: eq.realizedPaise,
      feesDayPaise: dayFills.reduce((a, f) => a + f.feesPaise, 0), feesCumPaise: eq.feesPaise, taxReservePaise: eq.taxReservePaise,
      tdsReceivablePaise: eq.tdsReceivablePaise, netEquityPaise: eq.netEquityPaise, netContributionsPaise: eq.netContributionsPaise,
      dayReturnPct: round2(dayRet), cumReturnPct: eq.netContributionsPaise > 0 ? round2(((eq.netEquityPaise - eq.netContributionsPaise) / eq.netContributionsPaise) * 100) : 0,
      drawdownPct: peak > 0 ? round2(((eq.netEquityPaise - peak) / peak) * 100) : 0, peakEquityPaise: peak,
      targetProgressPct: round2((dayRet / s.dailyTargetPct) * 100), pricesSource: eq.markSources[0] ?? this.source, createdAt: this.clock(),
    };
    return existing ? this.repo.snapshots.update(existing.id, snap) : this.repo.snapshots.insert(snap);
  }

  // ---------------- automation ----------------
  /** Idempotent job runner: a runKey that already succeeded is skipped. */
  async runJob(job: string, runKey: string, fn: () => Promise<string>, actor: Actor = 'worker'): Promise<AutomationLog> {
    const prior = (await this.repo.logs.list({ environment: this.env, runKey } as Partial<AutomationLog>)).find((l) => l.status === 'SUCCESS');
    if (prior) return this.log(job, runKey, 'SKIPPED', `Already completed at ${new Date(prior.ts).toISOString()}`, actor);
    await this.log(job, runKey, 'STARTED', 'started', actor);
    try {
      const msg = await fn();
      return await this.log(job, runKey, 'SUCCESS', msg, actor);
    } catch (e) {
      await this.riskEvent('JOB_FAILED', 'WARN', `${job} (${runKey}) failed: ${(e as Error).message}`);
      return this.log(job, runKey, 'FAILED', (e as Error).message, actor);
    }
  }

  async log(job: string, runKey: string, status: AutomationLog['status'], message: string, actor: Actor): Promise<AutomationLog> {
    return this.repo.logs.insert({ id: newId('log'), environment: this.env, ts: this.clock(), job, runKey, status, message, actor });
  }

  async riskEvent(code: string, severity: 'INFO' | 'WARN' | 'BLOCK' | 'HALT', message: string) {
    return this.repo.riskEvents.insert({ id: newId('rsk'), environment: this.env, ts: this.clock(), code, severity, message });
  }

  async healthCheck(): Promise<APIConnection[]> {
    const out: APIConnection[] = [];
    const s = await this.settings();
    for (const v of ['KITE', 'COINDCX'] as Venue[]) {
      const id = `conn_${this.env}_${v}`;
      const c = await this.repo.connections.get(id);
      if (!c) continue;
      const a = this.adapters[v];
      let ok = false, err: string | undefined;
      if (a) { try { const h = await a.health(); ok = h.ok; if (!h.ok) err = h.message; } catch (e) { err = (e as Error).message; } }
      const feed = this.market.feedHealth(v, this.clock(), s.maxQuoteAgeMs * 4);
      out.push(await this.repo.connections.update(id, { lastHealthCheckAt: this.clock(), lastHealthOk: ok, lastError: err, feedHealthy: feed.healthy, lastFeedTickAt: Number.isFinite(feed.lastTickAgeMs) ? this.clock() - feed.lastTickAgeMs : undefined }));
    }
    return out;
  }

  async psychology() {
    const orders = await this.orders();
    const today = istDate(this.clock());
    const stats = await this.closedTradeStats();
    const reviewed = new Set((await this.repo.journal.list({ environment: this.env, kind: 'POST_TRADE' } as Partial<JournalEntry>)).map((j) => j.orderId));
    return psychologyAlerts({
      stopOutsToday: await this.stopOutsToday(), consecutiveLosses: await this.consecutiveLossesToday(),
      tradesToday: orders.filter((o) => o.side === 'BUY' && istDate(o.createdAt) === today && o.filledQty > 0).length,
      missingPostTrade: stats.closedEntryIds.filter((id) => !reviewed.has(id)).length,
    });
  }

  posKey = posKey;
}

function round2(x: number) { return Math.round(x * 100) / 100; }
