// Barrel export for the automation service. Re-exports the strike-calc
// + clients + jobs so callers (Drew's integration tests, future scripts)
// can import from a single module path.

export * from "./types.js";
export * from "./strike-calc.js";
export { loadConfig, requireConfig, MissingConfigError, PYTH_FEED_IDS } from "./config.js";
export type { AutomationConfig } from "./config.js";
export { PythClient, parsePreviousCloseResponse, PythClientError } from "./clients/pyth.js";
export type { PythClientOptions, PythPriceFeed, PreviousCloseResponse } from "./clients/pyth.js";
export { HeliusClient } from "./clients/helius.js";
export type { HeliusClientOptions } from "./clients/helius.js";
export { morningCreateMarketsJob } from "./jobs/morning.js";
export { settlementNudgerJob } from "./jobs/settlement.js";
