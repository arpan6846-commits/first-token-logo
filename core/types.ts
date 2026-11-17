// Domain model for Wealth Engine AI. These shapes mirror the Base44 entity
// schemas in /base44/entities. Money fields ending in `Paise` are integer paise.

import type { Paise } from './money.ts';

/**
 * Environments are hard-separated books. A simulation or paper fill can never
 * post into the production ledger (enforced in Ledger.post and OrderManager).
 */
export type Environment = 'simulation' | 'paper' | 'production';
export type Venue = 'KITE' | 'COINDCX' | 'PAPER';
export type AssetClass = 'EQUITY' | 'CRYPTO';
export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'SL' | 'SL-M';
export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d' | '1w' | '1M';
export type Actor = 'owner' | 'system' | 'ai' | 'worker' | 'broker';

/** Where a number came from. The UI labels every value with its provenance. */
export type DataSource = 'LIVE' | 'BROKER' | 'PAPER_FEED' | 'SIMULATED' | 'HISTORICAL' | 'ESTIMATE' | 'MANUAL';

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080, '1M': 43200,
};

export interface Instrument {
  symbol: string;              // e.g. 'INFY' or 'BTCINR'
  venue: Venue;
  assetClass: AssetClass;
  exchange: 'NSE' | 'BSE' | 'COINDCX' | 'PAPER';
  tickSize: number;
  lotSize: number;             // 1 for cash equity
  minQty: number;
  qtyDecimals: number;         // 0 for equity
  minNotionalPaise: Paise;     // exchange minimum order value
  sector?: string;
  instrumentToken?: number;    // Kite instrument token
  fnoEligible?: boolean;
}

export interface Quote {
  symbol: string;
  venue: Venue;
  ltp: number;
  bid?: number;
  ask?: number;
  volume?: number;
  exchangeTs: number;          // ms epoch, timestamp from exchange/broker
  receivedAt: number;          // ms epoch, when we received it
  source: DataSource;
}

export interface Candle {
  ts: number;                  // ms epoch of candle open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type OrderStatus =
  | 'PROPOSED'          // created, not yet risk-checked
  | 'RISK_REJECTED'     // blocked by deterministic risk engine
  | 'APPROVED'          // passed risk; awaiting submission (or owner approval)
  | 'AWAITING_OWNER'    // production order waiting for explicit owner confirmation
  | 'SUBMITTING'        // sent to venue, no acknowledgement yet
  | 'OPEN'              // venue acknowledged with an order id
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'         // may carry filledQty > 0 (partial then cancelled)
  | 'REJECTED'          // rejected by venue
  | 'EXPIRED'
  | 'UNKNOWN';          // submission outcome unknown (timeout) — must reconcile, never blind-retry

export const TERMINAL_STATUSES: OrderStatus[] = ['RISK_REJECTED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];

export interface TradeOrder {
  id: string;
  environment: Environment;
  venue: Venue;
  symbol: string;
  assetClass: AssetClass;
  side: Side;
  orderType: OrderType;
  product: 'CNC' | 'SPOT';     // cash/delivery or crypto spot only — no MIS/NRML/margin
  qty: number;
  limitPrice?: number;
  triggerPrice?: number;
  stopPrice?: number;          // protective stop of the plan (for risk), not necessarily an order
  targetPrice?: number;
  idempotencyKey: string;      // unique per environment
  clientOrderId: string;       // sent to venue (Kite `tag`, CoinDCX `client_order_id`)
  brokerOrderId?: string;      // only set from a venue acknowledgement
  status: OrderStatus;
  filledQty: number;
  avgFillPrice?: number;
  feesPaise: Paise;
  signalId?: string;
  rejectionReason?: string;
  riskCheckIds?: string[];
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  ownerConfirmedAt?: number;
  createdBy: Actor;
  isRangeTrade?: boolean;
  sector?: string;
  plannedRiskPaise?: Paise;
  parentOrderId?: string;      // for exits: the entry order being closed
  exitReason?: 'STOP' | 'TARGET' | 'INVALIDATION' | 'MANUAL' | 'KILL_SWITCH';
  timeframe?: Timeframe;
}

export interface TradeFill {
  id: string;
  environment: Environment;
  orderId: string;
  venue: Venue;
  venueTradeId: string;        // unique per venue+environment; dedupes replays
  symbol: string;
  assetClass: AssetClass;
  side: Side;
  qty: number;
  price: number;
  feesPaise: Paise;            // venue-reported if available, else estimated (see feesSource)
  feesSource: 'BROKER' | 'ESTIMATE';
  tdsPaise: Paise;             // crypto 1% TDS on sale (India), withheld by exchange
  ts: number;
  source: DataSource;          // BROKER for production, PAPER_FEED / SIMULATED otherwise
  reconciled: boolean;         // matched against venue trade book
  settlementDate: string;      // YYYY-MM-DD when proceeds/holdings settle (T+1 equity, T+0 crypto)
  realizedPnlPaise?: Paise;    // gross realized on SELL (proceeds - FIFO cost)
  costBasisPaise?: Paise;
}

export type LedgerEntryType =
  | 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'BUY_FILL' | 'SELL_FILL' | 'FEE_ADJUSTMENT'
  | 'TAX_PROVISION' | 'TAX_RELEASE' | 'COMPOUNDING' | 'RECONCILIATION_ADJUSTMENT' | 'OPENING_BALANCE';

export interface LedgerLine {
  account: string;
  amountPaise: Paise;          // debit positive, credit negative; entry lines sum to 0
}

export interface LedgerEntry {
  id: string;
  environment: Environment;
  seq: number;
  ts: number;
  type: LedgerEntryType;
  memo: string;
  lines: LedgerLine[];
  refType?: string;
  refId?: string;
  idempotencyKey: string;
  source: DataSource;
  prevHash: string;
  hash: string;
}

export type SignalStatus = 'CANDIDATE' | 'REJECTED' | 'VALIDATED' | 'WATCHLIST' | 'APPROVED' | 'EXECUTED' | 'EXPIRED';

export interface FinalCheckResult {
  passed: boolean;
  items: { id: number; block: string; text: string; mode: 'auto' | 'manual'; pass: boolean | null; note?: string }[];
  failed: number[];
  pendingManual: number[];
}

export interface AISignal {
  id: string;
  environment: Environment;
  symbol: string;
  venue: Venue;
  assetClass: AssetClass;
  side: Side;
  timeframe: Timeframe;
  htf: Timeframe;
  entry: number;
  stop: number;
  target: number;
  qty: number;
  rr: number;
  rrNetOfCosts: number;
  plannedRiskPaise: Paise;
  estFeesPaise: Paise;
  estSlippagePaise: Paise;
  rationale: string[];
  invalidation: string[];
  retailIllusion?: string;
  areaAnswers?: Record<string, string>;
  setupType: string;
  confidence: number;          // 0..1 from deterministic analysis; AI review may only lower it
  status: SignalStatus;
  rejectionReasons: string[];
  dataAsOf: number;
  dataSource: DataSource;
  finalCheck?: FinalCheckResult;
  aiReview?: { model: string; verdict: 'agree' | 'downgrade' | 'reject'; notes: string; at: number };
  createdAt: number;
  sector?: string;
  isRangeTrade?: boolean;
  ownerApprovedAt?: number;    // owner approved the plan (entry/stop/target/qty); arms the trigger
  armedAt?: number;
  triggerExpiresAt?: number;
  orderId?: string;
  expiryReason?: string;
}

export type RiskSeverity = 'INFO' | 'WARN' | 'BLOCK' | 'HALT';

export interface RiskEvent {
  id: string;
  environment: Environment;
  ts: number;
  code: string;
  severity: RiskSeverity;
  message: string;
  orderId?: string;
  signalId?: string;
  data?: Record<string, unknown>;
}

export interface AutomationLog {
  id: string;
  environment: Environment;
  ts: number;
  job: string;
  runKey: string;              // idempotency key of the scheduled run
  status: 'STARTED' | 'SUCCESS' | 'SKIPPED' | 'FAILED';
  message: string;
  actor: Actor;
  data?: Record<string, unknown>;
}

export interface DailySnapshot {
  id: string;
  environment: Environment;
  date: string;                // YYYY-MM-DD (IST)
  cashPaise: Paise;
  investedCostPaise: Paise;
  marketValuePaise: Paise;
  unrealizedPnlPaise: Paise;
  realizedPnlDayPaise: Paise;
  realizedPnlCumPaise: Paise;
  feesDayPaise: Paise;
  feesCumPaise: Paise;
  taxReservePaise: Paise;
  tdsReceivablePaise: Paise;
  netEquityPaise: Paise;
  netContributionsPaise: Paise;
  dayReturnPct: number;
  cumReturnPct: number;
  drawdownPct: number;
  peakEquityPaise: Paise;
  targetProgressPct: number;   // dayReturn / aspirational target; informational only
  pricesSource: DataSource;
  createdAt: number;
}

export interface ReconciliationRecord {
  id: string;
  environment: Environment;
  venue: Venue;
  ts: number;
  kind: 'BALANCES' | 'HOLDINGS' | 'ORDERS' | 'FILLS' | 'DAILY_PNL';
  status: 'MATCHED' | 'MISMATCH' | 'ERROR';
  diffs: { field: string; internal: string | number; venue: string | number }[];
  importedFillIds: string[];
  message: string;
}

export interface CompoundingEvent {
  id: string;
  environment: Environment;
  date: string;
  cumEligibleNetPaise: Paise;
  previousHighWaterPaise: Paise;
  newProfitPaise: Paise;
  reinvestPct: number;
  reinvestedPaise: Paise;
  toReservePaise: Paise;
  byVenue: Record<string, Paise>;
  ledgerEntryId?: string;
  status: 'COMPOUNDED' | 'NOTHING_ELIGIBLE';
  note: string;
  createdAt: number;
}

export interface APIConnection {
  id: string;
  venue: Venue;
  environment: Environment;
  status: 'NOT_CONFIGURED' | 'CREDENTIALS_PRESENT' | 'AUTHENTICATED' | 'TESTED_READ_ONLY' | 'TESTED_ORDERS_SANDBOX' | 'EXPIRED' | 'ERROR' | 'REVOKED';
  permissions: { read: boolean; trade: boolean; withdraw: boolean };
  sessionExpiresAt?: number;
  lastHealthCheckAt?: number;
  lastHealthOk?: boolean;
  lastError?: string;
  capabilitiesVerifiedAt?: number;
  capabilityNotes?: string;
  feedHealthy?: boolean;
  lastFeedTickAt?: number;
}

export interface JournalEntry {
  id: string;
  environment: Environment;
  kind: 'PRE_TRADE' | 'POST_TRADE' | 'PROFILE' | 'PSYCHOLOGY';
  ts: number;
  symbol?: string;
  signalId?: string;
  orderId?: string;
  sectorWhy?: string;
  stockWhy?: string;
  positionWhy?: string;
  againstMePlan?: string;
  whatHappened?: string;
  rulesFollowed?: string[];
  rulesBroken?: string[];
  profileScenario?: { nifty: Trend3; sector: Trend3; stock: Trend3 };
  notes?: string;
  outcome?: 'WIN' | 'LOSS' | 'SCRATCH';
}

export type Trend3 = 'UP' | 'DOWN' | 'CONSOLIDATION';

export interface KillSwitchState {
  active: boolean;
  reason?: string;
  activatedAt?: number;
  activatedBy?: Actor;
}

export interface Allocation {
  stocksPaise: Paise;
  cryptoPaise: Paise;
  reservePaise: Paise;
}

export interface StrategySettings {
  id: string;
  version: number;
  environment: Environment;
  initialCapitalPaise: Paise;
  allocation: Allocation;
  maxRiskPerTradePct: number;      // 0.5
  dailyLossStopPct: number;        // 1
  weeklyLossStopPct: number;       // 3
  maxOpenExposurePct: number;      // 50
  dailyRiskBudgetPct: number;      // prop desk 0.25–1, never > 1
  minRewardRisk: number;           // net-of-costs R:R minimum
  maxFeeToRiskPct: number;         // reject if round-trip costs eat > X% of planned risk
  maxQuoteAgeMs: number;
  maxCandleLagMultiple: number;    // candle considered stale after N × timeframe
  maxReconciliationAgeMs: number;
  reinvestPct: number;             // share of eligible new profit compounded
  dailyTargetPct: number;          // ASPIRATIONAL ONLY — never read by risk or sizing
  maxTradesPerSector: number;      // prop desk: 2 (hard cap 3)
  maxRangeTradePct: number;        // prop desk: ≤ 20%
  equityPriceMin: number;          // prop desk universe ₹100
  equityPriceMax: number;          // prop desk universe ₹4000
  minTimeframe: Timeframe;         // prop desk: never below 5m
  stockTimeframe: Timeframe;
  cryptoTimeframe: Timeframe;
  executionMode: 'manual_approval' | 'auto';
  liveTradingEnabled: boolean;
  firstLiveOrderConfirmedAt?: number;
  phase: 1 | 2 | 3 | 4 | 5;
  taxRates: { cryptoGainPct: number; equityIntradayPct: number; equityStcgPct: number; cryptoTdsPct: number };
  consecutiveLossCooldown: number; // stop new entries after N consecutive stop-outs in a day
  updatedAt: number;
  updatedBy: Actor;
  confirmedByOwnerAt?: number;
}
