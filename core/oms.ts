// Order management system.
// Invariants:
//  - Same idempotency key ⇒ same order. A retried request never creates a
//    second order (DB unique index + lookup + venue-side client order id).
//  - An order is OPEN only after the venue returns an order id.
//  - A timeout during submission ⇒ UNKNOWN; it is resolved by looking the
//    order up by client order id at the venue, never by re-sending it.
//  - Holdings and cash change only from venue-reported fills, deduplicated by
//    venue trade id, and each fill posts exactly one ledger entry.
//  - An environment can only use an adapter of the matching mode.

import { adapterAllowedFor, AdapterError, type VenueAdapter, type VenueOrderState, type VenueTrade } from './adapters/types.ts';
import { estimateFees } from './fees.ts';
import { newId, sha256Hex } from './hash.ts';
import { Accounts, lines, type Ledger } from './ledger.ts';
import { settlementDate, type MarketCalendar, NSE_CALENDAR } from './marketHours.ts';
import { notionalPaise } from './money.ts';
import { buildPositions, consumeFifo, posKey } from './portfolio.ts';
import type { Repo } from './repo.ts';
import { evaluateOrder, type OrderProposal, type RiskContext, type RiskDecision } from './risk.ts';
import type { Actor, DataSource, Environment, OrderStatus, RiskEvent, TradeFill, TradeOrder, Venue } from './types.ts';
import { TERMINAL_STATUSES } from './types.ts';

export interface SubmitOptions {
  actor: Actor;
  ownerConfirmed?: boolean;          // owner pressed "Confirm & send" for this order
  firstLiveOrderConfirmation?: string; // typed phrase required once before the first live order
  parentOrderId?: string;
  exitReason?: TradeOrder['exitReason'];
  /** Set only by the engine when triggering a signal the owner explicitly approved (armed) earlier. */
  ownerPreApprovedAt?: number;
}

export interface SubmitResult { order: TradeOrder; decision?: RiskDecision; duplicate: boolean }

export const FIRST_LIVE_ORDER_PHRASE = 'I UNDERSTAND THIS IS A REAL-MONEY ORDER';

export function clientOrderIdFor(env: Environment, idempotencyKey: string): string {
  // Kite `tag` allows up to 20 alphanumeric chars; CoinDCX client_order_id is longer. Use 20 for both.
  return `WE${env[0].toUpperCase()}${sha256Hex(`${env}:${idempotencyKey}`).slice(0, 17)}`;
}

export class OrderManager {
  constructor(
    private env: Environment,
    private repo: Repo,
    private ledger: Ledger,
    private adapters: Partial<Record<Venue, VenueAdapter>>,
    private clock: () => number = Date.now,
    private calendar: MarketCalendar = NSE_CALENDAR,
  ) {
    for (const [v, a] of Object.entries(adapters)) {
      if (a && !adapterAllowedFor(env, a.mode)) throw new Error(`Environment ${env} cannot use a ${a.mode} adapter for ${v}`);
    }
  }

  private get source(): DataSource {
    return this.env === 'production' ? 'BROKER' : this.env === 'paper' ? 'PAPER_FEED' : 'SIMULATED';
  }

  adapter(v: Venue): VenueAdapter {
    const a = this.adapters[v];
    if (!a) throw new AdapterError('UNAVAILABLE', `No ${v} adapter configured for ${this.env}`);
    return a;
  }

  async findByIdempotencyKey(key: string): Promise<TradeOrder | undefined> {
    return (await this.repo.orders.list({ environment: this.env, idempotencyKey: key } as Partial<TradeOrder>))[0];
  }

  async submit(p: OrderProposal, ctx: RiskContext, opts: SubmitOptions): Promise<SubmitResult> {
    if (p.environment !== this.env) throw new Error(`Order for ${p.environment} sent to ${this.env} OMS`);
    if (opts.actor === 'ai') throw new Error('The AI layer cannot submit orders; it can only propose signals');
    const existing = await this.findByIdempotencyKey(p.idempotencyKey);
    if (existing) return { order: existing, duplicate: true };

    const decision = evaluateOrder(p, { ...ctx, orders: ctx.orders.filter((o) => o.idempotencyKey !== p.idempotencyKey) });
    const now = this.clock();
    let order: TradeOrder = {
      id: newId('ord', now), environment: this.env, venue: p.venue, symbol: p.symbol, assetClass: p.assetClass, side: p.side,
      orderType: p.orderType, product: p.product, qty: p.qty, limitPrice: p.limitPrice, triggerPrice: p.triggerPrice,
      stopPrice: p.stopPrice, targetPrice: p.targetPrice, idempotencyKey: p.idempotencyKey,
      clientOrderId: clientOrderIdFor(this.env, p.idempotencyKey), status: 'PROPOSED', filledQty: 0, feesPaise: 0,
      signalId: p.signalId, createdAt: now, updatedAt: now, createdBy: opts.actor, isRangeTrade: p.isRangeTrade,
      sector: p.sector, plannedRiskPaise: decision.plannedRiskPaise, parentOrderId: opts.parentOrderId, exitReason: opts.exitReason,
      timeframe: p.timeframe,
    };
    try {
      order = await this.repo.orders.insert(order);
    } catch (e) {
      // Concurrent duplicate lost the race on the unique index: return the winner.
      const winner = await this.findByIdempotencyKey(p.idempotencyKey);
      if (winner) return { order: winner, duplicate: true };
      throw e;
    }

    if (!decision.approved) {
      order = await this.setStatus(order, 'RISK_REJECTED', { rejectionReason: decision.failures.map((f) => `${f.code}: ${f.message}`).join(' | ') });
      for (const f of decision.failures) await this.riskEvent(f.code, f.code === 'KILL_SWITCH' || f.code.includes('LOSS_STOP') ? 'HALT' : 'BLOCK', f.message, order.id, p.signalId);
      return { order, decision, duplicate: false };
    }

    if (this.env === 'production') {
      const s = ctx.settings;
      const needsFirst = !s.firstLiveOrderConfirmedAt;
      if (needsFirst && opts.firstLiveOrderConfirmation !== FIRST_LIVE_ORDER_PHRASE) {
        order = await this.setStatus(order, 'AWAITING_OWNER', { rejectionReason: 'First live order requires explicit owner confirmation' });
        return { order, decision, duplicate: false };
      }
      // Stop/target exits of an entry the owner already confirmed carry that approval
      // (the plan was approved with its stop and target); they must never wait for a click.
      const parent = opts.parentOrderId ? await this.repo.orders.get(opts.parentOrderId) : undefined;
      const preApprovedExit = p.side === 'SELL' && !!parent?.ownerConfirmedAt && (opts.exitReason === 'STOP' || opts.exitReason === 'TARGET');
      const ownerOk = (opts.ownerConfirmed && opts.actor === 'owner') || (opts.ownerPreApprovedAt !== undefined && !needsFirst);
      if (!preApprovedExit && (s.executionMode === 'manual_approval' || needsFirst) && !ownerOk) {
        order = await this.setStatus(order, 'AWAITING_OWNER');
        return { order, decision, duplicate: false };
      }
      order = await this.repo.orders.update(order.id, { ownerConfirmedAt: opts.ownerConfirmed && opts.actor === 'owner' ? now : opts.ownerPreApprovedAt });
    }
    order = await this.setStatus(order, 'APPROVED');
    return { order: await this.place(order), decision, duplicate: false };
  }

  /** Owner confirms an AWAITING_OWNER order. Risk is re-evaluated with fresh context. */
  async confirmAwaiting(orderId: string, ctx: RiskContext, opts: SubmitOptions): Promise<SubmitResult> {
    let order = await this.repo.orders.get(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'AWAITING_OWNER') return { order, duplicate: true };
    if (opts.actor !== 'owner' || !opts.ownerConfirmed) throw new Error('Only the owner can confirm a live order');
    if (!ctx.settings.firstLiveOrderConfirmedAt && opts.firstLiveOrderConfirmation !== FIRST_LIVE_ORDER_PHRASE) {
      throw new Error(`First live order: type "${FIRST_LIVE_ORDER_PHRASE}"`);
    }
    const p: OrderProposal = {
      environment: order.environment, venue: order.venue, symbol: order.symbol, assetClass: order.assetClass, side: order.side,
      qty: order.qty, orderType: order.orderType, product: order.product, limitPrice: order.limitPrice, stopPrice: order.stopPrice,
      targetPrice: order.targetPrice, idempotencyKey: order.idempotencyKey, signalId: order.signalId, sector: order.sector,
      isRangeTrade: order.isRangeTrade, timeframe: order.timeframe, protectiveExit: order.side === 'SELL' && order.exitReason === 'STOP',
    };
    const decision = evaluateOrder(p, { ...ctx, orders: ctx.orders.filter((o) => o.id !== order!.id) });
    if (!decision.approved) {
      order = await this.setStatus(order, 'RISK_REJECTED', { rejectionReason: decision.failures.map((f) => `${f.code}: ${f.message}`).join(' | ') });
      return { order, decision, duplicate: false };
    }
    order = await this.repo.orders.update(order.id, { ownerConfirmedAt: this.clock() });
    order = await this.setStatus(order, 'APPROVED');
    return { order: await this.place(order), decision, duplicate: false };
  }

  private async place(order: TradeOrder): Promise<TradeOrder> {
    if (order.status !== 'APPROVED') throw new Error(`Refusing to place order in status ${order.status}`);
    const kill = (await this.repo.system.get('system'))?.killSwitch;
    if (kill?.active && !(order.side === 'SELL' && order.exitReason === 'STOP')) return this.setStatus(order, 'RISK_REJECTED', { rejectionReason: 'KILL_SWITCH activated before submission' });
    const a = this.adapter(order.venue);
    order = await this.setStatus(order, 'SUBMITTING', { submittedAt: this.clock() });
    try {
      const ack = await a.placeOrder({
        symbol: order.symbol, exchange: order.assetClass === 'EQUITY' ? 'NSE' : 'COINDCX', side: order.side, qty: order.qty,
        orderType: order.orderType, product: order.product, limitPrice: order.limitPrice, triggerPrice: order.triggerPrice,
        clientOrderId: order.clientOrderId,
      });
      if (!ack.brokerOrderId) throw new AdapterError('INVALID', 'Venue response had no order id');
      order = await this.repo.orders.update(order.id, { brokerOrderId: ack.brokerOrderId, status: 'OPEN', updatedAt: this.clock() });
      return this.sync(order);
    } catch (e) {
      if (e instanceof AdapterError && e.outcomeUnknown) {
        order = await this.setStatus(order, 'UNKNOWN', { rejectionReason: `Submission outcome unknown: ${e.message}` });
        await this.riskEvent('ORDER_OUTCOME_UNKNOWN', 'WARN', `${order.symbol} ${order.side}: ${e.message}. Will resolve by client order id; no blind retry.`, order.id);
        return this.resolveUnknown(order);
      }
      const reason = e instanceof Error ? e.message : String(e);
      return this.setStatus(order, 'REJECTED', { rejectionReason: `Venue: ${reason}` });
    }
  }

  /** Looks the order up at the venue by client order id. */
  async resolveUnknown(order: TradeOrder): Promise<TradeOrder> {
    const a = this.adapter(order.venue);
    try {
      const st = await a.findOrderByClientId(order.clientOrderId);
      if (!st) {
        // The venue has no record. Leave UNKNOWN until a later lookup or the
        // end-of-day reconciliation confirms it; then the owner may resubmit.
        return order;
      }
      order = await this.repo.orders.update(order.id, { brokerOrderId: st.brokerOrderId, status: 'OPEN', updatedAt: this.clock() });
      return this.applyVenueState(order, st);
    } catch {
      return order;
    }
  }

  /** Marks UNKNOWN orders that the venue confirms it never received as REJECTED (after reconciliation). */
  async markNeverReceived(orderId: string, reconciliationId: string): Promise<TradeOrder> {
    const o = await this.repo.orders.get(orderId);
    if (!o || o.status !== 'UNKNOWN') throw new Error('Only UNKNOWN orders can be closed this way');
    return this.setStatus(o, 'REJECTED', { rejectionReason: `Venue has no record (reconciliation ${reconciliationId})` });
  }

  async sync(order: TradeOrder): Promise<TradeOrder> {
    if (TERMINAL_STATUSES.includes(order.status) && order.status !== 'CANCELLED') return order;
    if (order.status === 'UNKNOWN') return this.resolveUnknown(order);
    if (!order.brokerOrderId) return order;
    const st = await this.adapter(order.venue).getOrder(order.brokerOrderId);
    return this.applyVenueState(order, st);
  }

  async syncAllOpen(): Promise<TradeOrder[]> {
    const open = (await this.repo.orders.list({ environment: this.env } as Partial<TradeOrder>)).filter((o) => ['OPEN', 'PARTIALLY_FILLED', 'SUBMITTING', 'UNKNOWN'].includes(o.status));
    const out: TradeOrder[] = [];
    for (const o of open) out.push(await this.sync(o));
    return out;
  }

  async applyVenueState(order: TradeOrder, st: VenueOrderState): Promise<TradeOrder> {
    for (const t of st.trades) await this.recordFill(order, t);
    const fills = await this.repo.fills.list({ environment: this.env, orderId: order.id } as Partial<TradeFill>);
    const filledQty = round8(fills.reduce((s, f) => s + f.qty, 0));
    const avg = filledQty > 0 ? fills.reduce((s, f) => s + f.qty * f.price, 0) / filledQty : undefined;
    const fees = fills.reduce((s, f) => s + f.feesPaise, 0);
    let status: OrderStatus = order.status;
    if (st.status === 'REJECTED') status = filledQty > 0 ? 'CANCELLED' : 'REJECTED';
    else if (st.status === 'CANCELLED') status = 'CANCELLED';
    else if (st.status === 'EXPIRED') status = 'EXPIRED';
    else if (filledQty >= order.qty - 1e-9) status = 'FILLED';
    else if (filledQty > 0) status = 'PARTIALLY_FILLED';
    else status = 'OPEN';
    return this.repo.orders.update(order.id, {
      status, filledQty, avgFillPrice: avg, feesPaise: fees, updatedAt: this.clock(),
      rejectionReason: st.rejectionReason ?? order.rejectionReason,
    });
  }

  /** Records one venue trade exactly once and posts its ledger entry. */
  async recordFill(order: TradeOrder, t: VenueTrade, opts: { reconciled?: boolean } = {}): Promise<TradeFill | undefined> {
    const dup = await this.repo.fills.list({ environment: this.env, venue: order.venue, venueTradeId: t.venueTradeId } as Partial<TradeFill>);
    if (dup.length) return undefined;
    if (t.side !== order.side) throw new Error(`Trade ${t.venueTradeId} side ${t.side} does not match order ${order.side}`);
    if (!(t.qty > 0 && t.price > 0)) throw new Error(`Trade ${t.venueTradeId} has invalid qty/price`);
    const prior = await this.repo.fills.list({ environment: this.env, orderId: order.id } as Partial<TradeFill>);
    if (prior.reduce((s, f) => s + f.qty, 0) + t.qty > order.qty + 1e-9) throw new Error(`Trade ${t.venueTradeId} overfills order ${order.id}`);

    const est = estimateFees(order.assetClass, t.side, t.qty, t.price);
    const fees = t.feesPaise ?? est.totalPaise;
    const tds = t.tdsPaise ?? est.tdsPaise;
    const value = notionalPaise(t.qty, t.price);
    const v = order.venue;
    let realized: number | undefined, costBasis: number | undefined;
    const ledgerKey = `fill:${v}:${t.venueTradeId}`;

    if (t.side === 'BUY') {
      await this.ledger.post({
        environment: this.env, type: 'BUY_FILL', idempotencyKey: ledgerKey, source: this.source, refType: 'TradeFill', refId: t.venueTradeId, ts: t.ts,
        memo: `BUY ${t.qty} ${t.symbol} @ ${t.price}`,
        lines: lines([Accounts.holdings(v, t.symbol), value], [Accounts.fees(v), fees], [Accounts.cash(v), -(value + fees)]),
      });
    } else {
      const allFills = await this.repo.fills.list({ environment: this.env } as Partial<TradeFill>);
      const pos = buildPositions(allFills).get(posKey(v, t.symbol));
      const { costPaise } = consumeFifo(pos?.lots ?? [], t.qty);
      costBasis = costPaise;
      realized = value - costPaise;
      await this.ledger.post({
        environment: this.env, type: 'SELL_FILL', idempotencyKey: ledgerKey, source: this.source, refType: 'TradeFill', refId: t.venueTradeId, ts: t.ts,
        memo: `SELL ${t.qty} ${t.symbol} @ ${t.price} (realized ${realized / 100})`,
        lines: lines(
          [Accounts.cash(v), value - fees - tds], [Accounts.fees(v), fees], [Accounts.tdsReceivable, tds],
          [Accounts.holdings(v, t.symbol), -costPaise], [Accounts.realized(v), -realized],
        ),
      });
    }
    const fill: TradeFill = {
      id: newId('fil', t.ts), environment: this.env, orderId: order.id, venue: v, venueTradeId: t.venueTradeId, symbol: t.symbol,
      assetClass: order.assetClass, side: t.side, qty: t.qty, price: t.price, feesPaise: fees, feesSource: t.feesPaise !== undefined && this.env === 'production' ? 'BROKER' : 'ESTIMATE',
      tdsPaise: tds, ts: t.ts, source: this.source, reconciled: opts.reconciled ?? this.env !== 'production',
      settlementDate: settlementDate(order.assetClass, t.ts, this.calendar), realizedPnlPaise: realized, costBasisPaise: costBasis,
    };
    try { return await this.repo.fills.insert(fill); } catch { return undefined; }
  }

  async cancel(orderId: string, actor: Actor): Promise<TradeOrder> {
    const o = await this.repo.orders.get(orderId);
    if (!o) throw new Error('Order not found');
    if (o.status === 'AWAITING_OWNER' || o.status === 'APPROVED' || o.status === 'PROPOSED') return this.setStatus(o, 'CANCELLED', { rejectionReason: `Cancelled by ${actor} before submission` });
    if (!o.brokerOrderId || !['OPEN', 'PARTIALLY_FILLED'].includes(o.status)) return o;
    await this.adapter(o.venue).cancelOrder(o.brokerOrderId);
    return this.sync(o);
  }

  async cancelAllOpen(actor: Actor): Promise<number> {
    const open = (await this.repo.orders.list({ environment: this.env } as Partial<TradeOrder>)).filter((o) => ['OPEN', 'PARTIALLY_FILLED', 'AWAITING_OWNER', 'APPROVED'].includes(o.status));
    let n = 0;
    for (const o of open) { try { await this.cancel(o.id, actor); n++; } catch { /* reported by reconciliation */ } }
    return n;
  }

  private async setStatus(o: TradeOrder, status: OrderStatus, extra: Partial<TradeOrder> = {}): Promise<TradeOrder> {
    return this.repo.orders.update(o.id, { ...extra, status, updatedAt: this.clock() });
  }

  private async riskEvent(code: string, severity: RiskEvent['severity'], message: string, orderId?: string, signalId?: string) {
    await this.repo.riskEvents.insert({ id: newId('rsk'), environment: this.env, ts: this.clock(), code, severity, message, orderId, signalId });
  }
}

function round8(x: number) { return Math.round(x * 1e8) / 1e8; }
