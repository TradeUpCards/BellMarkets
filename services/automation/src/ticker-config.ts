// Per-ticker `TickerConfig` constants + types per DR-005 + DR-006.
//
// On-chain shape (Aria, when she lands `update_ticker_config`):
//   pub struct TickerConfig {
//       pub cap_center: i64,                       // current spot anchor, Pyth-expo scaled
//       pub allowed_strikes: [i64; N],             // unique sorted; tick_size-aligned
//       pub allowed_strikes_count: u8,
//       pub max_user_strike_deviation_bps: u16,
//       pub strike_tick_size: u64,                 // smallest USD increment
//       pub threshold_bps: u16,                    // wild-swing trigger
//       pub last_updated_slot: u64,
//       pub updated_by_phase: u8,                  // 0=anchor 1=ah 2=pm 3=earnings-pre 4=earnings-restore
//       pub bump: u8,
//   }
//
// PDA seeds (proposed; final design Aria's call):
//   seeds = [b"ticker_config", pyth_feed.key().as_ref()]
//
// Off-chain TS uses human-readable USD (number) for strikes / cap_center;
// the on-chain ix wrapper handles the i64 scaling via Pyth expo.
//
// DR-005 + DR-006 reference tables — single source of truth in this file.

import type { Ticker } from "./types.js";

export type PhaseLabel = "anchor" | "ah" | "pm" | "earnings-pre" | "earnings-restore";

/**
 * Per-ticker defaults from DR-005 (deviation cap + tick size) and DR-006
 * (wild-swing threshold).
 *
 * - `defaultDeviationCapBps`: max distance (in bps) from cap_center a user
 *   can spawn a strike. NVDA/META/TSLA = 30%; AMZN = 20%; AAPL/MSFT/GOOGL = 15%.
 * - `strikeTickSizeUsd`: smallest USD strike granularity. NVDA/META/TSLA = $5;
 *   AMZN = $2; AAPL/MSFT/GOOGL = $1.
 * - `wildSwingThresholdBps`: |spot - cap_center|/cap_center that triggers
 *   Phase 2/3 cap expansion. NVDA/META/TSLA = 8%; AMZN = 6%; AAPL/MSFT/GOOGL = 4%.
 *
 * Earnings-eve expansion magnitudes (used by DR-011, not directly by this
 * module) are listed in `earnings-calendar.ts`.
 */
export type TickerDefaults = {
  defaultDeviationCapBps: number;
  strikeTickSizeUsd: number;
  wildSwingThresholdBps: number;
};

export const TICKER_DEFAULTS: Record<Ticker, TickerDefaults> = {
  // High-volatility cohort
  NVDA: { defaultDeviationCapBps: 3000, strikeTickSizeUsd: 5, wildSwingThresholdBps: 800 },
  META: { defaultDeviationCapBps: 3000, strikeTickSizeUsd: 5, wildSwingThresholdBps: 800 },
  TSLA: { defaultDeviationCapBps: 3000, strikeTickSizeUsd: 5, wildSwingThresholdBps: 800 },
  // Mid-volatility
  AMZN: { defaultDeviationCapBps: 2000, strikeTickSizeUsd: 2, wildSwingThresholdBps: 600 },
  // Low-volatility cohort
  AAPL: { defaultDeviationCapBps: 1500, strikeTickSizeUsd: 1, wildSwingThresholdBps: 400 },
  MSFT: { defaultDeviationCapBps: 1500, strikeTickSizeUsd: 1, wildSwingThresholdBps: 400 },
  GOOGL: { defaultDeviationCapBps: 1500, strikeTickSizeUsd: 1, wildSwingThresholdBps: 400 },
};

/** Off-chain view of the on-chain TickerConfig PDA. All numeric fields are
 * human-readable USD (not Pyth-expo-scaled).  */
export type TickerConfigView = {
  ticker: Ticker;
  capCenter: number;
  allowedStrikes: number[];
  deviationCapBps: number;
  tickSizeUsd: number;
  thresholdBps: number;
  updatedByPhase: PhaseLabel;
};

// ---------------------------------------------------------------------------
// Strike-grid helper
// ---------------------------------------------------------------------------

/**
 * Snap a USD value down to the nearest multiple of `tickSize`.
 * Matches `roundToNearest` semantics in `strike-calc.ts` but parameterized
 * on tick size rather than locked at $10. Half-away-from-zero rounding.
 */
export function roundToTick(valueUsd: number, tickSize: number): number {
  if (!(tickSize > 0)) throw new Error(`roundToTick: tickSize must be positive (got ${tickSize})`);
  if (!Number.isFinite(valueUsd)) throw new Error(`roundToTick: valueUsd must be finite (got ${valueUsd})`);
  return Math.round(valueUsd / tickSize) * tickSize;
}

/**
 * Compute the DR-005/DR-006 strike grid for a given (capCenter, tickSize):
 * ATM ± 3%, ± 6%, ± 9% of capCenter, rounded to tickSize, plus the rounded
 * capCenter itself as the 7th "ATM" strike. Deduped and sorted ascending.
 *
 * This is the same shape as strike-calc.ts `computeStrikesForStock` but
 * parameterized so the per-ticker `strikeTickSizeUsd` from `TICKER_DEFAULTS`
 * can be honored ($1 for AAPL/MSFT/GOOGL, $2 for AMZN, $5 for NVDA/META/TSLA).
 *
 *   capCenter $610, tickSize $5 → [555, 575, 590, 610, 630, 645, 665] (post-dedup)
 *   capCenter $230, tickSize $1 → [209, 216, 223, 230, 237, 244, 251] (no dedup at $1 tick)
 *   capCenter $437, tickSize $2 → [398, 410, 424, 438, 450, 464, 476]
 */
export function computeStrikeGrid(capCenter: number, tickSize: number): number[] {
  if (!Number.isFinite(capCenter) || capCenter <= 0) {
    throw new Error(`computeStrikeGrid: capCenter must be positive finite (got ${capCenter})`);
  }
  const offsets = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09];
  const candidates = offsets.map((off) => roundToTick(capCenter * (1 + off), tickSize));
  candidates.push(roundToTick(capCenter, tickSize));
  const unique = Array.from(new Set(candidates.filter((s) => s > 0))).sort((a, b) => a - b);
  return unique;
}

/**
 * Returns the absolute drift between `spot` and `capCenter`, expressed in
 * basis points (1 bp = 0.01%). Used by Phase 2 / Phase 3 wild-swing detector.
 *   driftBps(610, 600) = 167  (drift of ~1.67%)
 *   driftBps(550, 600) = 833  (drift of ~8.33%)
 */
export function driftBps(spot: number, capCenter: number): number {
  if (!(capCenter > 0)) throw new Error(`driftBps: capCenter must be positive (got ${capCenter})`);
  return Math.round((Math.abs(spot - capCenter) / capCenter) * 10_000);
}

/**
 * For a Phase 2/3 wild-swing trigger, build the EXPANDED strike grid: the
 * fresh grid around the new spot, UNIONED with the previously-allowed strikes
 * (so users with existing positions in the old strikes are not stranded —
 * their strike doesn't vanish from `allowed_strikes` mid-trading-cycle).
 */
export function expandedStrikeGrid(
  newSpot: number,
  tickSize: number,
  existingStrikes: readonly number[],
): number[] {
  const fresh = computeStrikeGrid(newSpot, tickSize);
  const merged = new Set([...existingStrikes, ...fresh]);
  return [...merged].filter((s) => s > 0).sort((a, b) => a - b);
}

/**
 * Maps the phase label to the on-chain u8 enum value. Mirrors the proposed
 * Aria-side encoding; if Aria picks different ordinals we update here in
 * one place.
 */
export function phaseLabelToOnChainCode(phase: PhaseLabel): number {
  switch (phase) {
    case "anchor":
      return 0;
    case "ah":
      return 1;
    case "pm":
      return 2;
    case "earnings-pre":
      return 3;
    case "earnings-restore":
      return 4;
  }
}
