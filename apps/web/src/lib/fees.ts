/**
 * Mint-side fee projection per DR-008.
 *
 * The on-chain `mint_pair` instruction (post-refresh) charges:
 *   effective_fee_bps = tier_fee_bps × (10_000 - creator_rebate_bps) / 10_000
 *   fee_micros        = amount_micros × effective_fee_bps / 10_000
 *
 * This file is a PURE PROJECTION ONLY — the on-chain program is the source
 * of truth. The frontend uses these helpers to:
 *   - preview "Cost: $1.02 = $1 pair + $0.02 fee (tier 2, 2%)"
 *   - show "you opened this market: -100% fee" creator-rebate hint
 *   - estimate `amount + fee` for sizing inputs before the user signs
 *
 * Tier thresholds in USDC mint-volume (30-day rolling, per `UserConfig`):
 *   Tier 1 ($0–$1k):       200 bps (2%)
 *   Tier 2 ($1k–$10k):     150 bps (1.5%)
 *   Tier 3 ($10k+):        100 bps (1%)
 *
 * The default `MarketConfig.mint_fee_bps` is 0 — fee mechanism present but
 * disabled. Admin flips to 200 via signed config update. If `mint_fee_bps`
 * is zero, every tier-projection falls through to zero — UI shows "$0 fee"
 * cleanly.
 *
 * Anti-gaming reminder (DR-008 §"Critical safeguard"): mints that receive
 * ANY creator rebate (even partial) do NOT update `user_config.mint_volume_30d`
 * — enforced on-chain. The frontend just needs to reflect this in tier-
 * progression previews so the creator's "free mint" doesn't display as
 * "+ $X to your tier volume."
 */

import BN from "bn.js";

export const FEE_BPS_DENOMINATOR = 10_000;

export const TIER_THRESHOLDS_MICROS = {
  /** $1,000 in USDC micros. */
  tier2: 1_000n * 1_000_000n,
  /** $10,000 in USDC micros. */
  tier3: 10_000n * 1_000_000n,
} as const;

export const TIER_FEE_BPS = {
  tier1: 200,
  tier2: 150,
  tier3: 100,
} as const;

export type FeeTier = 1 | 2 | 3;

/** Pure: map 30-day mint volume (USDC micros) to tier. */
export function tierForVolume(mintVolume30dMicros: bigint): FeeTier {
  if (mintVolume30dMicros >= TIER_THRESHOLDS_MICROS.tier3) return 3;
  if (mintVolume30dMicros >= TIER_THRESHOLDS_MICROS.tier2) return 2;
  return 1;
}

/** Pure: map tier to default tier-fee bps. */
export function feeBpsForTier(tier: FeeTier): number {
  if (tier === 3) return TIER_FEE_BPS.tier3;
  if (tier === 2) return TIER_FEE_BPS.tier2;
  return TIER_FEE_BPS.tier1;
}

export interface ProjectMintFeeParams {
  /** Pair amount the user wants to mint (USDC micros = also pair-count when 1 pair = $1). */
  amountMicros: bigint;
  /** Live `MarketConfig.mint_fee_bps` (0 by default = fee disabled). */
  configMintFeeBps: number;
  /** User's `mint_volume_30d` from `UserConfig` (0 if PDA doesn't exist). */
  userMintVolume30dMicros: bigint;
  /** Whether THIS mint qualifies for the creator rebate. */
  creatorRebateApplies: boolean;
  /** Live `MarketConfig.creator_rebate_bps` (10_000 = 100% rebate by default). */
  configCreatorRebateBps: number;
}

export interface ProjectedMintFee {
  tier: FeeTier;
  tierFeeBps: number;
  /** Fee bps after creator-rebate multiplier applied. */
  effectiveFeeBps: number;
  feeMicros: bigint;
  /** What the user actually pays (amount + fee). */
  totalCostMicros: bigint;
  /** Will this mint count toward 30-day volume? false iff creator rebate applies. */
  countsTowardVolume: boolean;
}

/**
 * Compute the projected on-chain fee for a `mint_pair` call. Pure function —
 * deterministic given the four inputs the UI already has from subscriptions.
 *
 * Matches the on-chain formula:
 *   tier_fee_bps  = TIER_FEE_BPS[tier(user_config.mint_volume_30d)]
 *   if `config.mint_fee_bps == 0`: feeBps = 0 (disabled)
 *   else: feeBps = max(tier_fee_bps, config.mint_fee_bps) ... actually per spec:
 *
 * Per DR-008 §"Three layered discounts" the tier-fee REPLACES the default
 * `MarketConfig.mint_fee_bps` (not max of them). The config bps is the
 * "ceiling default" (200 bps = 2%) that tiers DISCOUNT against. We project:
 *   - If `configMintFeeBps == 0`: feature disabled → `effectiveFeeBps = 0`.
 *   - Otherwise: `effectiveFeeBps = tier_fee_bps × (10000 - creator_rebate_bps×rebateApplies) / 10000`.
 *
 * This mirrors the on-chain logic: the config carries the master enable flag;
 * the tier sets the discount level; the creator rebate is a per-mint zero-out
 * scalar applied last.
 */
export function projectMintFee(
  params: ProjectMintFeeParams,
): ProjectedMintFee {
  const {
    amountMicros,
    configMintFeeBps,
    userMintVolume30dMicros,
    creatorRebateApplies,
    configCreatorRebateBps,
  } = params;

  const tier = tierForVolume(userMintVolume30dMicros);
  const tierFeeBps = feeBpsForTier(tier);

  if (configMintFeeBps === 0) {
    return {
      tier,
      tierFeeBps,
      effectiveFeeBps: 0,
      feeMicros: 0n,
      totalCostMicros: amountMicros,
      countsTowardVolume: !creatorRebateApplies,
    };
  }

  const rebateBps = creatorRebateApplies ? configCreatorRebateBps : 0;
  const rebateRemainder = FEE_BPS_DENOMINATOR - rebateBps;
  const effectiveFeeBps = Math.floor(
    (tierFeeBps * rebateRemainder) / FEE_BPS_DENOMINATOR,
  );

  const feeMicros = bnMulDiv(
    amountMicros,
    BigInt(effectiveFeeBps),
    BigInt(FEE_BPS_DENOMINATOR),
  );

  return {
    tier,
    tierFeeBps,
    effectiveFeeBps,
    feeMicros,
    totalCostMicros: amountMicros + feeMicros,
    countsTowardVolume: !creatorRebateApplies,
  };
}

/** Safe a*b/c for bigint — guards against the intermediate overflow JS doesn't have. */
function bnMulDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new Error("bnMulDiv: divisor is zero.");
  return (a * b) / c;
}

/**
 * Anchor-friendly variant: returns BN instead of bigint so callers can drop
 * it straight into `program.methods.mintPair(...)` if they want to pass the
 * fee-adjusted total as a separate arg (the on-chain ix only needs the pair
 * amount, but the helper is useful for sizing-input math elsewhere).
 */
export function projectedTotalAsBn(p: ProjectedMintFee): BN {
  return new BN(p.totalCostMicros.toString());
}
