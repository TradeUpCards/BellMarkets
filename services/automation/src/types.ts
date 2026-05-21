// Types shared across the automation service. The shape of StrikeSet
// matches specs/architecture.md §4 (off-chain TypeScript types).

export type Ticker = "AAPL" | "MSFT" | "GOOGL" | "AMZN" | "NVDA" | "META" | "TSLA";

export const MAG7: readonly Ticker[] = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

export type StrikeSet = {
  ticker: Ticker;
  previousClose: number; // human-readable USDC (e.g., 680 for $680)
  strikes: number[]; // unique strikes after dedup, rounded to nearest $10, sorted ascending
};

// Strike-calc tuning constants. Locked at the values the PRD specifies
// ("Strike Selection" section: ±3%, ±6%, ±9%, round to $10). Changing
// these is a coordination event — flag in handoff before editing.
export const STRIKE_PERCENT_OFFSETS = [-0.09, -0.06, -0.03, 0.03, 0.06, 0.09] as const;
export const STRIKE_ROUNDING_USD = 10;
