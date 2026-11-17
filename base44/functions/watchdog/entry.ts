// Scheduled every 5 min: worker heartbeat, venue sessions, failed jobs.
// Alerts are idempotent per 30-minute bucket (one RiskEvent + one email).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { newId } from '../../shared/core/hash.ts';
import { isNseOpen } from '../../shared/core/marketHours.ts';
import { json, optionalSecret } from '../../shared/security.ts';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole.entities;
  const now = Date.now();
  const bucket = Math.floor(now / 1_800_000);
  const alerts: { code: string; message: string }[] = [];
  const [sys] = await svc.SystemState.filter({ uid: 'system' }, undefined, 1);
  const hb = sys?.workerHeartbeatAt ?? 0;
  if (now - hb > 3 * 60_000) alerts.push({ code: 'WORKER_DOWN', message: `Worker heartbeat ${hb ? Math.round((now - hb) / 60000) + ' min old' : 'never seen'} — no monitoring, no exits, no reconciliation. New orders are impossible without the worker.` });
  for (const c of await svc.APIConnections.filter({ environment: 'production' })) {
    if (c.status === 'AUTHENTICATED' && c.sessionExpiresAt && c.sessionExpiresAt < now) alerts.push({ code: `${c.venue}_SESSION_EXPIRED`, message: `${c.venue} session expired — log in again (orders are blocked until then).` });
    if (c.lastHealthOk === false && isNseOpen(now)) alerts.push({ code: `${c.venue}_UNHEALTHY`, message: `${c.venue} health check failing: ${c.lastError ?? 'unknown'}` });
    if (c.feedHealthy === false && (c.venue === 'COINDCX' || isNseOpen(now))) alerts.push({ code: `${c.venue}_FEED_DOWN`, message: `${c.venue} market feed stale — signals and entries are blocked.` });
  }
  const failed = (await svc.AutomationLogs.filter({ status: 'FAILED' }, '-ts', 20)).filter((l: { ts: number }) => now - l.ts < 15 * 60_000);
  if (failed.length) alerts.push({ code: 'JOB_FAILED', message: `${failed.length} job(s) failed: ${failed.map((f: { job: string }) => f.job).join(', ')}` });

  const sent: string[] = [];
  for (const a of alerts) {
    const exists = (await svc.RiskEvents.filter({ code: `ALERT_${a.code}` }, '-ts', 5)).some((e: { data?: { bucket?: number } }) => e.data?.bucket === bucket);
    if (exists) continue;
    await svc.RiskEvents.create({ uid: newId('rsk'), environment: 'production', ts: now, code: `ALERT_${a.code}`, severity: 'WARN', message: a.message, data: { bucket } });
    const to = optionalSecret('OWNER_EMAIL');
    if (to) {
      try { await base44.asServiceRole.integrations.Core.SendEmail({ to, subject: `Wealth Engine AI alert: ${a.code}`, body: a.message }); } catch { /* alert still recorded */ }
    }
    sent.push(a.code);
  }
  return json({ checked: true, alerts: alerts.map((a) => a.code), newlySent: sent });
});
