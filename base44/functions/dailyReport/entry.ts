// Scheduled daily report e-mail. Uses only stored, reconciled numbers and labels
// every figure with its environment. Idempotent per IST date.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { newId } from '../../shared/core/hash.ts';
import { istDate } from '../../shared/core/marketHours.ts';
import { formatInr } from '../../shared/core/money.ts';
import { json, optionalSecret } from '../../shared/security.ts';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole.entities;
  const date = istDate(Date.now());
  const runKey = `report:${date}`;
  if ((await svc.AutomationLogs.filter({ runKey, status: 'SUCCESS' }, undefined, 1)).length) return json({ skipped: true });
  const lines: string[] = [`Wealth Engine AI — daily report ${date} (IST)`, ''];
  for (const env of ['production', 'paper', 'simulation']) {
    const [s] = await svc.DailySnapshots.filter({ environment: env, date }, undefined, 1);
    if (!s) { lines.push(`[${env.toUpperCase()}] no snapshot for today${env === 'production' ? ' (not trading / not connected)' : ''}`); continue; }
    lines.push(
      `[${env.toUpperCase()}${env !== 'production' ? ' — NOT REAL MONEY' : ''}]`,
      `  Net equity ${formatInr(s.netEquityPaise)} | day ${s.dayReturnPct}% | cumulative ${s.cumReturnPct}% | drawdown ${s.drawdownPct}%`,
      `  Realized today ${formatInr(s.realizedPnlDayPaise, { sign: true })} | unrealized ${formatInr(s.unrealizedPnlPaise, { sign: true })} (estimate at last price) | fees today ${formatInr(s.feesDayPaise)} | tax reserve ${formatInr(s.taxReservePaise)} (estimate)`,
    );
    const [c] = await svc.CompoundingEvents.filter({ environment: env, date }, undefined, 1);
    if (c) lines.push(`  Compounding: ${c.note}`);
  }
  const risks = (await svc.RiskEvents.filter({}, '-ts', 50)).filter((r: { ts: number; severity: string }) => Date.now() - r.ts < 86_400_000 && ['BLOCK', 'HALT'].includes(r.severity));
  lines.push('', `Risk blocks/halts in last 24h: ${risks.length}`);
  lines.push('', 'The 10% daily figure is an aspirational target only — it is not a forecast and not a guarantee. Losses are possible.');
  const to = optionalSecret('OWNER_EMAIL');
  if (to) await base44.asServiceRole.integrations.Core.SendEmail({ to, subject: `Wealth Engine AI — ${date}`, body: lines.join('\n') });
  await svc.AutomationLogs.create({ uid: newId('log'), environment: 'production', ts: Date.now(), job: 'daily-report', runKey, status: 'SUCCESS', message: `sent to owner (${lines.length} lines)`, actor: 'system' });
  return json({ sent: !!to });
});
