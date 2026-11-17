import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Info, Loader2, PlugZap, XCircle } from 'lucide-react';
import type { DataSource, Environment } from '@core/types.ts';
import { formatInr } from '@core/money.ts';

/** Provenance chip: every number on screen says where it came from. */
export function SourceBadge({ source, env }: { source?: DataSource | 'ACTUAL' | 'ESTIMATE' | 'NONE'; env?: Environment }) {
  const map: Record<string, [string, string]> = {
    ACTUAL: ['ACTUAL · broker-reconciled', 'bg-emerald-950 text-emerald-300 border-emerald-800'],
    BROKER: ['ACTUAL · broker', 'bg-emerald-950 text-emerald-300 border-emerald-800'],
    LIVE: ['LIVE market data', 'bg-sky-950 text-sky-300 border-sky-800'],
    PAPER_FEED: ['PAPER · not real money', 'bg-amber-950 text-amber-300 border-amber-800'],
    SIMULATED: ['SIMULATED · not real', 'bg-violet-950 text-violet-300 border-violet-800'],
    HISTORICAL: ['HISTORICAL', 'bg-slate-900 text-slate-300 border-slate-700'],
    ESTIMATE: ['ESTIMATE', 'bg-slate-900 text-amber-200 border-amber-900'],
    MANUAL: ['OWNER-DECLARED · pending reconciliation', 'bg-slate-900 text-slate-300 border-slate-700'],
    NONE: ['NO DATA', 'bg-slate-900 text-slate-500 border-slate-700'],
  };
  const key = source ?? (env === 'production' ? 'ACTUAL' : env === 'paper' ? 'PAPER_FEED' : 'SIMULATED');
  const [t, c] = map[key] ?? map.NONE;
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${c}`}>{t}</span>;
}

export function Inr({ p, sign, className = '' }: { p?: number; sign?: boolean; className?: string }) {
  if (p === undefined || !Number.isFinite(p)) return <span className="text-slate-500">—</span>;
  return <span className={`num ${className}`}>{formatInr(p, { sign })}</span>;
}

/** P&L with explicit sign and direction word (never colour alone). */
export function Pnl({ p, pct }: { p?: number; pct?: number }) {
  if (p === undefined && pct === undefined) return <span className="text-slate-500">—</span>;
  const v = p ?? pct ?? 0;
  const cls = v > 0 ? 'text-[color:var(--gain)]' : v < 0 ? 'text-[color:var(--loss)]' : 'text-slate-300';
  const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '•';
  return (
    <span className={`num font-medium ${cls}`}>
      <span aria-hidden className="mr-0.5 text-[0.7em]">{arrow}</span>
      {p !== undefined ? formatInr(p, { sign: true }) : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`}
    </span>
  );
}

export function Stat({ label, children, sub, source, env, hint }: { label: string; children: ReactNode; sub?: ReactNode; source?: Parameters<typeof SourceBadge>[0]['source']; env?: Environment; hint?: string }) {
  return (
    <div className="card flex flex-col gap-1" title={hint}>
      <div className="flex items-start justify-between gap-2">
        <span className="label">{label}</span>
        <SourceBadge source={source} env={env} />
      </div>
      <div className="text-xl font-semibold text-slate-50">{children}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export function Section({ title, right, children, className = '' }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-0.5 max-w-3xl text-sm text-slate-400">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 rounded-lg border border-dashed border-ink-600 p-4 text-sm text-slate-400"><CircleDashed size={16} />{children}</div>;
}

export function NotConnected({ env }: { env: Environment }) {
  return (
    <div className="card flex items-start gap-3 border-amber-900/60">
      <PlugZap className="mt-0.5 text-amber-400" size={20} />
      <div className="text-sm">
        <div className="font-semibold text-amber-200">{env === 'production' ? 'Production is not connected' : 'Paper trading is not connected'}</div>
        <p className="mt-1 text-slate-400">
          No {env} data is shown because none exists yet. {env === 'production' ? 'Real balances, holdings and fills appear only after the Kite / CoinDCX APIs are authenticated, tested and reconciled.' : 'Paper trading uses live read-only market data from the worker.'}{' '}
          This needs the Base44 deployment and the worker (see API Connections and docs/DEPLOYMENT_CHECKLIST.md). Nothing is simulated in its place.
        </p>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const good = ['FILLED', 'MATCHED', 'SUCCESS', 'VALIDATED', 'EXECUTED', 'AUTHENTICATED', 'TESTED_READ_ONLY', 'TESTED_ORDERS_SANDBOX', 'COMPOUNDED', 'DONE'];
  const bad = ['RISK_REJECTED', 'REJECTED', 'MISMATCH', 'ERROR', 'FAILED', 'HALT', 'BLOCK', 'REVOKED', 'EXPIRED_SESSION'];
  const warn = ['PARTIALLY_FILLED', 'AWAITING_OWNER', 'UNKNOWN', 'WATCHLIST', 'WARN', 'APPROVED', 'EXPIRED', 'NOT_CONFIGURED', 'CANCELLED', 'SKIPPED', 'NOTHING_ELIGIBLE'];
  const [Icon, c] = good.includes(status) ? [CheckCircle2, 'text-emerald-300 bg-emerald-950/70 border-emerald-900'] : bad.includes(status) ? [XCircle, 'text-rose-300 bg-rose-950/70 border-rose-900'] : warn.includes(status) ? [AlertTriangle, 'text-amber-300 bg-amber-950/60 border-amber-900'] : [Info, 'text-slate-300 bg-ink-800 border-ink-600'];
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${c}`}><Icon size={11} />{status.replace(/_/g, ' ')}</span>;
}

export function Spinner() { return <Loader2 className="animate-spin" size={14} />; }

export function ago(ts: number | undefined, now: number) {
  if (!ts) return '—';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const istTime = (ts?: number) => (ts ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
export const px = (x?: number) => (x === undefined || !Number.isFinite(x) ? '—' : x >= 1000 ? x.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : x.toFixed(x < 10 ? 4 : 2));
