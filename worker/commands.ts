// Executes owner commands (signed by ownerCommand) against the right engine.
// The worker is the single writer, so every state change is serialised here.

import { mergeAiReview, type AiReviewOutput } from '../core/aiReview.ts';
import type { TradingEngine } from '../core/engine.ts';
import { canonicalJson, hmacSha256Hex, newId, timingSafeEqualHex } from '../core/hash.ts';
import { FIRST_LIVE_ORDER_PHRASE } from '../core/oms.ts';
import type { OrderProposal } from '../core/risk.ts';
import type { Environment, JournalEntry, TradeOrder, Venue } from '../core/types.ts';

export interface Command { uid: string; type: string; environment: Environment; payload: Record<string, unknown>; requestedBy: string; requestedAt: number; signature?: string }

export function verifyCommand(c: Command, signingSecret: string): boolean {
  if (!c.signature) return false;
  const body = { uid: c.uid, type: c.type, environment: c.environment, payload: c.payload, requestedBy: c.requestedBy, requestedAt: c.requestedAt };
  return timingSafeEqualHex(hmacSha256Hex(signingSecret, canonicalJson(body)), c.signature);
}

export async function executeCommand(c: Command, engines: Partial<Record<Environment, TradingEngine>>, now: number): Promise<Record<string, unknown>> {
  const e = engines[c.environment];
  if (!e) throw new Error(`No ${c.environment} engine running in this worker`);
  const p = c.payload;
  const stale = now - c.requestedAt > 60 * 60_000;
  if (stale && !(c.type === 'KILL_SWITCH' && p.active === true)) throw new Error('Command older than 1 hour — refused (re-issue it)');
  switch (c.type) {
    case 'KILL_SWITCH': {
      const ks = await e.setKillSwitch(p.active as boolean, String(p.reason), 'owner', { confirm: p.confirm === true, cancelOpenOrders: p.cancelOpenOrders !== false });
      // global flag: cancel open orders in every running environment
      if (ks.active) for (const other of Object.values(engines)) if (other && other !== e) await other.oms.cancelAllOpen('owner');
      return { killSwitch: ks };
    }
    case 'APPROVE_SIGNAL': {
      const r = await e.approveSignal(String(p.signalId), { actor: 'owner', manualTicks: p.manualTicks as Record<number, boolean> | undefined });
      return { signalStatus: r.signal.status, orderId: r.result?.order.id, orderStatus: r.result?.order.status };
    }
    case 'CANCEL_SIGNAL': {
      const s = await e.repo.signals.get(String(p.signalId));
      if (!s || !['VALIDATED', 'WATCHLIST', 'APPROVED'].includes(s.status)) throw new Error('Signal not cancellable');
      await e.repo.signals.update(s.id, { status: 'EXPIRED', expiryReason: 'Cancelled by owner' });
      await e.audit('owner', 'CANCEL_SIGNAL', { signalId: s.id });
      return { ok: true };
    }
    case 'SUBMIT_ORDER': {
      const prop = { ...(p.proposal as OrderProposal), environment: c.environment, idempotencyKey: String((p.proposal as OrderProposal).idempotencyKey ?? `cmd:${c.uid}`) };
      const r = await e.submitOrder(prop, { actor: 'owner', ownerConfirmed: p.ownerConfirmed === true, firstLiveOrderConfirmation: p.firstLiveOrderPhrase as string | undefined });
      return { orderId: r.order.id, status: r.order.status, duplicate: r.duplicate, failures: r.decision?.failures };
    }
    case 'CONFIRM_ORDER': {
      const r = await e.confirmOrder(String(p.orderId), { actor: 'owner', ownerConfirmed: true, firstLiveOrderConfirmation: p.firstLiveOrderPhrase as string | undefined });
      return { orderId: r.order.id, status: r.order.status, failures: r.decision?.failures };
    }
    case 'CANCEL_ORDER': { const o = await e.oms.cancel(String(p.orderId), 'owner'); await e.audit('owner', 'CANCEL_ORDER', { orderId: o.id }); return { status: o.status }; }
    case 'UPDATE_SETTINGS': return { ...(await e.changeSettings(p.patch as never, 'owner', p.confirmationPhrase as string | undefined)), next: undefined };
    case 'CASH_FLOW': { const le = await e.recordDeposit(p.venue as Venue | 'BANK', Number(p.rupees), 'owner', String(p.reference)); return { ledgerEntryId: le.id }; }
    case 'RECONCILE': return { record: await e.reconcile(p.venue as Venue) };
    case 'GENERATE_SIGNALS': { const s = await e.generateSignals(); return { analysed: s.length, validated: s.filter((x) => x.status === 'VALIDATED').length }; }
    case 'DAILY_CLOSE': return { log: await e.dailyClose(p.date as string | undefined) };
    case 'CONFIRM_FIRST_LIVE_ORDER': {
      if (p.phrase !== FIRST_LIVE_ORDER_PHRASE) throw new Error(`Type exactly: ${FIRST_LIVE_ORDER_PHRASE}`);
      await e.confirmFirstLiveOrder('owner');
      return { ok: true };
    }
    case 'JOURNAL': {
      const j = p.entry as JournalEntry;
      if (!['PRE_TRADE', 'POST_TRADE', 'PROFILE', 'PSYCHOLOGY'].includes(j.kind)) throw new Error('bad journal kind');
      const doc = await e.repo.journal.insert({ ...j, id: newId('jrn'), environment: c.environment, ts: now });
      return { id: doc.id };
    }
    case 'APPLY_AI_REVIEW': {
      const s = await e.repo.signals.get(String(p.signalId));
      if (!s) throw new Error('signal not found');
      const merged = mergeAiReview(s, p.review as AiReviewOutput, String(p.model), now);
      await e.repo.signals.update(s.id, { aiReview: merged.aiReview, status: merged.status, confidence: merged.confidence, rejectionReasons: merged.rejectionReasons });
      await e.audit('ai', 'AI_REVIEW', { signalId: s.id, verdict: merged.aiReview?.verdict, statusAfter: merged.status });
      return { status: merged.status };
    }
    case 'CLOSE_UNKNOWN_ORDER': {
      const o = await e.repo.orders.get(String(p.orderId));
      if (!o) throw new Error('order not found');
      const rec = (await e.repo.reconciliations.list({ environment: c.environment, venue: o.venue } as never)).sort((a, b) => b.ts - a.ts)[0];
      if (!rec || rec.ts < o.updatedAt + 5 * 60_000) throw new Error('Run a reconciliation (≥5 min after the order) first');
      const st = await e.oms.resolveUnknown(o);
      if (st.status !== 'UNKNOWN') return { status: st.status, note: 'Venue found the order' };
      return { status: (await e.oms.markNeverReceived(o.id, rec.id)).status };
    }
    case 'VENUE_ORDER_UPDATE': {
      const o = (await e.repo.orders.list({ environment: c.environment, brokerOrderId: String(p.brokerOrderId) } as Partial<TradeOrder>))[0];
      if (!o) return { note: 'Order not placed by this app — reconciliation will flag it' };
      return { status: (await e.oms.sync(o)).status };
    }
    case 'SET_COMPLIANCE': return { note: 'stored by worker main loop' };
    default: throw new Error(`Unknown command ${c.type}`);
  }
}
