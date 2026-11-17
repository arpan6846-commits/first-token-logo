import { useMemo, useState } from 'react';
import { useApp } from '../runtime/AppContext.tsx';
import { Empty, NotConnected, PageHeader, Section, SourceBadge, ago, px } from '../components/ui.tsx';
import { CandleChart, type Level } from '../components/charts.tsx';
import { analyze, HTF_OF } from '@core/signals.ts';
import { marketStatus } from '@core/marketHours.ts';
import type { AssetClass, Timeframe } from '@core/types.ts';

export function Market({ assetClass }: { assetClass: AssetClass }) {
  const { state, actions } = useApp();
  const venue = assetClass === 'EQUITY' ? 'KITE' : 'COINDCX';
  const quotes = state.quotes.filter((q) => q.venue === venue).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const [sel, setSel] = useState<string>();
  const symbol = sel ?? quotes.find((q) => !q.symbol.startsWith('NIFTY'))?.symbol;
  const tf: Timeframe = (assetClass === 'EQUITY' ? state.settings?.stockTimeframe : state.settings?.cryptoTimeframe) ?? (assetClass === 'EQUITY' ? '15m' : '1h');
  const [view, setView] = useState<Timeframe>(tf);
  const ttf = symbol ? actions.candles(venue, symbol, tf) : [];
  const htf = symbol ? actions.candles(venue, symbol, HTF_OF[tf]) : [];
  const shown = symbol ? actions.candles(venue, symbol, view) : [];
  const a = useMemo(() => (ttf.length >= 30 && htf.length >= 20 ? analyze(ttf, htf) : undefined), [ttf, htf]);
  const maxAge = state.settings?.maxQuoteAgeMs ?? 15000;
  const title = assetClass === 'EQUITY' ? 'Stock market (NSE)' : 'Crypto market (spot INR)';
  if (!state.connected) return <><PageHeader title={title} /><NotConnected env={state.environment} /></>;
  const ms = marketStatus(state.now);
  const levels: Level[] = [];
  if (a?.territory.breachLevel) levels.push({ price: a.territory.breachLevel, label: 'HTF breach', tone: 'info' });
  if (a?.territory.initiatorLevel) levels.push({ price: a.territory.initiatorLevel, label: 'Initiator', tone: 'stop' });
  const sig = state.signals.find((s) => s.symbol === symbol && ['VALIDATED', 'APPROVED'].includes(s.status));
  if (sig) levels.push({ price: sig.entry, label: `Entry ${px(sig.entry)}`, tone: 'entry' }, { price: sig.stop, label: `Stop ${px(sig.stop)}`, tone: 'stop' }, { price: sig.target, label: `Target ${px(sig.target)}`, tone: 'target' });
  return (
    <>
      <PageHeader title={title} subtitle={assetClass === 'EQUITY' ? `Market-hours aware: NSE is ${ms.nse}${ms.holidayListLoaded ? '' : ' (holiday list not loaded — load the official NSE calendar)'}. Signals for stocks only run while NSE is open.` : 'Crypto runs 24×7; signals only run while the feed is healthy.'} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Section title="Quotes" right={<span className="text-xs text-slate-500">stale after {maxAge / 1000}s</span>}>
          {quotes.length === 0 ? <Empty>No quotes. Live prices appear only from an authenticated feed.</Empty> : (
            <table className="data"><thead><tr><th>Symbol</th><th className="text-right">LTP</th><th className="text-right">Spread</th><th>Age</th></tr></thead>
              <tbody>{quotes.map((q) => { const stale = state.now - q.exchangeTs > maxAge; return (
                <tr key={q.symbol} className={`cursor-pointer ${q.symbol === symbol ? 'bg-ink-800' : ''}`} onClick={() => setSel(q.symbol)}>
                  <td className="font-medium">{q.symbol}</td><td className="num text-right">{px(q.ltp)}</td>
                  <td className="num text-right text-xs text-slate-400">{q.ask && q.bid ? `${(((q.ask - q.bid) / q.ltp) * 100).toFixed(3)}%` : '—'}</td>
                  <td className={`text-xs ${stale ? 'text-amber-300' : 'text-slate-400'}`}>{stale ? 'STALE · ' : ''}{ago(q.exchangeTs, state.now)}</td>
                </tr>); })}</tbody></table>
          )}
          {quotes[0] && <div className="mt-2"><SourceBadge source={quotes[0].source} /></div>}
        </Section>
        <Section title={symbol ? `${symbol} · ${view}` : 'Chart'} className="xl:col-span-2" right={
          <div className="flex gap-1">{(['5m', '15m', '1h', '4h', '1d'] as Timeframe[]).map((t) => <button key={t} onClick={() => setView(t)} className={`rounded px-2 py-0.5 text-xs ${t === view ? 'bg-ink-600 text-white' : 'text-slate-400'}`}>{t}</button>)}</div>}>
          {symbol ? <CandleChart candles={shown} levels={levels} zone={a?.buildUp ? { top: a.buildUp.top, bottom: a.buildUp.bottom, label: `Build-up (${a.buildUp.touches} touches)` } : undefined} /> : <Empty>Select a symbol.</Empty>}
          {a && (
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <Fact k={`HTF ${HTF_OF[tf]} territory`} v={`${a.territory.side}${a.territory.breachLevel ? ` · breach ${px(a.territory.breachLevel)}` : ''}`} />
              <Fact k={`TTF ${tf} momentum`} v={a.momentum ? `${a.momentum.pct.toFixed(0)}% retrace · ${a.momentum.cls}` : '—'} />
              <Fact k="V-formation" v={a.v ? `${a.v.type} · low ${px(a.v.extreme)}` : 'none'} />
              <Fact k="Build-up" v={a.buildUp ? `${px(a.buildUp.bottom)}–${px(a.buildUp.top)} · ${a.buildUp.sequence}` : 'none'} />
              <Fact k="Volatility" v={`${a.volatility.cls} (${a.volatility.ratio.toFixed(2)})`} />
              <Fact k="Buyers' dominance" v={`${(a.dominanceBuyers * 100).toFixed(0)}% (needs ~70%)`} />
              <Fact k="PDH / PDL" v={`${px(a.pdh)} / ${px(a.pdl)}`} />
              <Fact k="Liquidity crunch" v={a.crunch ? 'signs present' : 'no'} />
            </div>
          )}
          {state.environment === 'simulation' && symbol && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <button className="btn-ghost text-xs" onClick={() => actions.loadScenario(symbol)}>Load scripted rulebook setup on {symbol}</button>
              Injects a textbook SIMULATED setup (HTF breach → lopsided V → 4-touch build-up) to exercise the full pipeline. With the default cost limit (costs ≤ 25% of price risk) small ₹10,000-account trades are rejected; raise it in Settings to see the full flow.
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return <div className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div><div className="num text-slate-200">{v}</div></div>;
}
