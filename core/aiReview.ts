// Contract between the deterministic engine and the LLM reviewer (Claude).
// The model receives the already-computed analysis and may only AGREE,
// DOWNGRADE or REJECT. It never sets prices, quantities, risk or permissions;
// `mergeAiReview` ignores anything except verdict and notes, and can only lower
// confidence or move a signal to WATCHLIST/REJECTED.

import type { AISignal } from './types.ts';
import { DISCLAIMER_HI } from './propDesk.ts';

export const AI_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'notes', 'missing_conditions', 'retail_illusion_ok'],
  properties: {
    verdict: { type: 'string', enum: ['agree', 'downgrade', 'reject'] },
    notes: { type: 'string', description: 'Short Hinglish reasoning tied to rulebook rules and the given levels' },
    missing_conditions: { type: 'array', items: { type: 'string' } },
    retail_illusion_ok: { type: 'boolean' },
  },
} as const;

export const AI_REVIEW_SYSTEM = `You are the review analyst of a personal prop price-action desk that follows the course "The Language of Price".
You receive a trade candidate that a deterministic engine has already computed from real market data.
Rules:
- Use ONLY the numbers given. Never invent prices, levels, balances, news or returns. If something needed is missing, list it in missing_conditions.
- You may only agree, downgrade (→ watchlist) or reject. You cannot raise confidence, change entry/stop/target/quantity, or change risk limits or permissions.
- Check the logic: territory direction, retail illusion, V + build-up, momentum retracement, dominance 70/30, target is a price-action level (no fixed multiples), no revenge trades, no trading on stale data.
- The 10% daily figure is an aspirational target, never a reason to trade or size up.
- Reply in Hinglish, concise. End notes with: "${DISCLAIMER_HI}"`;

export function buildReviewPrompt(sig: AISignal): string {
  const view = {
    symbol: sig.symbol, venue: sig.venue, timeframe: sig.timeframe, htf: sig.htf, side: sig.side,
    entry: sig.entry, stop: sig.stop, target: sig.target, qty: sig.qty, rr_gross: Number(sig.rr.toFixed(2)), rr_net_of_costs: Number(sig.rrNetOfCosts.toFixed(2)),
    planned_risk_inr: sig.plannedRiskPaise / 100, est_fees_inr: sig.estFeesPaise / 100, rationale: sig.rationale, invalidation: sig.invalidation,
    retail_illusion: sig.retailIllusion, area_answers: sig.areaAnswers, data_as_of: new Date(sig.dataAsOf).toISOString(), data_source: sig.dataSource,
    final_check_failed: sig.finalCheck?.failed, final_check_pending_manual: sig.finalCheck?.pendingManual, engine_status: sig.status,
  };
  return `Review this candidate. Data:\n${JSON.stringify(view, null, 2)}`;
}

export interface AiReviewOutput { verdict: 'agree' | 'downgrade' | 'reject'; notes: string; missing_conditions: string[]; retail_illusion_ok: boolean }

export function parseAiReview(text: string): AiReviewOutput | null {
  try {
    const o = JSON.parse(text);
    if (!['agree', 'downgrade', 'reject'].includes(o.verdict) || typeof o.notes !== 'string') return null;
    return { verdict: o.verdict, notes: o.notes.slice(0, 4000), missing_conditions: Array.isArray(o.missing_conditions) ? o.missing_conditions.map(String).slice(0, 20) : [], retail_illusion_ok: !!o.retail_illusion_ok };
  } catch { return null; }
}

/** The AI can only make a signal more conservative. */
export function mergeAiReview(sig: AISignal, out: AiReviewOutput, model: string, now: number): AISignal {
  const review = { model, verdict: out.verdict, notes: out.notes + (out.missing_conditions.length ? `\nMissing: ${out.missing_conditions.join('; ')}` : ''), at: now };
  if (out.verdict === 'agree' && out.retail_illusion_ok) return { ...sig, aiReview: review };
  if (out.verdict === 'reject') return { ...sig, aiReview: review, status: 'REJECTED', confidence: Math.min(sig.confidence, 0.1), rejectionReasons: [...sig.rejectionReasons, `AI_REVIEW: ${out.notes.slice(0, 200)}`] };
  return { ...sig, aiReview: review, status: sig.status === 'VALIDATED' ? 'WATCHLIST' : sig.status, confidence: Math.min(sig.confidence, 0.3), rejectionReasons: [...sig.rejectionReasons, 'AI_REVIEW: downgraded to watchlist'] };
}
