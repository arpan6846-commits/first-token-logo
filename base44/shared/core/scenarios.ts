// Scripted price paths for SIMULATION and tests only. They reproduce a
// textbook rulebook setup so the full pipeline (signal → Final Check → risk →
// order → fills → exits → ledger → compounding) can be exercised end to end.
// Every candle from here is labelled SIMULATED and can never reach production.

import type { Candle } from './types.ts';

/** Closes for a long setup on a reference price of 150 (scaled to `refPrice`). */
function longSetupPath(): number[] {
  const p: number[] = [];
  const lerp = (a: number, b: number, n: number) => { for (let i = 1; i <= n; i++) p.push(a + ((b - a) * i) / n); };
  p.push(150);
  for (let i = 0; i < 80; i++) p.push(150 + Math.sin(i / 3) * 1.5); // earlier history (range)
  lerp(p[p.length - 1], 132, 16);        // sellers' decline
  lerp(132, 140, 10);        // bounce → reacted HTF high ~140 (later the target)
  lerp(140, 110, 34);        // decline to the base
  for (let i = 0; i < 40; i++) p.push(110 + (i % 4) * 0.6 + i * 0.05); // base with rising lows
  lerp(p[p.length - 1], 120, 12); // rally into 120
  lerp(120, 116.5, 6);       // reaction at 120 (prior reaction → important level)
  lerp(116.5, 124, 12);      // buyers break 120 and sustain → buyers' territory
  for (let i = 0; i < 14; i++) p.push(122.6 + (i % 2) * 1.1); // consolidation 122.6–123.7
  lerp(p[p.length - 1], 118.5, 12); // sellers leave the consolidation slowly (V low)
  lerp(118.5, 124.4, 2);     // buyers drive back fast into and above it (lopsided V)
  const bu = [123.4, 124.3, 123.5, 124.4, 123.45, 124.35, 123.5, 124.3, 123.55, 124.4, 123.6, 124.3, 123.5, 124.35, 123.6, 124.25];
  for (const x of bu) { p.push(x); p.push(x + (x > 124 ? -0.25 : 0.25)); } // 4+ touch build-up
  return p;
}

export function scriptedLongSetup(endTs: number, tfMs: number, refPrice = 150, tick = 0.05): Candle[] {
  const path = longSetupPath();
  const k = refPrice / 150;
  const q = (x: number) => Math.max(tick, Number((Math.round((x * k) / tick) * tick).toFixed(6)));
  const n = path.length - 1;
  const out: Candle[] = [];
  for (let i = 1; i <= n; i++) {
    const o = path[i - 1], c = path[i];
    const wick = 0.12; // uniform small wicks: no accidental pivots above the build-up
    out.push({ ts: endTs - (n - i + 1) * tfMs, open: q(o), high: q(Math.max(o, c) + wick), low: q(Math.min(o, c) - wick), close: q(c), volume: 1000 });
  }
  return out;
}
