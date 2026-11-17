import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Environment, Venue } from '@core/types.ts';
import { Base44Runtime } from './base44Runtime.ts';
import { SimRuntime } from './simRuntime.ts';
import type { Actions, AppState, DataMode } from './types.ts';

const MODE: DataMode = import.meta.env.VITE_DATA_MODE === 'base44' ? 'base44' : 'local-simulation';

function savedEnv(): Environment { try { const e = localStorage.getItem('we-env'); if (e === 'simulation' || e === 'paper' || e === 'production') return e; } catch { /* ignore */ } return MODE === 'base44' ? 'paper' : 'simulation'; }

const EMPTY: AppState = {
  mode: MODE, environment: savedEnv(), connected: false, now: Date.now(), positions: [], orders: [], fills: [], signals: [], ledger: [],
  snapshots: [], compounding: [], riskEvents: [], logs: [], audit: [], reconciliations: [], connections: [], journal: [], quotes: [], instruments: [], psychology: [],
  plannedRiskTodayPaise: 0, complianceTicks: {}, sandboxTests: {}, backtestTrades: 0, busy: true,
};

const Ctx = createContext<{ state: AppState; actions: Actions } | null>(null);

function loadTicks(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem('we-compliance') ?? '{}'); } catch { return {}; } }

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(EMPTY);
  const sim = useRef<SimRuntime>();
  const b44 = useRef<Base44Runtime>();
  const envRef = useRef<Environment>(EMPTY.environment);

  const load = useCallback(async (msg?: AppState['lastMessage']) => {
    const env = envRef.current;
    let part: Partial<AppState>;
    if (MODE === 'local-simulation') {
      // Paper and production need real (read-only or trading) connections — never fabricate them locally.
      part = env === 'simulation' && sim.current ? await sim.current.snapshotState() : { connected: false, positions: [], orders: [], fills: [], signals: [], ledger: [], snapshots: [], compounding: [], riskEvents: [], logs: [], audit: [], reconciliations: [], connections: [], journal: [], quotes: [], equity: undefined, settings: undefined, ledgerChain: undefined, auditChain: undefined, psychology: [], anchors: undefined };
      if (MODE === 'local-simulation') part.complianceTicks = loadTicks();
    } else {
      part = await b44.current!.snapshotState(env);
    }
    setState((s) => ({ ...s, ...part, environment: env, busy: false, lastMessage: msg ?? s.lastMessage }));
  }, []);

  useEffect(() => {
    (async () => {
      if (MODE === 'local-simulation') { sim.current = new SimRuntime(); await sim.current.init(); }
      else b44.current = new Base44Runtime();
      await load();
    })().catch((e) => setState((s) => ({ ...s, busy: false, lastMessage: { kind: 'error', text: (e as Error).message } })));
  }, [load]);

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const r = await fn();
      await load({ kind: 'ok', text: typeof r === 'string' ? r : label });
    } catch (e) {
      await load({ kind: 'error', text: (e as Error).message });
    }
  }, [load]);

  const simOnly = () => { if (!sim.current || envRef.current !== 'simulation') throw new Error('Available in the simulation environment only'); return sim.current; };
  const remote = () => { if (!b44.current) throw new Error('Requires the Base44 deployment (VITE_DATA_MODE=base44) and the worker. Not available in local simulation mode.'); return b44.current; };
  const env = () => envRef.current;
  const eng = () => simOnly().engine;
  const cmd = (type: string, payload: Record<string, unknown>) => remote().command(type, env(), payload);
  const local = MODE === 'local-simulation';

  const actions: Actions = useMemo(() => ({
    setEnvironment: (e) => { envRef.current = e; try { localStorage.setItem('we-env', e); } catch { /* ignore */ } setState((s) => ({ ...s, environment: e, busy: true })); load(); },
    refresh: () => load(),
    step: (bars) => run(`Advanced ${bars} × 5 min (simulated)`, () => simOnly().step(bars)),
    loadScenario: (symbol) => run(`Scripted setup loaded on ${symbol} (SIMULATED)`, () => simOnly().loadScenario(symbol)),
    reset: () => run('Simulation reset', async () => { SimRuntime.reset(); sim.current = new SimRuntime(); await sim.current.init(); }),
    generateSignals: () => run('Signals generated', async () => {
      if (local) { const s = await eng().generateSignals(); return `${s.length} analysed · ${s.filter((x) => x.status === 'VALIDATED').length} validated · ${s.filter((x) => x.status === 'WATCHLIST').length} watchlist · ${s.filter((x) => x.status === 'REJECTED').length} rejected`; }
      return cmd('GENERATE_SIGNALS', {});
    }),
    approveSignal: (id, ticks) => run('Signal armed — order fires only on a confirmed break', async () => {
      if (local) { const r = await eng().approveSignal(id, { actor: 'owner', manualTicks: ticks }); simOnly().save(); return r.result ? `Order ${r.result.order.status}` : 'Armed: waiting for a closed candle above the build-up'; }
      return cmd('APPROVE_SIGNAL', { signalId: id, manualTicks: ticks });
    }),
    cancelSignal: (id) => run('Signal cancelled', async () => {
      if (local) { const s = await eng().repo.signals.get(id); if (s) await eng().repo.signals.update(id, { status: 'EXPIRED', expiryReason: 'Cancelled by owner' }); simOnly().save(); return; }
      return cmd('CANCEL_SIGNAL', { signalId: id });
    }),
    aiReview: (id) => run('AI review queued', async () => {
      if (local) throw new Error('AI review runs in the Base44 function `aiReviewSignal` with the ANTHROPIC_API_KEY secret. It is not available in local simulation, and no AI output is invented here.');
      const r = await remote().invoke('aiReviewSignal', { signalId: id });
      return `AI verdict: ${r.review.verdict} — ${r.review.notes.slice(0, 160)}`;
    }),
    submitOrder: (p, o) => run('Order submitted', async () => {
      if (local) { const r = await eng().submitOrder(p, { actor: 'owner', ownerConfirmed: o.ownerConfirmed }); simOnly().save(); return r.duplicate ? 'Duplicate request — original order returned' : `Order ${r.order.status}${r.order.rejectionReason ? `: ${r.order.rejectionReason}` : ''}`; }
      return cmd('SUBMIT_ORDER', { proposal: p, ownerConfirmed: o.ownerConfirmed, firstLiveOrderPhrase: o.firstLiveOrderPhrase });
    }),
    confirmOrder: (id, phrase) => run('Order confirmed', async () => {
      if (local) { const r = await eng().confirmOrder(id, { actor: 'owner', ownerConfirmed: true, firstLiveOrderConfirmation: phrase }); simOnly().save(); return `Order ${r.order.status}`; }
      return cmd('CONFIRM_ORDER', { orderId: id, firstLiveOrderPhrase: phrase });
    }),
    cancelOrder: (id) => run('Order cancel requested', async () => { if (local) { await eng().oms.cancel(id, 'owner'); simOnly().save(); return; } return cmd('CANCEL_ORDER', { orderId: id }); }),
    killSwitch: (active, reason, confirm) => run(active ? 'KILL SWITCH ACTIVATED' : 'Kill switch released', async () => {
      if (local) { await eng().setKillSwitch(active, reason, 'owner', { confirm }); simOnly().save(); return; }
      return cmd('KILL_SWITCH', { active, reason, confirm });
    }),
    changeSettings: async (patch, phrase) => {
      let res;
      await run('Settings updated', async () => {
        if (local) { res = await eng().changeSettings(patch, 'owner', phrase); simOnly().save(); if (!res.ok) throw new Error(res.errors.join(' · ')); return res.effectiveFrom === 'next_trading_day' ? 'Saved — loosened limits take effect from the next trading day' : 'Settings updated'; }
        res = await cmd('UPDATE_SETTINGS', { patch, confirmationPhrase: phrase });
        if (res && res.ok === false) throw new Error(res.errors.join(' · '));
      });
      return res;
    },
    confirmFirstLiveOrder: (phrase) => run('First live order confirmation recorded', async () => { if (local) throw new Error('Only meaningful for production'); return cmd('CONFIRM_FIRST_LIVE_ORDER', { phrase }); }),
    cashFlow: (venue, rupees, reference) => run('Cash flow recorded', async () => { if (local) { await eng().recordDeposit(venue, rupees, 'owner', reference); simOnly().save(); return; } return cmd('CASH_FLOW', { venue, rupees, reference }); }),
    reconcile: (venue: Venue) => run('Reconciled', async () => { if (local) { const r = await eng().reconcile(venue); simOnly().save(); return `${venue}: ${r.status} — ${r.message}`; } return cmd('RECONCILE', { venue }); }),
    dailyClose: () => run('Daily close run', async () => { if (local) { const l = await eng().dailyClose(); simOnly().save(); return `${l.status}: ${l.message}`; } return cmd('DAILY_CLOSE', {}); }),
    addJournal: (entry) => run('Journal saved', async () => { if (local) return simOnly().journal(entry); return cmd('JOURNAL', { entry }); }),
    setCompliance: (ticks) => run('Compliance checklist saved', async () => {
      if (local) { localStorage.setItem('we-compliance', JSON.stringify(ticks)); return; }
      return cmd('SET_COMPLIANCE', { ticks });
    }),
    kiteLogin: () => run('Opening Kite login', async () => { const r = await remote().invoke('kiteLogin'); window.location.href = r.url; }),
    revokeCredentials: () => run('Credentials revoked', async () => { const r = await remote().invoke('revokeCredentials'); return r.steps.join(' · '); }),
    candles: (venue, symbol, tf) => (sim.current && envRef.current === 'simulation' ? sim.current.candles(venue, symbol, tf) : []),
    backtest: async (symbol) => (sim.current ? sim.current.runBacktest(symbol) : undefined),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [load, run]);

  return <Ctx.Provider value={{ state, actions }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
}
