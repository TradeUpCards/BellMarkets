// Read-once env config for the automation service. Single source of truth
// for every URL/key the jobs use. `loadConfig` is total — every field can
// be undefined — and `requireConfig` is the gate that turns undefined into
// a single descriptive `MissingConfigError`. Fail-fast over fail-mysterious.
//
// Trigger.dev injects env at job-execution time; we don't need dotenv in
// the job code itself. For local vitest runs we also don't load .env —
// tests inject the env shape they need.
//
// Day-2 (2026-05-21): renamed `programId` → `bellMarketsProgramId` and
// `adminKeypairPath` → `platformAdminKeypairPath` to match Aria's wallet
// architecture (separation-of-authority: program / upgrade / admin /
// fee collector are four distinct keypairs).

import type { Ticker } from "./types.js";
import { MAG7 } from "./types.js";

export type AutomationConfig = {
  triggerProjectRef: string | undefined;
  heliusRpcUrl: string | undefined;
  pythHttpBaseUrl: string | undefined;
  /** Aria's deployed Anchor program ID — devnet `599h7…`. */
  bellMarketsProgramId: string | undefined;
  /** Path (rel-to-cwd or absolute) to the platform-admin keypair JSON. */
  platformAdminKeypairPath: string | undefined;
  /** Path (rel-to-cwd or absolute) to the Anchor IDL JSON. */
  bellMarketsIdlPath: string | undefined;
  /** SPL mint passed to initialize_config; required for create_strike_market. */
  usdcDevnetMint: string | undefined;
  /** Per-ticker Phoenix v1 FIFO market pubkeys. Empty entries are skipped. */
  phoenixMarkets: Partial<Record<Ticker, string>>;
  /**
   * Per-ticker Solana on-chain Pyth price-account pubkeys (network-specific:
   * devnet pubkeys differ from mainnet). Bound to
   * `StrikeMarket.underlying_pyth_feed` at create time. Empty entries are skipped.
   */
  pythPriceAccounts: Partial<Record<Ticker, string>>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AutomationConfig {
  const phoenixMarkets: Partial<Record<Ticker, string>> = {};
  const pythPriceAccounts: Partial<Record<Ticker, string>> = {};
  for (const ticker of MAG7) {
    const phx = env[`PHOENIX_MARKET_${ticker}`];
    if (phx && phx.length > 0) phoenixMarkets[ticker] = phx;
    const pyth = env[`PYTH_PRICE_ACCOUNT_${ticker}`];
    if (pyth && pyth.length > 0) pythPriceAccounts[ticker] = pyth;
  }
  return {
    triggerProjectRef: env.TRIGGER_PROJECT_REF || undefined,
    heliusRpcUrl: env.HELIUS_DEVNET_RPC_URL || undefined,
    pythHttpBaseUrl: env.PYTH_HTTP_BASE_URL || undefined,
    bellMarketsProgramId: env.BELL_MARKETS_PROGRAM_ID || undefined,
    platformAdminKeypairPath: env.PLATFORM_ADMIN_KEYPAIR_PATH || undefined,
    bellMarketsIdlPath: env.BELL_MARKETS_IDL_PATH || "src/idl/bell_markets.json",
    usdcDevnetMint: env.USDC_DEVNET_MINT || undefined,
    phoenixMarkets,
    pythPriceAccounts,
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
 * absent. Returns the config object narrowed so listed fields are
 * proven non-undefined for downstream consumers.
 */
export function requireConfig<K extends keyof AutomationConfig>(
  config: AutomationConfig,
  fields: readonly K[],
): AutomationConfig & { [P in K]-?: NonNullable<AutomationConfig[P]> } {
  const missing = fields.filter((f) => {
    const v = config[f];
    if (v === undefined) return true;
    if (typeof v === "object" && v !== null && Object.keys(v).length === 0) return true;
    return false;
  });
  if (missing.length > 0) throw new MissingConfigError(missing);
  return config as AutomationConfig & { [P in K]-?: NonNullable<AutomationConfig[P]> };
}

// ── Pyth Hermes feed IDs (off-chain HTTP previous-close lookup) ─────────────
// Network-agnostic 32-byte hex IDs from pyth.network/developers/price-feed-ids.
// These drive `PythClient.getPreviousClose()`. Aria's note (handoff
// §"Cross-lead coordination, for Bram"): `MarketConfig` does NOT store a
// `pyth_feed_map` on chain — the per-strike feed is bound to
// `StrikeMarket.underlying_pyth_feed` at create time. So this table is
// PURELY off-chain — it's the symbol→feed-id lookup the morning job uses to
// fetch previous-close for strike-calc. No on-chain reconciliation needed.
export const PYTH_HERMES_FEED_IDS: Record<Ticker, string> = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
  AMZN: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

// ── Time-zone math for 4pm ET expiry ────────────────────────────────────────
// 4pm ET = 20:00 UTC in EDT, 21:00 UTC in EST. Mirrors the cron expressions
// in morning.ts / settlement.ts (both EDT-anchored). DST flip is a known
// issue — see Day-1 cross-workstream notes.
export const ET_4PM_UTC_HOUR_EDT = 20;

/**
 * Given a wall-clock instant for the morning-job run, compute the unix
 * second value for 4:00 PM ET *that same day*. Pure / deterministic — used
 * as the `expiry_unix` arg to create_strike_market.
 *
 * EDT-only for the build window. Caller is responsible for catching the
 * DST flip (early November) via the cron-expression update.
 */
export function computeExpiryUnixFor4pmETSameDay(runAt: Date): number {
  const y = runAt.getUTCFullYear();
  const m = runAt.getUTCMonth();
  const d = runAt.getUTCDate();
  return Math.floor(Date.UTC(y, m, d, ET_4PM_UTC_HOUR_EDT, 0, 0) / 1000);
}
