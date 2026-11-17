// Lightweight SVG charts (no chart library): single-series equity line with a
// hover crosshair, and a candlestick chart with labelled price levels.
import { useMemo, useRef, useState } from 'react';
import type { Candle } from '@core/types.ts';
import { formatInr } from '@core/money.ts';
import { px } from './ui.tsx';

const W = 720;

export function LineChart({ points, height = 180, label }: { points: { x: string; y: number }[]; height?: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (points.length < 2) return <div className="flex h-[140px] items-center justify-center text-sm text-slate-500">Not enough daily snapshots yet to draw {label.toLowerCase()}.</div>;
  const ys = points.map((p) => p.y);
  const min = Math.min(...ys), max = Math.max(...ys), pad = (max - min) * 0.1 || 1;
  const sx = (i: number) => 44 + (i / (points.length - 1)) * (W - 56);
  const sy = (v: number) => 10 + (1 - (v - (min - pad)) / (max - min + 2 * pad)) * (height - 34);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
  const ticks = [min, (min + max) / 2, max];
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((x - 44) / (W - 56)) * (points.length - 1)))));
  };
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => <g key={i}><line x1={44} x2={W - 12} y1={sy(t)} y2={sy(t)} stroke="#1d2633" /><text x={40} y={sy(t) + 3} textAnchor="end" fontSize="10" fill="#8391a5">{(t / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</text></g>)}
        <path d={d} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" />
        <text x={44} y={height - 6} fontSize="10" fill="#8391a5">{points[0].x}</text>
        <text x={W - 12} y={height - 6} fontSize="10" fill="#8391a5" textAnchor="end">{points[points.length - 1].x}</text>
        {hover !== null && <g><line x1={sx(hover)} x2={sx(hover)} y1={10} y2={height - 24} stroke="#8391a5" strokeDasharray="3 3" /><circle cx={sx(hover)} cy={sy(points[hover].y)} r={4} fill="var(--series-1)" stroke="#0b0f16" strokeWidth={2} /></g>}
      </svg>
      {hover !== null && <div className="pointer-events-none absolute right-2 top-1 rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-slate-200"><span className="text-slate-400">{points[hover].x}</span> · <span className="num">{formatInr(points[hover].y)}</span></div>}
    </div>
  );
}

export interface Level { price: number; label: string; tone: 'entry' | 'stop' | 'target' | 'zone' | 'info' }

export function CandleChart({ candles, levels = [], height = 300, zone }: { candles: Candle[]; levels?: Level[]; height?: number; zone?: { top: number; bottom: number; label: string } }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const cs = useMemo(() => candles.slice(-120), [candles]);
  if (cs.length < 5) return <div className="flex h-[200px] items-center justify-center text-sm text-slate-500">No closed candles available.</div>;
  const lo = Math.min(...cs.map((c) => c.low), ...levels.map((l) => l.price)), hi = Math.max(...cs.map((c) => c.high), ...levels.map((l) => l.price));
  const pad = (hi - lo) * 0.05 || 1;
  const left = 8, right = 64, top = 8, bottom = 22;
  const cw = (W - left - right) / cs.length;
  const sy = (v: number) => top + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (height - top - bottom);
  const tone = { entry: '#3987e5', stop: '#e66767', target: '#0ca30c', zone: '#c98500', info: '#8391a5' };
  const onMove = (e: React.MouseEvent) => { const r = ref.current!.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(cs.length - 1, Math.floor((x - left) / cw)))); };
  const h = hover !== null ? cs[hover] : undefined;
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Candlestick chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => { const v = lo - pad + f * (hi - lo + 2 * pad); return <g key={f}><line x1={left} x2={W - right} y1={sy(v)} y2={sy(v)} stroke="#151c27" /><text x={W - right + 4} y={sy(v) + 3} fontSize="10" fill="#6b7a8f">{px(v)}</text></g>; })}
        {zone && <g><rect x={left} width={W - left - right} y={sy(zone.top)} height={Math.max(1, sy(zone.bottom) - sy(zone.top))} fill="#c98500" opacity={0.12} /><text x={left + 4} y={sy(zone.top) - 3} fontSize="10" fill="#c98500">{zone.label}</text></g>}
        {cs.map((c, i) => {
          const x = left + i * cw + cw / 2, up = c.close >= c.open;
          const col = up ? '#2f9e6a' : '#c45656';
          return <g key={c.ts}><line x1={x} x2={x} y1={sy(c.high)} y2={sy(c.low)} stroke={col} strokeWidth={1} /><rect x={x - Math.max(1, cw * 0.32)} width={Math.max(1.5, cw * 0.64)} y={sy(Math.max(c.open, c.close))} height={Math.max(1, Math.abs(sy(c.open) - sy(c.close)))} fill={up ? 'none' : col} stroke={col} strokeWidth={1} rx={0.5} /></g>;
        })}
        {levels.map((l) => <g key={l.label}><line x1={left} x2={W - right} y1={sy(l.price)} y2={sy(l.price)} stroke={tone[l.tone]} strokeWidth={1.5} strokeDasharray={l.tone === 'info' ? '2 3' : '6 3'} /><rect x={W - right + 1} y={sy(l.price) - 8} width={right - 2} height={16} rx={3} fill="#0b0f16" stroke={tone[l.tone]} /><text x={W - right + 4} y={sy(l.price) + 3} fontSize="9.5" fill="#e2e8f0">{l.label}</text></g>)}
        {hover !== null && <line x1={left + hover * cw + cw / 2} x2={left + hover * cw + cw / 2} y1={top} y2={height - bottom} stroke="#8391a5" strokeDasharray="3 3" />}
      </svg>
      {h && <div className="pointer-events-none absolute left-2 top-1 rounded border border-ink-600 bg-ink-850 px-2 py-1 font-mono text-[11px] text-slate-200">{new Date(h.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} · O {px(h.open)} H {px(h.high)} L {px(h.low)} C {px(h.close)}</div>}
    </div>
  );
}
