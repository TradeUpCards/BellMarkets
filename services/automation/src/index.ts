// Barrel export for the automation service. Re-exports the strike-calc
// + clients + jobs so callers (Drew's integration tests, future scripts)
// can import from a single module path.

export * from "./types.js";
export * from "./strike-calc.js";
export {
  loadConfig,
  requireConfig,
  MissingConfigError,
  PYTH_HERMES_FEED_IDS,
  ET_4PM_UTC_HOUR_EDT,
  computeExpiryUnixFor4pmETSameDay,
} from "./config.js";
export type { AutomationConfig } from "./config.js";
export { PythClient, parsePreviousCloseResponse, PythClientError } from "./clients/pyth.js";
export type {
  PythClientOptions,
  PythPriceFeed,
  PreviousCloseResponse,
} from "./clients/pyth.js";
export { HeliusClient } from "./clients/helius.js";
export type { HeliusClientOptions } from "./clients/helius.js";
export {
  BellMarketsAnchorClient,
  AnchorClientError,
  parseIdlJson,
} from "./clients/anchor.js";
export type { AnchorClientOptions } from "./clients/anchor.js";
export {
  runMorningCreateMarkets,
  scaleStrikeToI64,
} from "./jobs/morning.js";
export type {
  MorningJobDeps,
  MorningJobOutcome,
  SendCreateStrikeMarketInput,
  SendCreateStrikeMarketResult,
  SendCreateStrikeMarketTxFn,
  TickerOutcome,
} from "./jobs/morning.js";
export {
  runSettlementNudger,
  defaultShouldRetry,
  SETTLE_RETRY_INTERVAL_MS,
  SETTLE_RETRY_DEADLINE_MS,
} from "./jobs/settlement.js";
export type {
  SettlementJobDeps,
  SettlementJobOutcome,
  SettlementOutcome,
  OpenMarketRef,
  SettleMarketTxFn,
} from "./jobs/settlement.js";
export { retryUntilDeadline } from "./lib/retry.js";
export type { RetryOptions, RetryResult, RetryDeps } from "./lib/retry.js";

// DR-005 / DR-006 — strike-grid evolution
export {
  TICKER_DEFAULTS,
  computeStrikeGrid,
  driftBps,
  expandedStrikeGrid,
  roundToTick,
  phaseLabelToOnChainCode,
} from "./ticker-config.js";
export type {
  PhaseLabel,
  TickerConfigView,
  TickerDefaults,
} from "./ticker-config.js";
export {
  runAnchorPhase,
  runWildSwingPhase,
  isInPhaseWindow,
  isRegularTradingDay,
} from "./grid-evolution.js";
export type {
  GridPhaseDeps,
  GridPhaseOutcome,
  PerTickerOutcome,
  UpdateTickerConfigInput,
  UpdateTickerConfigResult,
  UpdateTickerConfigFn,
  ReadTickerConfigFn,
} from "./grid-evolution.js";

// DR-007 — trading calendar
export {
  isTradingDay,
  isHalfDay,
  getCloseTime,
  nextTradingDay,
  toEtDateString,
} from "./calendar.js";
