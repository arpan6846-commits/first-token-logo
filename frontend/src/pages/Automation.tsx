import { useApp } from '../runtime/AppContext.tsx';
import { Empty, NotConnected, PageHeader, Section, StatusPill, istTime } from '../components/ui.tsx';

const JOBS = [
  ['Market-data health check', 'every 60 s (worker) + watchdog every 5 min (Base44)', 'Feed staleness blocks signals and entries'],
  ['Stock monitoring & signals', 'each closed 15m bar while NSE is open', 'runKey sig:{env}:15m:{bar}'],
  ['Crypto monitoring & signals', 'each closed 1h bar, only when the CoinDCX feed is healthy', 'runKey sig:{env}:1h:{bar}'],
  ['Risk approval', 'before every order (and again at trigger time)', 'deterministic, cannot be bypassed'],
  ['Order-status reconciliation', 'every 5 s order sync + Kite postbacks', 'UNKNOWN orders resolved by client order id'],
  ['Balance / holdings / trade reconciliation', 'every 30 min per venue', 'runKey rec:{env}:{venue}:{half-hour}'],
  ['Daily P&L close, tax reserve, compounding, snapshot', '23:50 IST', 'runKey close:{date}'],
  ['Daily report e-mail', '18:15 IST (Base44 scheduled function)', 'runKey report:{date}'],
  ['Connection recovery', 'WebSocket auto-reconnect with backoff; Kite session refresh check every 60 s', 'alerts after 3 min of silence'],
  ['Failed-job alerts', 'watchdog every 5 min', 'one alert per 30-min bucket'],
];

export function Automation() {
  const { state, actions } = useApp();
  if (!state.connected) return <><PageHeader title="Automation controls" /><NotConnected env={state.environment} /></>;
  return (
    <>
      <PageHeader title="Automation controls" subtitle="Every scheduled action is idempotent: a run key that already succeeded is skipped, so retries and overlapping schedulers cannot double-execute." />
      <Section title="Run now">
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" disabled={state.busy} onClick={() => actions.generateSignals()}>Generate signals</button>
          <button className="btn-ghost" disabled={state.busy} onClick={() => actions.reconcile('KITE')}>Reconcile Kite</button>
          <button className="btn-ghost" disabled={state.busy} onClick={() => actions.reconcile('COINDCX')}>Reconcile CoinDCX</button>
          <button className="btn-ghost" disabled={state.busy} onClick={() => actions.dailyClose()}>Daily close</button>
          {state.environment === 'simulation' && <button className="btn-ghost" disabled={state.busy} onClick={() => { if (confirm('Erase the simulation book and start again from ₹10,000?')) actions.reset(); }}>Reset simulation</button>}
        </div>
        <p className="mt-2 text-xs text-slate-500">Execution mode: <strong>{state.settings?.executionMode}</strong>. In manual-approval mode every entry needs the owner to arm the signal; protective stop/target exits of approved trades run automatically.</p>
      </Section>
      <Section title="Schedule" className="mt-4">
        <table className="data text-sm"><thead><tr><th>Job</th><th>When</th><th>Idempotency / note</th></tr></thead><tbody>{JOBS.map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="text-xs text-slate-300">{b}</td><td className="font-mono text-[11px] text-slate-400">{c}</td></tr>)}</tbody></table>
      </Section>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Section title="Job log">
          {state.logs.length === 0 ? <Empty>No runs yet.</Empty> : (
            <div className="max-h-[50vh] overflow-auto"><table className="data"><thead><tr><th>Time</th><th>Job</th><th>Status</th><th>Message</th></tr></thead>
              <tbody>{state.logs.slice(0, 200).map((l) => <tr key={l.id}><td className="whitespace-nowrap text-xs text-slate-400">{istTime(l.ts)}</td><td className="text-xs">{l.job}</td><td><StatusPill status={l.status} /></td><td className="text-xs text-slate-400">{l.message}</td></tr>)}</tbody></table></div>
          )}
        </Section>
        <Section title="Reconciliations">
          {state.reconciliations.length === 0 ? <Empty>No reconciliations yet.</Empty> : (
            <div className="max-h-[50vh] overflow-auto"><table className="data"><thead><tr><th>Time</th><th>Venue</th><th>Status</th><th>Message</th></tr></thead>
              <tbody>{state.reconciliations.slice(0, 100).map((r) => <tr key={r.id}><td className="whitespace-nowrap text-xs text-slate-400">{istTime(r.ts)}</td><td>{r.venue}</td><td><StatusPill status={r.status} /></td><td className="text-xs text-slate-400">{r.message}{r.diffs.length > 0 && <ul>{r.diffs.map((d) => <li key={d.field}>{d.field}: ours {String(d.internal)} vs venue {String(d.venue)}</li>)}</ul>}</td></tr>)}</tbody></table></div>
          )}
        </Section>
      </div>
    </>
  );
}
