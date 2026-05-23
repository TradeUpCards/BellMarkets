// Live devnet PDA pubkeys for Aria's deploy #5 (2026-05-23).
//
// Source: migrations/audit_log.jsonl deploy_index=5 + Aria's
// .project/bell-markets/coordination/devnet-pubkeys.md.
//
// These are stable across upgrades — same program ID always derives the
// same PDAs. Hardcoding here (rather than env vars) is correct for the
// MVP single-cluster build; for multi-cluster v2, switch to per-cluster
// const tables keyed by network.
//
// **Do NOT** commit any secret material here — these are public on-chain
// account addresses, equivalent to URLs.

import type { Ticker } from "./types.js";

/** Aria's deployed Anchor program ID (5 cumulative deploys to this ID). */
export const BELL_MARKETS_PROGRAM_ID = "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";

/** MarketConfig PDA (singleton; seed = [b"config"]). Initialized Day-3. */
export const MARKET_CONFIG_PDA = "6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ";

/** FeeConfig PDA (singleton; seed = [b"fee_config"]). Initialized at deploy-5
 *  via migrations/bootstrap-p5 in tx
 *  2DR8Y5cBCib2Jo8WCxvdsXR3f9789avDTFaR36UWBFw6xrfs4YVTJ8wNoog7NkukR5hwUFKVYnkSKkzYNJMu91hw. */
export const FEE_CONFIG_PDA = "4xMt4J2WuLFH77Jq3Yexxuv38Ge36fNnWNRmSKLCiT3c";

/** WeeklyRewardsPool token-account PDA (seed = [b"weekly_pool"]). */
export const WEEKLY_REWARDS_POOL_PDA = "2VWzrhmdNZN7Yxv2uknYBurJ2PDFzCqsyi5WVeVxJpCW";

/** MonthlyRewardsPool token-account PDA (seed = [b"monthly_pool"]). */
export const MONTHLY_REWARDS_POOL_PDA = "Eppjny6RMtVrGxZnjiKEyk41vwWYpXW4PMVKJHC4SAjh";

/** LeaderboardCommitments zero-copy PDA (singleton; seed = [b"leaderboard_commits"]).
 *  24-entry ring buffer of (period_id, period_type, merkle_root, arweave_tx_id). */
export const LEADERBOARD_COMMITMENTS_PDA = "FxohonFj6bTtbPxe4HNjwy736sqkyPfKj5GRektScF7C";

/** Circle's devnet USDC mint (bound in MarketConfig.usdc_mint at Day-3 init). */
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Platform admin keypair pubkey (signs initialize_config / create_strike_market /
 *  update_ticker_config / commit_leaderboard_root / distribute_*_rewards / pause). */
export const PLATFORM_ADMIN_PUBKEY = "7b17F2woUy9hgHcRjuLckBVAtNnKAJBRD769URvLprp5";

/** Treasury / fee collector ATA owner — receives platform-retain fee + Phoenix
 *  fees (when DR-009 Model D ever ships). Passive holder. */
export const FEE_COLLECTOR_PUBKEY = "FAc2JccudUr9C5pqB2KAnaBaPXLuejYotvfjuuysUrjs";

/** SPL Token program. Constant across all clusters. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Associated Token Program. Constant across all clusters. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/**
 * Pre-existing devnet Pyth on-chain price-account pubkeys. SOL/USD placeholder
 * is used for META until a MAG7-native Pyth devnet feed lands. Empty entries
 * mean "ticker has no on-chain feed pubkey configured yet" — cron skips +
 * logs the ticker as skipped (no error).
 */
export const DEVNET_PYTH_PRICE_ACCOUNTS: Partial<Record<Ticker, string>> = {
  META: "J83w4HKfFqVghYYjAYTQTzAQ9QQbpDgN1qmcQxk8q1QH", // SOL/USD as placeholder
};

/**
 * Pre-existing devnet Phoenix v1 FIFO market pubkeys per ticker. SOL/USDC is
 * the placeholder venue Bram has used Day-4 for META live morning-create.
 */
export const DEVNET_PHOENIX_MARKETS: Partial<Record<Ticker, string>> = {
  META: "CS2H8nbAVVEUHWPF5extCSymqheQdkd4d7thik6eet9N", // SOL/USDC
};
