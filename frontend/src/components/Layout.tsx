import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity, BookOpen, Bitcoin, Bot, Cable, ClipboardList, Gauge, History, LayoutDashboard, LineChart, Octagon, Settings, ShieldAlert, Wallet, Workflow,
} from 'lucide-react';
import type { Environment } from '@core/types.ts';
import { marketStatus } from '@core/marketHours.ts';
import { useApp } from '../runtime/AppContext.tsx';
import { Spinner, istTime } from './ui.tsx';

const NAV = [
  ['/', 'Dashboard', LayoutDashboard], ['/portfolio', 'Portfolio', Wallet], ['/stocks', 'Stock market', LineChart], ['/crypto', 'Crypto market', Bitcoin],
  ['/signals', 'AI signals', Bot], ['/trades', 'Trade history', History], ['/ledger', 'Compounding ledger', BookOpen], ['/risk', 'Risk monitor', ShieldAlert],
  ['/prop-desk', 'Prop desk', Gauge], ['/connections', 'API connections', Cable], ['/automation', 'Automation', Workflow], ['/settings', 'Settings', Settings],
  ['/audit', 'Audit logs', ClipboardList],
] as const;

const ENV_STYLE: Record<Environment, string> = {
  simulation: 'border-violet-700 bg-violet-950 text-violet-200',
  paper: 'border-amber-700 bg-amber-950 text-amber-200',
  production: 'border-emerald-700 bg-emerald-950 text-emerald-200',
};

export function Layout() {
  const { state, actions } = useApp();
  const ks = state.system?.killSwitch?.active;
  const ms = marketStatus(state.now);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-ink-700 bg-ink-900 p-3 lg:flex">
        <div className="mb-4 flex items-center gap-2 px-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 font-bold text-white">W</div>
          <div><div className="text-sm font-semibold text-white">Wealth Engine AI</div><div className="text-[10px] uppercase tracking-wider text-slate-500">private · single owner</div></div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${isActive ? 'bg-ink-700 text-white' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200'}`}>
              <Icon size={15} />{label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto rounded-lg border border-ink-700 p-2 text-[11px] leading-relaxed text-slate-500">
          Personal tool for the owner's own capital. No advice, no pooled funds. Losses are possible.
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 px-4 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-ink-600 p-0.5" role="tablist" aria-label="Environment">
              {(['simulation', 'paper', 'production'] as Environment[]).map((e) => (
                <button key={e} role="tab" aria-selected={state.environment === e} onClick={() => actions.setEnvironment(e)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${state.environment === e ? ENV_STYLE[e] + ' border' : 'text-slate-400 hover:text-slate-200'}`}>{e}</button>
              ))}
            </div>
            <span className="hidden text-xs text-slate-500 sm:inline">{state.mode === 'base44' ? 'Base44 data' : 'Local mode — simulation engine runs in this browser'}</span>
            <span className="ml-auto flex items-center gap-2 text-xs">
              <span className={`flex items-center gap-1 rounded border px-1.5 py-0.5 ${ms.nse === 'OPEN' ? 'border-emerald-800 text-emerald-300' : 'border-ink-600 text-slate-400'}`}><Activity size={11} />NSE {ms.nse}</span>
              <span className="rounded border border-ink-600 px-1.5 py-0.5 text-slate-400">Crypto 24×7</span>
              <span className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-semibold ${ks ? 'border-rose-700 bg-rose-950 text-rose-200' : 'border-ink-600 text-slate-400'}`}><Octagon size={11} />{ks ? 'KILL SWITCH ON' : 'kill switch off'}</span>
              {state.busy && <Spinner />}
            </span>
          </div>
          {state.environment === 'simulation' && state.mode === 'local-simulation' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded border border-violet-800 bg-violet-950/60 px-2 py-0.5 font-mono text-violet-200">Sim clock {istTime(state.now)} IST</span>
              {[[1, '+5m'], [3, '+15m'], [12, '+1h'], [75, '+1 session'], [288, '+1 day']].map(([n, l]) => (
                <button key={l} className="btn-ghost !px-2 !py-0.5 text-xs" disabled={state.busy} onClick={() => actions.step(n as number)}>{l}</button>
              ))}
              <span className="text-slate-500">Synthetic prices (seeded random walk) — never real market data.</span>
            </div>
          )}
          <nav className="mt-2 flex gap-1 overflow-x-auto pb-1 lg:hidden">
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `whitespace-nowrap rounded-md px-2 py-1 text-xs ${isActive ? 'bg-ink-700 text-white' : 'text-slate-400'}`}>{label}</NavLink>)}
          </nav>
        </header>
        {state.lastMessage && (
          <div className={`mx-4 mt-3 rounded-lg border px-3 py-2 text-sm ${state.lastMessage.kind === 'error' ? 'border-rose-800 bg-rose-950/60 text-rose-200' : 'border-ink-600 bg-ink-850 text-slate-200'}`}>{state.lastMessage.text}</div>
        )}
        <main className="mx-auto max-w-[1400px] p-4"><Outlet /></main>
      </div>
    </div>
  );
}
