/**
 * Canonical map of Bram's seeded live strikes on devnet (Path B / bUSDC).
 *
 * Source: `.project/bell-markets/coordination/demo-strikes.md` — these are
 * the StrikeMarket PDAs that have full bid + ask depth seeded for the
 * demo. Any UI surface that links into the trade page MUST route to one
 * of these strikes for the click to land on a live on-chain market;
 * other strike values produce the "No on-chain StrikeMarket" disable
 * banner (honest UX, but not what you want for a polished demo flow).
 *
 * Re-import this module from every link-emitting surface (landing matrix,
 * left rail, trade-page strike pills, header nav, mobile bottom tabs)
 * so the live-strike list is one place to update when Bram re-seeds.
 */

/**
 * ATM strike (the `0%` offset row in `coordination/demo-strikes.md`) per
 * ticker. Used by the rail accordion + hero CTA to pick a sensible default
 * landing strike. Full 3-strike-per-ticker list lives in
 * `DEMO_STRIKE_MARKETS` below.
 */
export const DEMO_LIVE_STRIKE: Record<string, number> = {
  META: 610,
  NVDA: 215,
  AAPL: 309,
  MSFT: 419,
  GOOGL: 379,
  AMZN: 267,
  TSLA: 426,
};

/**
 * Ticker considered "live" if Bram seeded it. Other tickers in the
 * mockup display fine, but clicking through to them shows the disable
 * banner. The hero CTA + main nav default to META.610.
 */
export function isLiveTicker(sym: string): boolean {
  return DEMO_LIVE_STRIKE[sym.toUpperCase()] !== undefined;
}

/**
 * Pick a strike for a route. If `sym` is a seeded demo ticker, returns
 * the seeded strike. Otherwise returns `fallback` (typically the row's
 * ATM strike from the mockup).
 */
export function navStrike(sym: string, fallback: number): number {
  return DEMO_LIVE_STRIKE[sym.toUpperCase()] ?? fallback;
}

/**
 * Strikes the trade page's strike-pill picker should render for a given
 * ticker. Returns ALL seeded strikes for the ticker, sorted asc (e.g.,
 * META → [592, 610, 629]). Use `DEMO_STRIKE_MARKETS` as the source of
 * truth — `useAllMarkets()` filtered by ticker is the runtime live
 * equivalent, but this helper provides a synchronous fallback (e.g.,
 * pre-network or when the on-chain matcher is mid-decode).
 *
 * Returns `null` for tickers without seeded strikes.
 */
export function liveStrikesForTicker(sym: string): number[] | null {
  const upper = sym.toUpperCase();
  const strikes = DEMO_STRIKE_MARKETS
    .filter((m) => m.ticker === upper)
    .map((m) => m.strike)
    .sort((a, b) => a - b);
  return strikes.length > 0 ? strikes : null;
}

/** Default destination for the main nav "Trade" link + bottom tab. */
export const DEFAULT_TRADE_ROUTE = `/trade/META/${DEMO_LIVE_STRIKE.META}`;

/**
 * Per-strike registry of Bram's seeded markets — explicit map from on-chain
 * StrikeMarket PDA to (ticker, spot, ATM strike). Used by the landing-page
 * matrix and trade-view strike rail to group live markets by ticker.
 *
 * Source: `.project/bell-markets/coordination/demo-strikes.md`.
 *
 * Why a PDA map (not a Pyth-feed map): Bram's current seed uses SOL/USD as
 * the `underlying_pyth_feed` for all 3 strikes (Pyth devnet doesn't have
 * MAG7 feeds), so feed-based grouping collapses everything into one group.
 * The PDA map is deterministic and survives until Pyth devnet adds real
 * MAG7 feeds (post-v1). Append new strikes as Bram seeds them.
 */
export interface DemoStrikeMarket {
  ticker: string;
  /** Display spot for the underlying — used by the matrix row + trade
   *  page header. Refreshed manually as the demo runs. */
  spot: number;
  /** Strike price in whole-dollar units (matches what the URL carries). */
  strike: number;
  /** StrikeMarket PDA on devnet — the canonical key. */
  marketPda: string;
}

export const DEMO_STRIKE_MARKETS: DemoStrikeMarket[] = [
  // META — spot $610.42
  { ticker: "META", spot: 610.42, strike: 592, marketPda: "4hLBQ4tRcqvdJ7DwSMh7D6qo8fWcAfx7bp2c5ne7XGh4" },
  { ticker: "META", spot: 610.42, strike: 610, marketPda: "4QL6a8c4G25hHYkEm2cp6RAz18fmKYqUey1bxkugttSN" },
  { ticker: "META", spot: 610.42, strike: 629, marketPda: "2Jh6jVsjzWG2QrQjjWFK2H1213N8jbfHeW4ZZAf4NKvh" },
  // NVDA — spot $215.35
  { ticker: "NVDA", spot: 215.35, strike: 209, marketPda: "EJib2HZ1Sar3czncfok5dgP24QnVZhiiUKHU6qTuqRpX" },
  { ticker: "NVDA", spot: 215.35, strike: 215, marketPda: "4ac1qFRXHbFRNcnABRHVknCaSVjrF2Qp4rnkS6zhezVA" },
  { ticker: "NVDA", spot: 215.35, strike: 222, marketPda: "EaWQzkZ6XUsb3ehCr54cNTsRodKLikRCmebC4qxj9kfp" },
  // AAPL — spot $308.88
  { ticker: "AAPL", spot: 308.88, strike: 300, marketPda: "HW9DRUj9bM3NnATY1khEwidBTDpssq4uZwzD5DAeJ4Vt" },
  { ticker: "AAPL", spot: 308.88, strike: 309, marketPda: "3Wi3jEB2dsdbCHGZrE34SGuKcoGkY7bpe6N4EXFTHVwr" },
  { ticker: "AAPL", spot: 308.88, strike: 318, marketPda: "FeBW6NYWujNecdL6YrNbiaNtQ4dGsWrscn9e69jY7akm" },
  // MSFT — spot $418.60
  { ticker: "MSFT", spot: 418.60, strike: 406, marketPda: "He3PrshcBBbsjBf8vT6tMEa6BPRfr8KgafAvm8zmza6P" },
  { ticker: "MSFT", spot: 418.60, strike: 419, marketPda: "LnpzzTp2vvD4RRYCQJkJoFxJ1TLqMXiJSEnm6PEpdLu" },
  { ticker: "MSFT", spot: 418.60, strike: 431, marketPda: "2uZ7hjd9mwcepQk73RrK5G1Mr8b9ZiVugXAuBs2Y5nDc" },
  // GOOGL — spot $379.28
  { ticker: "GOOGL", spot: 379.28, strike: 368, marketPda: "2EpRjC6iak27epcwjQuXV6Gsn9Mxd3oqE7sh234J8FEu" },
  { ticker: "GOOGL", spot: 379.28, strike: 379, marketPda: "2vessd9iDJ3fStY3s7P7sZt7FYcFcYmtdnERLLT7Dpsq" },
  { ticker: "GOOGL", spot: 379.28, strike: 391, marketPda: "6XjT324AyDYoW77xCEKSmruFZDWy1oL1iH3VqGm8GZtG" },
  // AMZN — spot $266.54
  { ticker: "AMZN", spot: 266.54, strike: 259, marketPda: "HPo5En5kN5PoJ7jQz2xPYkuFJDnbwcham6uanC2HpDcW" },
  { ticker: "AMZN", spot: 266.54, strike: 267, marketPda: "J1qxamiR4Hw32qwpAmMXcgdSQdUM8WJ3E2dL8nC7fwkR" },
  { ticker: "AMZN", spot: 266.54, strike: 275, marketPda: "24EoQ6ALTcsNsLGaX8LpuDAYdQ7ZvhaheNhpmuXv7KvZ" },
  // TSLA — spot $425.91
  { ticker: "TSLA", spot: 425.91, strike: 413, marketPda: "2LWfuMbnwxeak5ECB9EaH2BwaVuNdngzisu1xt1jkvpn" },
  { ticker: "TSLA", spot: 425.91, strike: 426, marketPda: "6jMurJM43btuiMSJ1eRrWwN7yvudcJRVhFVc7CfzUGg2" },
  { ticker: "TSLA", spot: 425.91, strike: 439, marketPda: "4CLgZXMewaZhRktQjDWtukbhhP3CidMyw8iG3mM5P6vb" },
];

/** PDA → ticker (uppercase). Returns null when the market isn't in the
 *  registry — caller can fall back to "UNKNOWN" or hide the row. */
export function marketToTicker(pdaBase58: string): string | null {
  return (
    DEMO_STRIKE_MARKETS.find((m) => m.marketPda === pdaBase58)?.ticker ?? null
  );
}

