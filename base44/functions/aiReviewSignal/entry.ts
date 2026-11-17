// Optional Claude review of a deterministic signal. The model only sees numbers
// the engine computed from real data, and may only agree / downgrade / reject.
// Its verdict is queued as APPLY_AI_REVIEW; the worker applies mergeAiReview(),
// which can never raise confidence, change prices/qty, or touch risk/permissions.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.62';
import Anthropic from 'npm:@anthropic-ai/sdk@1.9.0';
import { AI_REVIEW_SCHEMA, AI_REVIEW_SYSTEM, buildReviewPrompt, parseAiReview } from '../../shared/core/aiReview.ts';
import { newId } from '../../shared/core/hash.ts';
import { createBase44Repo } from '../../shared/base44Repo.ts';
import { errorResponse, HttpError, json, requireOwner, secret, signCommand } from '../../shared/security.ts';

const MODEL = 'claude-opus-5-5';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const owner = await requireOwner(base44);
    const { signalId } = await req.json();
    const repo = createBase44Repo(base44.asServiceRole.entities);
    const sig = await repo.signals.get(String(signalId));
    if (!sig) throw new HttpError(404, 'signal not found');

    const client = new Anthropic({ apiKey: secret('ANTHROPIC_API_KEY') });
    // Server-side refusal fallback enabled ("default" routing); see Anthropic docs.
    // deno-lint-ignore no-explicit-any
    const resp: any = await (client.beta.messages.create as any)({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: AI_REVIEW_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_REVIEW_SCHEMA } },
      messages: [{ role: 'user', content: buildReviewPrompt(sig) }],
    });
    let out = resp.stop_reason === 'refusal' ? null : parseAiReview(resp.content?.find((b: { type: string }) => b.type === 'text')?.text ?? '');
    if (!out) out = { verdict: 'downgrade', notes: 'AI review unavailable or unparseable — treated as a downgrade (conservative).', missing_conditions: [], retail_illusion_ok: false };

    const cmd = { uid: newId('cmd'), type: 'APPLY_AI_REVIEW', environment: sig.environment, payload: { signalId: sig.id, review: out, model: resp.model ?? MODEL }, requestedBy: owner.email, requestedAt: Date.now() };
    await base44.asServiceRole.entities.Commands.create({ ...cmd, signature: signCommand(cmd), status: 'PENDING' });
    return json({ review: out, commandId: cmd.uid });
  } catch (e) {
    if (e instanceof Anthropic.APIError) return json({ error: `AI service error ${e.status}` }, 502);
    return errorResponse(e);
  }
});
