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
  previousTradingDay,
  toEtDateString,
} from "./calendar.js";

// DR-011 — earnings calendar
export {
  EARNINGS_DATES_2026,
  EARNINGS_PREEXPAND_BPS,
  tickersReportingOn,
  isEarningsDay,
  tickersToPreExpand,
  tickersToRestore,
  listMalformedEarningsDates,
  listInvalidExpansionCaps,
} from "./earnings-calendar.js";
export { runEarningsCronOnce } from "./earnings-evolution.js";
export type { EarningsCronDeps, EarningsCronOutcome, EarningsActionOutcome } from "./earnings-evolution.js";

// DR-010 — win-streak indexer
export { getSqlClient, setSqlClientForTesting, IndexerDbError } from "./db/client.js";
export type { SqlClient } from "./db/client.js";
export * from "./db/types.js";
export {
  insertSettleEvent,
  insertUserMarketHold,
  applyResultToUserStreak,
  getUserStreak,
  topNLeaderboard,
  insertSnapshot,
  insertDistribution,
  getSettleEventByTxSig,
  getHoldsForSettleEvent,
} from "./db/queries.js";
export {
  determineResult,
  handleSettleEvent,
} from "./indexer/settle-event-handler.js";
export type {
  TokenHolder,
  FetchTokenHoldersFn,
  HandleSettleEventInput,
  HandleSettleEventDeps,
  HandleSettleEventResult,
} from "./indexer/settle-event-handler.js";
export {
  hashLeaf,
  buildLeaderboardMerkleTree,
  verifyLeafProof,
} from "./indexer/merkle.js";
export type { LeaderboardLeaf, LeaderboardMerkleTree } from "./indexer/merkle.js";
export {
  isoWeekInfo,
  isoWeekId,
  weeklyPeriodStartUtc,
  weeklyPeriodEndUtc,
  monthlyPeriodId,
  monthlyPeriodStartUtc,
  monthlyPeriodEndUtc,
  lastFridayOfMonth,
  isLastTradingFridayOfMonth,
  periodForDate,
} from "./indexer/periods.js";
export type { PeriodInfo } from "./indexer/periods.js";
export { uploadLeaderboardToArweave, ArweaveError } from "./indexer/arweave.js";
export type { ArweaveUploadResult, ArweaveDeps } from "./indexer/arweave.js";
export {
  DEFAULT_DISTRIBUTION_BPS,
  runDistributeForPeriod,
  applyDeterministicTiebreaker,
} from "./indexer/distribute.js";
export type {
  DistributeForPeriodDeps,
  DistributeOutcome,
  CommitLeaderboardRootFn,
  CommitLeaderboardRootInput,
  CommitLeaderboardRootResult,
  DistributeRewardsFn,
  DistributeRewardsInput,
  DistributeRewardsResult,
  ReadPoolBalanceFn,
} from "./indexer/distribute.js";
export {
  parseHeliusSettleWebhook,
  SETTLE_MARKET_DISCRIMINATOR_BASE58,
} from "./indexer/helius-webhook.js";
export type { HeliusEnhancedTx, ParsedSettleEvent } from "./indexer/helius-webhook.js";

// DR-014 — user profiles + social linking + notification channels
export * from "./auth/index.js";
