// Deterministic strike calculation per the PRD ("Strike Selection" section)
// and specs/architecture.md §4. Pure function — no IO, no Date, no env reads.
// Same input → same output, every time. Suitable for unit testing.
//
// Algorithm:
//   1. Read previous closing price (caller supplies it).
//   2. Generate strikes at ±3%, ±6%, ±9% from previous close.
//   3. Round each to the nearest $10.
//   4. Include the rounded previous close itself as an additional (7th) strike.
//   5. Deduplicate and sort ascending.
//
// Worked examples (verified against the PRD):
//   META, prev close $680 →
//     ±3% = 700, 660; ±6% = 720, 640; ±9% = 740, 620; close = 680
//     → [620, 640, 660, 680, 700, 720, 740]    (7 unique)
//
//   AAPL, prev close $230 →
//     ±3% = 237 → 240, 223 → 220; ±6% = 244 → 240, 216 → 220;
//     ±9% = 251 → 250, 209 → 210; close = 230
//     → [210, 220, 230, 240, 250]               (5 unique after dedup)

import { STRIKE_PERCENT_OFFSETS, STRIKE_ROUNDING_USD, type StrikeSet, type Ticker } from "./types.js";

export function roundToNearest(value: number, step: number): number {
  if (step <= 0) throw new Error(`step must be positive (got ${step})`);
  // Use banker-safe rounding: scale → round → unscale. Math.round in JS
  // rounds half-away-from-zero; that matches the PRD examples (e.g.,
  // $216.20 → $220 and $223.10 → $220).
  return Math.round(value / step) * step;
}

export function computeStrikesForStock(previousClose: number): number[] {
  if (!Number.isFinite(previousClose) || previousClose <= 0) {
    throw new Error(`previousClose must be a positive finite number (got ${previousClose})`);
  }

  const candidates: number[] = STRIKE_PERCENT_OFFSETS.map((offset) =>
    roundToNearest(previousClose * (1 + offset), STRIKE_ROUNDING_USD),
  );
  candidates.push(roundToNearest(previousClose, STRIKE_ROUNDING_USD));

  // Drop any non-positive strikes (defensive: if previousClose were very
  // small, -9% could underflow once rounded). Then dedupe + sort ascending.
  const unique = Array.from(new Set(candidates.filter((s) => s > 0))).sort((a, b) => a - b);
  return unique;
}

export function buildStrikeSet(ticker: Ticker, previousClose: number): StrikeSet {
  return {
    ticker,
    previousClose,
    strikes: computeStrikesForStock(previousClose),
  };
}
