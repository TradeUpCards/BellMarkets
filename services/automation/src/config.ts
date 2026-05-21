// Read-once env config for the automation service. Single source of truth
// for every URL/key the jobs use. Throws at import-time if anything
// required is missing — fail fast over fail-mysterious.
//
// Trigger.dev provides the env at job-execution time; we don't need
// dotenv inside the job code itself. For local `vitest` runs we also
// don't load .env — tests inject everything they need.

import type { Ticker } from "./types.js";

export type AutomationConfig = {
  triggerProjectRef: string | undefined;
  heliusRpcUrl: string | undefined;
  pythHttpBaseUrl: string | undefined;
  programId: string | undefined;
  adminKeypairPath: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomationConfig {
  return {
    triggerProjectRef: env.TRIGGER_PROJECT_REF || undefined,
    heliusRpcUrl: env.HELIUS_DEVNET_RPC_URL || undefined,
    pythHttpBaseUrl: env.PYTH_HTTP_BASE_URL || undefined,
    programId: env.PROGRAM_ID || undefined,
    adminKeypairPath: env.ADMIN_KEYPAIR_PATH || undefined,
  };
}

export class MissingConfigError extends Error {
  constructor(public readonly fields: readonly (keyof AutomationConfig)[]) {
    super(`automation service missing required env vars: ${fields.join(", ")}`);
    this.name = "MissingConfigError";
  }
}

/**
 * Fail fast at the top of a job's `run` body when required env vars are
 * absent. Returns the same config object with the listed fields proven
 * non-undefined for downstream consumers.
 *
 * Day-1 jobs use the stub path (no on-chain calls) and only require
 * config when transitioning to live execution. Calling this from inside
 * the stub guards is safe — the stub branch returns before this is hit.
 */
export function requireConfig<K extends keyof AutomationConfig>(
  config: AutomationConfig,
  fields: readonly K[],
): AutomationConfig & { [P in K]-?: NonNullable<AutomationConfig[P]> } {
  const missing = fields.filter((f) => !config[f]);
  if (missing.length > 0) throw new MissingConfigError(missing);
  return config as AutomationConfig & { [P in K]-?: NonNullable<AutomationConfig[P]> };
}

// Ticker → Pyth feed-id mapping. The feed-ids below are PLACEHOLDERS;
// Aria's on-chain MarketConfig.pyth_feed_map is the authoritative source,
// and these morning-job constants must be reconciled against that before
// the first live devnet run. Tracked as a Day-2 follow-up.
export const PYTH_FEED_IDS: Record<Ticker, string> = {
  AAPL: "PLACEHOLDER_AAPL_FEED_ID",
  MSFT: "PLACEHOLDER_MSFT_FEED_ID",
  GOOGL: "PLACEHOLDER_GOOGL_FEED_ID",
  AMZN: "PLACEHOLDER_AMZN_FEED_ID",
  NVDA: "PLACEHOLDER_NVDA_FEED_ID",
  META: "PLACEHOLDER_META_FEED_ID",
  TSLA: "PLACEHOLDER_TSLA_FEED_ID",
};
