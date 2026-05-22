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
  morningCreateMarketsJob,
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
  settlementNudgerJob,
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
