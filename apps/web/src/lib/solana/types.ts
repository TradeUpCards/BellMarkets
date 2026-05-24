import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";

/** Outcome enum encoding per IDL (`apps/web/src/idl/bell_markets.json`). */
export type OutcomeTag = "unsettled" | "yes" | "no" | "invalid";

/** Anchor decodes the on-chain `Outcome` enum as `{ <camelCaseName>: {} }`. */
export type Outcome =
  | { unsettled: Record<string, never> }
  | { yes: Record<string, never> }
  | { no: Record<string, never> }
  | { invalid: Record<string, never> };

export function outcomeTag(o: Outcome): OutcomeTag {
  if ("unsettled" in o) return "unsettled";
  if ("yes" in o) return "yes";
  if ("no" in o) return "no";
  return "invalid";
}

export function isSettled(o: Outcome): boolean {
  return outcomeTag(o) !== "unsettled";
}

/** Mirror of `programs/bell-markets/src/state.rs::MarketConfig` (post-Anchor decode). */
export interface MarketConfig {
  admin: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
  priceStalenessSecs: BN;
  priceConfidenceBps: number;
  adminOverrideDelaySecs: BN;
  paused: boolean;
  bump: number;
}

/** Mirror of `programs/bell-markets/src/state.rs::StrikeMarket` (post-Anchor decode). */
export interface StrikeMarket {
  config: PublicKey;
  underlyingPythFeed: PublicKey;
  strikePrice: BN;
  expiryUnix: BN;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  phoenixMarket: PublicKey;
  settlePrice: BN;
  settleConfidence: BN;
  settleSlot: BN;
  settledAtUnix: BN;
  outcome: Outcome;
  adminOverrideEligibleAt: BN;
  bump: number;
  yesMintBump: number;
  noMintBump: number;
  vaultBump: number;
  /** Set on user_create_strike_market — drives DR-008 creator rebate. */
  creator: PublicKey;
  /** Total Yes (and No) tokens outstanding — invariant: usdc_vault.amount == pairs_outstanding × $1. */
  pairsOutstanding: BN;
}

/** Mirror of `programs/bell-markets/src/state.rs::FeeConfig` per DR-008. */
export interface FeeConfig {
  config: PublicKey;
  mintFeeBps: number;
  platformRetainBps: number;
  weeklyPoolBps: number;
  monthlyPoolBps: number;
  creatorRebateBps: number;
  forceRedeemGraceSecs: BN;
  /** Top-10 weekly payout splits (bps; sums to 10000). */
  weeklyDistributionBps: number[];
  monthlyDistributionBps: number[];
  bump: number;
}

/** Mirror of `UserConfig` per DR-008. */
export interface UserConfig {
  user: PublicKey;
  mintVolume30d: BN;
  mintVolumeLifetime: BN;
  lastDecayUnix: BN;
  bump: number;
}

/** Mirror of `TickerConfig` per DR-005 + DR-006. */
export interface TickerConfig {
  pythFeed: PublicKey;
  capCenter: BN;
  /** Fixed-size 16-slot array; only the first `strikeCount` entries are populated. */
  allowedStrikes: BN[];
  strikeCount: number;
  maxUserStrikeDeviationBps: number;
  strikeTickSize: BN;
  thresholdBps: number;
  lastUpdatedUnix: BN;
  bump: number;
}

export interface StrikeMarketWithPda {
  pda: PublicKey;
  data: StrikeMarket;
}
