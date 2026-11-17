// The ONLY way the browser can change anything. Authenticates the owner,
// validates the command, records it signed for the worker (the single writer),
// and applies an emergency kill switch to SystemState immediately.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import { newId } from '../../shared/core/hash.ts';
import { RISK_CONFIRMATION_PHRASE } from '../../shared/core/settings.ts';
import { COMMAND_TYPES, errorResponse, HttpError, json, requireOwner, signCommand, type CommandType } from '../../shared/security.ts';

const ENVS = ['simulation', 'paper', 'production'];

function validate(type: CommandType, env: string, p: Record<string, unknown>) {
  const need = (k: string, t: string) => { if (typeof p[k] !== t) throw new HttpError(400, `${type}: '${k}' must be ${t}`); };
  switch (type) {
    case 'APPROVE_SIGNAL': case 'CANCEL_SIGNAL': case 'APPLY_AI_REVIEW': need('signalId', 'string'); break;
    case 'CONFIRM_ORDER': case 'CANCEL_ORDER': case 'CLOSE_UNKNOWN_ORDER': need('orderId', 'string'); break;
    case 'KILL_SWITCH': need('active', 'boolean'); need('reason', 'string'); if (p.active === false && p.confirm !== true) throw new HttpError(400, 'Deactivating the kill switch needs confirm: true'); break;
    case 'UPDATE_SETTINGS': need('patch', 'object'); if (p.confirmationPhrase !== undefined && p.confirmationPhrase !== RISK_CONFIRMATION_PHRASE) throw new HttpError(400, 'Wrong confirmation phrase'); break;
    case 'CASH_FLOW': need('venue', 'string'); need('rupees', 'number'); need('reference', 'string'); break;
    case 'SUBMIT_ORDER': need('proposal', 'object'); break;
    case 'RECONCILE': need('venue', 'string'); break;
    case 'JOURNAL': need('entry', 'object'); break;
    case 'SET_COMPLIANCE': need('ticks', 'object'); break;
  }
  if (env === 'production' && type === 'SUBMIT_ORDER' && p.ownerConfirmed !== true) throw new HttpError(400, 'Production manual orders require ownerConfirmed: true');
  if ('actor' in p) throw new HttpError(400, 'Commands always run as the owner; actor cannot be set');
}

Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const base44 = createClientFromRequest(req);
    const owner = await requireOwner(base44);
    const body = await req.json().catch(() => { throw new HttpError(400, 'Invalid JSON'); });
    const type = body.type as CommandType;
    if (!COMMAND_TYPES.includes(type) || type === 'VENUE_ORDER_UPDATE') throw new HttpError(400, 'Unknown command type');
    if (!ENVS.includes(body.environment)) throw new HttpError(400, 'Unknown environment');
    const payload = (body.payload ?? {}) as Record<string, unknown>;
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'payload must be an object');
    validate(type, body.environment, payload);

    const svc = base44.asServiceRole.entities;
    if (type === 'KILL_SWITCH' && payload.active === true) {
      // Immediate effect, even if the worker is down: every placement path re-reads this flag.
      const [sys] = await svc.SystemState.filter({ uid: 'system' }, undefined, 1);
      const ks = { active: true, reason: String(payload.reason).slice(0, 500), activatedAt: Date.now(), activatedBy: 'owner' };
      if (sys) await svc.SystemState.update(sys.id, { killSwitch: ks }); else await svc.SystemState.create({ uid: 'system', killSwitch: ks });
    }
    const cmd = { uid: newId('cmd'), type, environment: body.environment, payload, requestedBy: owner.email, requestedAt: Date.now() };
    await svc.Commands.create({ ...cmd, signature: signCommand(cmd), status: 'PENDING' });
    return json({ commandId: cmd.uid, status: 'PENDING' }, 202);
  } catch (e) {
    return errorResponse(e);
  }
});
