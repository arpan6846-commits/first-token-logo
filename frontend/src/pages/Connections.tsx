import { KeyRound, LogIn, ShieldOff } from 'lucide-react';
import { useApp } from '../runtime/AppContext.tsx';
import { ConfirmButton, Empty, PageHeader, Section, StatusPill, ago } from '../components/ui.tsx';
import type { Venue } from '@core/types.ts';

const CAPS: Record<'KITE' | 'COINDCX', { title: string; points: string[]; verify: string[] }> = {
  KITE: {
    title: 'Zerodha Kite Connect v3 — NSE/BSE cash equity',
    points: ['Daily login via official Kite login page (no password/TOTP stored)', 'Access token exchanged server-side, stored AES-GCM encrypted, expires ~06:00 IST', 'Orders: product=CNC only, LIMIT preferred, `tag` = our client order id', 'Postbacks verified with sha256(order_id + order_timestamp + api_secret)', 'WebSocket ticker (full mode) for live quotes, run by the worker'],
    verify: ['Current Kite Connect plan/pricing and personal-use terms', 'Static IP whitelisting requirement for order APIs', "SEBI retail-algo framework: whether your API orders need registration / algo-ID via Zerodha", 'Historical candle API entitlement', 'Order-rate limits'],
  },
  COINDCX: {
    title: 'CoinDCX — crypto spot (INR markets)',
    points: ['HMAC-SHA256 signed requests from the server/worker only', 'Spot limit/market orders with unique client_order_id', 'Trade history with exchange-reported fees', 'No margin, futures or withdrawal endpoints are ever called'],
    verify: ['API key created WITHOUT withdrawal permission (and IP-bound if offered)', 'Current fee schedule and TDS handling', 'Ticker / candle endpoint formats (marked [VERIFY] in code)', 'Rate limits'],
  },
};

export function Connections() {
  const { state, actions } = useApp();
  const conns = state.connections;
  return (
    <>
      <PageHeader title="API connections" subtitle="Nothing is reported as connected until it is authenticated and tested. Secrets live only in Base44 backend secrets and the worker environment — never in the browser, logs or database records." />
      {state.mode === 'local-simulation' && (
        <div className="mb-4 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200">
          Local mode: no broker or exchange is connected. Kite and CoinDCX are <strong>awaiting credentials</strong> and the Base44 + worker deployment (docs/DEPLOYMENT_CHECKLIST.md). The simulation environment uses an in-browser simulated venue.
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {(['KITE', 'COINDCX'] as Venue[]).map((v) => {
          const c = conns.find((x) => x.venue === v);
          const cap = CAPS[v as 'KITE' | 'COINDCX'];
          return (
            <Section key={v} title={cap.title} right={<StatusPill status={c?.status ?? 'NOT_CONFIGURED'} />}>
              {c ? (
                <table className="data text-xs"><tbody>
                  <tr><td>Environment</td><td>{c.environment}</td></tr>
                  <tr><td>Permissions</td><td>read {c.permissions.read ? '✓' : '✗'} · trade {c.permissions.trade ? '✓' : '✗'} · withdraw {c.permissions.withdraw ? <span className="text-rose-300">ENABLED — revoke it</span> : '✗ (disabled)'}</td></tr>
                  <tr><td>Session expires</td><td>{c.sessionExpiresAt ? new Date(c.sessionExpiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td></tr>
                  <tr><td>Last health check</td><td>{c.lastHealthCheckAt ? `${ago(c.lastHealthCheckAt, state.now)} · ${c.lastHealthOk ? 'OK' : `FAIL ${c.lastError ?? ''}`}` : 'never'}</td></tr>
                  <tr><td>Market feed</td><td>{c.feedHealthy === undefined ? '—' : c.feedHealthy ? 'healthy' : 'STALE'}</td></tr>
                  <tr><td>Notes</td><td>{c.capabilityNotes ?? '—'}</td></tr>
                </tbody></table>
              ) : <Empty>Not configured.</Empty>}
              <div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs">
                <div><div className="label mb-1">Implemented</div><ul className="space-y-0.5 text-slate-300">{cap.points.map((p) => <li key={p}>• {p}</li>)}</ul></div>
                <div><div className="label mb-1">Verify before enabling trading</div><ul className="space-y-0.5 text-amber-200/80">{cap.verify.map((p) => <li key={p}>• {p}</li>)}</ul></div>
              </div>
              {v === 'KITE' && state.environment === 'production' && <button className="btn-primary mt-3" disabled={state.mode !== 'base44' || state.busy} onClick={() => actions.kiteLogin()}><LogIn size={14} />Log in to Kite (daily)</button>}
            </Section>
          );
        })}
      </div>
      <Section title="Credential revocation" className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmButton className="btn-danger" label="Revoke credentials & stop trading" confirmLabel="Yes: kill switch on, revoke Kite session, mark connections REVOKED" disabled={state.mode !== 'base44' || state.busy} onConfirm={() => actions.revokeCredentials()}><ShieldOff size={14} /></ConfirmButton>
          <span className="text-xs text-slate-400"><KeyRound size={12} className="mr-1 inline" />Also delete the CoinDCX key in its dashboard and regenerate the Kite API secret; then rotate the Base44 secrets.</span>
        </div>
      </Section>
    </>
  );
}
