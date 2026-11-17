import type { BacktestResult } from '@core/backtest.ts';
import type { AuditRecord, SystemState } from '@core/repo.ts';
import type { EquityView, Position } from '@core/portfolio.ts';
import type { OrderProposal } from '@core/risk.ts';
import type { SettingsChangeResult } from '@core/settings.ts';
import type {
  AISignal, APIConnection, AutomationLog, Candle, CompoundingEvent, DailySnapshot, Environment, Instrument, JournalEntry, LedgerEntry,
  Quote, ReconciliationRecord, RiskEvent, StrategySettings, Timeframe, TradeFill, TradeOrder, Venue,
} from '@core/types.ts';

export type DataMode = 'local-simulation' | 'base44';

export interface AppState {
  mode: DataMode;
  environment: Environment;
  connected: boolean;               // false ⇒ no real data for this environment; UI shows no numbers
  now: number;
  equity?: EquityView;
  positions: Position[];
  orders: TradeOrder[];
  fills: TradeFill[];
  signals: AISignal[];
  ledger: LedgerEntry[];
  ledgerChain?: { ok: boolean; entries: number; brokenAtSeq?: number; reason?: string };
  auditChain?: { ok: boolean; records: number; brokenAt?: string };
  snapshots: DailySnapshot[];
  compounding: CompoundingEvent[];
  riskEvents: RiskEvent[];
  logs: AutomationLog[];
  audit: AuditRecord[];
  reconciliations: ReconciliationRecord[];
  settings?: StrategySettings;
  system?: SystemState;
  connections: APIConnection[];
  journal: JournalEntry[];
  quotes: Quote[];
  instruments: Instrument[];
  psychology: string[];
  anchors?: { startOfDay: number; startOfWeek: number; contribDay: number; contribWeek: number; today: string };
  plannedRiskTodayPaise: number;
  closedStats?: { count: number; wins: number; accuracyPct?: number };
  complianceTicks: Record<string, boolean>;
  sandboxTests: Record<string, boolean>;
  backtestTrades: number;
  busy: boolean;
  lastMessage?: { kind: 'ok' | 'error' | 'info'; text: string };
}

export interface Actions {
  setEnvironment(env: Environment): void;
  refresh(): Promise<void>;
  // simulation clock
  step(bars: number): Promise<void>;
  loadScenario(symbol: string): Promise<void>;
  reset(): Promise<void>;
  // trading
  generateSignals(): Promise<void>;
  approveSignal(id: string, manualTicks: Record<number, boolean>): Promise<void>;
  cancelSignal(id: string): Promise<void>;
  aiReview(id: string): Promise<void>;
  submitOrder(p: OrderProposal, opts: { ownerConfirmed?: boolean; firstLiveOrderPhrase?: string }): Promise<void>;
  confirmOrder(id: string, firstLiveOrderPhrase?: string): Promise<void>;
  cancelOrder(id: string): Promise<void>;
  // safety & settings
  killSwitch(active: boolean, reason: string, confirm?: boolean): Promise<void>;
  changeSettings(patch: Partial<StrategySettings>, phrase?: string): Promise<SettingsChangeResult | undefined>;
  confirmFirstLiveOrder(phrase: string): Promise<void>;
  cashFlow(venue: Venue | 'BANK', rupees: number, reference: string): Promise<void>;
  reconcile(venue: Venue): Promise<void>;
  dailyClose(): Promise<void>;
  addJournal(entry: Omit<JournalEntry, 'id' | 'environment' | 'ts'>): Promise<void>;
  setCompliance(ticks: Record<string, boolean>): Promise<void>;
  kiteLogin(): Promise<void>;
  revokeCredentials(): Promise<void>;
  // read helpers
  candles(venue: Venue, symbol: string, tf: Timeframe): Candle[];
  backtest(symbol: string): Promise<BacktestResult | undefined>;
}
