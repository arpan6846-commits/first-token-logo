// Generates base44/entities/*.json from one spec so schemas stay in sync with core/types.ts.
// Security model: financial entities are readable only by the app admin (the owner),
// and NOT writable from the browser at all — every write goes through backend
// functions using the service role, which enforce append-only rules and owner checks.
import { mkdirSync, writeFileSync } from 'node:fs';

const S = (o = {}) => ({ type: 'string', ...o });
const N = (o = {}) => ({ type: 'number', ...o });
const I = (o = {}) => ({ type: 'integer', ...o });
const B = (o = {}) => ({ type: 'boolean', ...o });
const O = (o = {}) => ({ type: 'object', ...o });
const A = (items, o = {}) => ({ type: 'array', items, ...o });
const ENV = S({ enum: ['simulation', 'paper', 'production'] });
const VENUE = S({ enum: ['KITE', 'COINDCX', 'PAPER'] });
const AC = S({ enum: ['EQUITY', 'CRYPTO'] });
const SIDE = S({ enum: ['BUY', 'SELL'] });
const SRC = S({ enum: ['LIVE', 'BROKER', 'PAPER_FEED', 'SIMULATED', 'HISTORICAL', 'ESTIMATE', 'MANUAL'] });
const PAISE = I({ description: 'Integer paise (1 INR = 100 paise)' });
const UID = S({ description: 'Engine id (unique). Base44 assigns its own record id separately.', minLength: 3, maxLength: 80 });

const OWNER_READ_ONLY = { create: false, read: { user_condition: { role: 'admin' } }, update: false, delete: false };

const entities = {
  UserProfile: {
    desc: 'The single owner profile. Compliance checklist ticks, notification preferences.',
    props: { uid: UID, email: S({ format: 'email' }), displayName: S({ maxLength: 80 }), timezone: S({ default: 'Asia/Kolkata' }), notifyEmail: B({ default: true }), complianceTicks: O({ additionalProperties: { type: 'boolean' } }), sandboxOrderTests: O({ additionalProperties: { type: 'boolean' } }), createdAt: I() },
    required: ['uid', 'email'], indexes: ['email (unique)'],
  },
  Portfolio: {
    desc: 'Latest equity view per environment (cache written after every snapshot; ledger is the source of truth).',
    props: { uid: UID, environment: ENV, netEquityPaise: PAISE, cashPaise: PAISE, marketValuePaise: PAISE, unrealizedPaise: PAISE, realizedPaise: PAISE, feesPaise: PAISE, taxReservePaise: PAISE, reinvestedPaise: PAISE, cashByVenue: O(), exposureByClass: O(), marksComplete: B(), markSources: A(S()), asOf: I() },
    required: ['uid', 'environment', 'netEquityPaise', 'asOf'], indexes: ['environment (unique)'],
  },
  Asset: {
    desc: 'Instrument metadata loaded from the broker/exchange (tick, lot, min size).',
    props: { uid: UID, symbol: S({ maxLength: 40 }), venue: VENUE, assetClass: AC, exchange: S({ enum: ['NSE', 'BSE', 'COINDCX', 'PAPER'] }), tickSize: N({ exclusiveMinimum: 0 }), lotSize: I({ minimum: 1 }), minQty: N({ minimum: 0 }), qtyDecimals: I({ minimum: 0, maximum: 12 }), minNotionalPaise: PAISE, sector: S(), instrumentToken: I(), fnoEligible: B(), source: SRC, loadedAt: I() },
    required: ['uid', 'symbol', 'venue', 'assetClass', 'tickSize', 'lotSize'], indexes: ['venue+symbol (unique)', 'sector'],
  },
  MarketData: {
    desc: 'Latest quote and recent closed candles per symbol/timeframe, written by the worker. Always carries its source and exchange timestamp.',
    props: { uid: UID, venue: VENUE, symbol: S(), timeframe: S({ enum: ['quote', '5m', '15m', '1h', '4h', '1d', '1w', '1M'] }), quote: O(), candles: A(O(), { maxItems: 600 }), source: SRC, exchangeTs: I(), receivedAt: I() },
    required: ['uid', 'venue', 'symbol', 'timeframe', 'source'], indexes: ['venue+symbol+timeframe (unique)', 'receivedAt'],
  },
  AI_Signals: {
    desc: 'Every signal, decision and rejection with its rationale and Final Check.',
    props: { uid: UID, environment: ENV, symbol: S(), venue: VENUE, assetClass: AC, side: SIDE, timeframe: S(), htf: S(), entry: N(), stop: N(), target: N(), qty: N({ minimum: 0 }), rr: N(), rrNetOfCosts: N(), plannedRiskPaise: PAISE, estFeesPaise: PAISE, estSlippagePaise: PAISE, rationale: A(S()), invalidation: A(S()), retailIllusion: S(), areaAnswers: O(), setupType: S(), confidence: N({ minimum: 0, maximum: 1 }), status: S({ enum: ['CANDIDATE', 'REJECTED', 'VALIDATED', 'WATCHLIST', 'APPROVED', 'EXECUTED', 'EXPIRED'] }), rejectionReasons: A(S()), dataAsOf: I(), dataSource: SRC, finalCheck: O(), aiReview: O(), createdAt: I(), sector: S(), isRangeTrade: B(), ownerApprovedAt: I(), armedAt: I(), triggerExpiresAt: I(), orderId: S(), expiryReason: S() },
    required: ['uid', 'environment', 'symbol', 'venue', 'status', 'createdAt'], indexes: ['environment+status', 'environment+symbol+createdAt', 'createdAt'],
  },
  TradeOrders: {
    desc: 'Orders. idempotencyKey and clientOrderId are unique per environment; brokerOrderId only from venue acknowledgement.',
    props: { uid: UID, environment: ENV, venue: VENUE, symbol: S(), assetClass: AC, side: SIDE, orderType: S({ enum: ['LIMIT', 'MARKET', 'SL', 'SL-M'] }), product: S({ enum: ['CNC', 'SPOT'] }), qty: N({ exclusiveMinimum: 0 }), limitPrice: N(), triggerPrice: N(), stopPrice: N(), targetPrice: N(), idempotencyKey: S({ maxLength: 200 }), clientOrderId: S({ maxLength: 20 }), brokerOrderId: S(), status: S({ enum: ['PROPOSED', 'RISK_REJECTED', 'APPROVED', 'AWAITING_OWNER', 'SUBMITTING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'UNKNOWN'] }), filledQty: N({ minimum: 0 }), avgFillPrice: N(), feesPaise: PAISE, signalId: S(), rejectionReason: S({ maxLength: 4000 }), createdAt: I(), updatedAt: I(), submittedAt: I(), ownerConfirmedAt: I(), createdBy: S({ enum: ['owner', 'system', 'ai', 'worker', 'broker'] }), isRangeTrade: B(), sector: S(), plannedRiskPaise: PAISE, parentOrderId: S(), exitReason: S({ enum: ['STOP', 'TARGET', 'INVALIDATION', 'MANUAL', 'KILL_SWITCH'] }), timeframe: S() },
    required: ['uid', 'environment', 'venue', 'symbol', 'side', 'qty', 'idempotencyKey', 'clientOrderId', 'status', 'createdAt'],
    indexes: ['environment+idempotencyKey (unique)', 'environment+venue+clientOrderId (unique)', 'environment+brokerOrderId', 'environment+status'],
  },
  TradeFills: {
    desc: 'Venue-reported executions. venueTradeId unique per venue+environment. Only `reconciled` may change after insert.',
    props: { uid: UID, environment: ENV, orderId: S(), venue: VENUE, venueTradeId: S(), symbol: S(), assetClass: AC, side: SIDE, qty: N({ exclusiveMinimum: 0 }), price: N({ exclusiveMinimum: 0 }), feesPaise: PAISE, feesSource: S({ enum: ['BROKER', 'ESTIMATE'] }), tdsPaise: PAISE, ts: I(), source: SRC, reconciled: B(), settlementDate: S({ format: 'date' }), realizedPnlPaise: PAISE, costBasisPaise: PAISE },
    required: ['uid', 'environment', 'orderId', 'venue', 'venueTradeId', 'side', 'qty', 'price', 'ts', 'source', 'settlementDate'],
    indexes: ['environment+venue+venueTradeId (unique)', 'environment+orderId', 'environment+ts'],
  },
  LedgerEntries: {
    desc: 'Immutable double-entry ledger with per-environment SHA-256 hash chain. Never updated or deleted.',
    props: { uid: UID, environment: ENV, seq: I({ minimum: 1 }), ts: I(), type: S({ enum: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'BUY_FILL', 'SELL_FILL', 'FEE_ADJUSTMENT', 'TAX_PROVISION', 'TAX_RELEASE', 'COMPOUNDING', 'RECONCILIATION_ADJUSTMENT', 'OPENING_BALANCE'] }), memo: S({ maxLength: 1000 }), lines: A(O({ properties: { account: S(), amountPaise: PAISE }, required: ['account', 'amountPaise'] }), { minItems: 2 }), refType: S(), refId: S(), idempotencyKey: S(), source: SRC, prevHash: S({ pattern: '^[0-9a-f]{64}$' }), hash: S({ pattern: '^[0-9a-f]{64}$' }) },
    required: ['uid', 'environment', 'seq', 'ts', 'type', 'lines', 'idempotencyKey', 'source', 'prevHash', 'hash'],
    indexes: ['environment+seq (unique)', 'environment+idempotencyKey (unique)'],
  },
  DailySnapshots: {
    desc: 'End-of-day equity snapshot per environment and IST date.',
    props: { uid: UID, environment: ENV, date: S({ format: 'date' }), cashPaise: PAISE, investedCostPaise: PAISE, marketValuePaise: PAISE, unrealizedPnlPaise: PAISE, realizedPnlDayPaise: PAISE, realizedPnlCumPaise: PAISE, feesDayPaise: PAISE, feesCumPaise: PAISE, taxReservePaise: PAISE, tdsReceivablePaise: PAISE, netEquityPaise: PAISE, netContributionsPaise: PAISE, dayReturnPct: N(), cumReturnPct: N(), drawdownPct: N(), peakEquityPaise: PAISE, targetProgressPct: N({ description: 'Informational progress vs the ASPIRATIONAL daily target. Not a forecast, not a guarantee.' }), pricesSource: SRC, createdAt: I() },
    required: ['uid', 'environment', 'date', 'netEquityPaise'], indexes: ['environment+date (unique)'],
  },
  RiskEvents: {
    desc: 'Append-only risk decisions, blocks and halts.',
    props: { uid: UID, environment: ENV, ts: I(), code: S(), severity: S({ enum: ['INFO', 'WARN', 'BLOCK', 'HALT'] }), message: S({ maxLength: 2000 }), orderId: S(), signalId: S(), data: O() },
    required: ['uid', 'environment', 'ts', 'code', 'severity'], indexes: ['environment+ts', 'severity'],
  },
  AutomationLogs: {
    desc: 'Append-only job log. runKey makes every scheduled job idempotent.',
    props: { uid: UID, environment: ENV, ts: I(), job: S(), runKey: S(), status: S({ enum: ['STARTED', 'SUCCESS', 'SKIPPED', 'FAILED'] }), message: S({ maxLength: 4000 }), actor: S(), data: O() },
    required: ['uid', 'environment', 'ts', 'job', 'runKey', 'status'], indexes: ['environment+runKey', 'ts'],
  },
  APIConnections: {
    desc: 'Venue connection state. The encrypted session field is never readable from the browser (FLS).',
    props: { uid: UID, venue: VENUE, environment: ENV, status: S({ enum: ['NOT_CONFIGURED', 'CREDENTIALS_PRESENT', 'AUTHENTICATED', 'TESTED_READ_ONLY', 'TESTED_ORDERS_SANDBOX', 'EXPIRED', 'ERROR', 'REVOKED'] }), permissions: O({ properties: { read: B(), trade: B(), withdraw: B() } }), sessionExpiresAt: I(), lastHealthCheckAt: I(), lastHealthOk: B(), lastError: S({ maxLength: 1000 }), capabilitiesVerifiedAt: I(), capabilityNotes: S({ maxLength: 4000 }), feedHealthy: B(), lastFeedTickAt: I(),
      encryptedSession: S({ description: 'AES-GCM ciphertext of the venue session token', rls: { read: false, write: false } }), loginStateHash: S({ rls: { read: false, write: false } }) },
    required: ['uid', 'venue', 'environment', 'status'], indexes: ['environment+venue (unique)'],
  },
  StrategySettings: {
    desc: 'Risk and strategy settings per environment. Changed only by the owner via ownerCommand with typed confirmation.',
    props: { uid: UID, version: I({ minimum: 1 }), environment: ENV, initialCapitalPaise: PAISE, allocation: O(), maxRiskPerTradePct: N({ minimum: 0.01, maximum: 1 }), dailyLossStopPct: N({ minimum: 0.1, maximum: 2 }), weeklyLossStopPct: N({ maximum: 5 }), maxOpenExposurePct: N({ maximum: 100 }), dailyRiskBudgetPct: N({ maximum: 1 }), minRewardRisk: N({ minimum: 1 }), maxFeeToRiskPct: N(), maxQuoteAgeMs: I(), maxCandleLagMultiple: N(), maxReconciliationAgeMs: I(), reinvestPct: N({ minimum: 0, maximum: 100 }), dailyTargetPct: N({ description: 'ASPIRATIONAL ONLY — never used for sizing or risk' }), maxTradesPerSector: I({ maximum: 3 }), maxRangeTradePct: N({ maximum: 20 }), equityPriceMin: N(), equityPriceMax: N(), minTimeframe: S(), stockTimeframe: S(), cryptoTimeframe: S(), executionMode: S({ enum: ['manual_approval', 'auto'] }), liveTradingEnabled: B(), firstLiveOrderConfirmedAt: I(), phase: I({ minimum: 1, maximum: 5 }), taxRates: O(), consecutiveLossCooldown: I(), updatedAt: I(), updatedBy: S(), confirmedByOwnerAt: I() },
    required: ['uid', 'environment', 'version'], indexes: ['environment (unique)'],
  },
  ReconciliationRecords: {
    desc: 'Append-only reconciliation results against venue balances, holdings and trades.',
    props: { uid: UID, environment: ENV, venue: VENUE, ts: I(), kind: S(), status: S({ enum: ['MATCHED', 'MISMATCH', 'ERROR'] }), diffs: A(O()), importedFillIds: A(S()), message: S({ maxLength: 4000 }) },
    required: ['uid', 'environment', 'venue', 'ts', 'status'], indexes: ['environment+venue+ts'],
  },
  CompoundingEvents: {
    desc: 'Append-only compounding decisions (one per environment per date).',
    props: { uid: UID, environment: ENV, date: S({ format: 'date' }), cumEligibleNetPaise: PAISE, previousHighWaterPaise: PAISE, newProfitPaise: PAISE, reinvestPct: N(), reinvestedPaise: PAISE, toReservePaise: PAISE, byVenue: O(), ledgerEntryId: S(), status: S({ enum: ['COMPOUNDED', 'NOTHING_ELIGIBLE'] }), note: S(), createdAt: I() },
    required: ['uid', 'environment', 'date', 'status'], indexes: ['environment+date (unique)'],
  },
  JournalEntries: {
    desc: 'Prop-desk written pre-trade/post-trade analysis, stock profile and psychology notes.',
    props: { uid: UID, environment: ENV, kind: S({ enum: ['PRE_TRADE', 'POST_TRADE', 'PROFILE', 'PSYCHOLOGY'] }), ts: I(), symbol: S(), signalId: S(), orderId: S(), sectorWhy: S({ maxLength: 4000 }), stockWhy: S({ maxLength: 4000 }), positionWhy: S({ maxLength: 4000 }), againstMePlan: S({ maxLength: 4000 }), whatHappened: S({ maxLength: 8000 }), rulesFollowed: A(S()), rulesBroken: A(S()), profileScenario: O(), notes: S({ maxLength: 8000 }), outcome: S({ enum: ['WIN', 'LOSS', 'SCRATCH'] }) },
    required: ['uid', 'environment', 'kind', 'ts'], indexes: ['environment+signalId', 'environment+orderId'],
  },
  AuditLogs: {
    desc: 'Append-only, hash-chained audit trail of every owner, system and AI action.',
    props: { uid: UID, ts: I(), actor: S(), action: S(), environment: S(), details: O(), prevHash: S({ pattern: '^[0-9a-f]{64}$' }), hash: S({ pattern: '^[0-9a-f]{64}$' }) },
    required: ['uid', 'ts', 'actor', 'action', 'prevHash', 'hash'], indexes: ['ts'],
  },
  SystemState: {
    desc: 'Kill switch, halt latches, reconciliation status, compounding high-water marks, worker heartbeat.',
    props: { uid: UID, killSwitch: O(), haltedUntil: O(), lastReconciliation: O(), compoundingHighWater: O(), lastCompoundingDate: O(), pendingSettings: O(), workerHeartbeatAt: I(), workerVersion: S() },
    required: ['uid', 'killSwitch'], indexes: ['uid (unique, single row "system")'],
  },
  Commands: {
    desc: 'Owner intents (signed by ownerCommand) executed by the worker, the single writer.',
    props: { uid: UID, type: S(), environment: ENV, payload: O(), requestedBy: S(), requestedAt: I(), signature: S({ pattern: '^[0-9a-f]{64}$', rls: { read: false, write: false } }), status: S({ enum: ['PENDING', 'RUNNING', 'DONE', 'FAILED'] }), result: O(), finishedAt: I() },
    required: ['uid', 'type', 'environment', 'requestedAt', 'status'], indexes: ['status+requestedAt'],
  },
};

mkdirSync('base44/entities', { recursive: true });
for (const [name, e] of Object.entries(entities)) {
  const schema = {
    name, type: 'object', title: name,
    description: `${e.desc} Indexes (enforced by the engine/worker as single writer): ${e.indexes.join('; ')}.`,
    properties: e.props, required: e.required, additionalProperties: false, rls: OWNER_READ_ONLY,
  };
  writeFileSync(`base44/entities/${name}.json`, JSON.stringify(schema, null, 2) + '\n');
}
console.log(`wrote ${Object.keys(entities).length} entity schemas`);
