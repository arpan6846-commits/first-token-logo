// The ONLY component allowed to display the daily target (enforced by
// tests/acceptance.test.ts). It always shows that the target is aspirational
// and not a guarantee, and it never projects or extrapolates returns.
import { Target } from 'lucide-react';
import type { DailySnapshot, StrategySettings } from '@core/types.ts';

export function TargetProgress({ settings, todayReturnPct }: { settings?: StrategySettings; todayReturnPct?: number; snapshot?: DailySnapshot }) {
  const target = settings?.dailyTargetPct;
  if (target === undefined) return null;
  const progress = todayReturnPct === undefined ? undefined : (todayReturnPct / target) * 100;
  const width = Math.max(0, Math.min(100, progress ?? 0));
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <span className="label flex items-center gap-1.5"><Target size={13} /> Aspirational daily target</span>
        <span className="rounded border border-amber-800 bg-amber-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">Aspiration — not a guarantee</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="num text-xl font-semibold text-slate-50">{todayReturnPct === undefined ? '—' : `${todayReturnPct > 0 ? '+' : ''}${todayReturnPct.toFixed(2)}%`}</span>
        <span className="text-sm text-slate-400">today vs {target}% aspiration</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-valuenow={Math.round(width)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-[color:var(--series-1)]" style={{ width: `${width}%` }} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">
        This is not a guarantee, a forecast or an expected return. Risk limits and position sizes never change to chase it; most days will fall short and some will be losses.
      </p>
    </div>
  );
}
