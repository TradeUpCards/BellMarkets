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
  // Anchor 0.30 BorshAccountsCoder may return enum variant keys at
  // different casings depending on the IDL format (Unsettled vs unsettled).
  // Lowercase + key-includes lookup handles both shapes — pre-fix, the
  // PascalCase form was falling through to "invalid" which then made
  // `marketSettled = (tag !== "unsettled")` evaluate to TRUE and the
  // disable matrix gated trading with 'Market settled' on every market.
  if (!o || typeof o !== "object") return "invalid";
  const keys = Object.keys(o).map((k) => k.toLowerCase());
  if (keys.includes("unsettled")) return "unsettled";
  if (keys.includes("yes")) return "yes";
  if (keys.includes("no")) return "no";
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
  /**
   * DR-020 in-program CLOB trading gate. `Pubkey::default()` until
   * `grow_order_book` runs against this strike. Trading ixs (`place_order`,
   * `cancel_order`) require `strike_market.order_book == order_book.key()`,
   * so a non-default value here signals "ready to trade."
   */
  orderBook: PublicKey;
}

/**
 * Single resting order in the on-chain `OrderBook` (DR-020, zero_copy / bytemuck).
 * Mirrors `programs/bell-markets/src/state.rs::Order`.
 */
export interface Order {
  owner: PublicKey;
  price: bigint;
  size: bigint;
  seq: bigint;
  side: 0 | 1; // SIDE_BID=0, SIDE_ASK=1
}

/**
 * Mirror of the on-chain `OrderBook` zero-copy account. We expose decoded
 * bid/ask slices (length-bounded by `bids_len` / `asks_len`) — the tail
 * garbage bytes per Keith's L-5 are sliced off here.
 */
export interface OrderBookAccount {
  market: PublicKey;
  nextSeq: bigint;
  bids: Order[];
  asks: Order[];
  bump: number;
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
