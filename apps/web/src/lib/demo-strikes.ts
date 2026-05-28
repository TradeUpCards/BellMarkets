/**
 * Canonical map of Bram's seeded live strikes on devnet (Path B / bUSDC).
 *
 * Source: `services/automation/scripts/seed-demo-liquidity.ts` output.
 * Last refreshed: 2026-05-28 — re-seeded at deploy_index=9 / 341-byte
 * StrikeMarket schema (DR-020) after the earlier 333-byte legacy entries
 * stopped decoding against the current IDL.
 *
 * Adding new live strikes:
 *   1. Run `pnpm --filter @bell-markets/automation seed-demo-liquidity
 *      --tickers <T1,T2,...> --expiry-days <N>`
 *   2. Append the resulting `(ticker, strike, marketPda)` tuples to
 *      DEMO_STRIKE_MARKETS below.
 *   3. Update DEMO_LIVE_STRIKE if the ATM strike for any ticker changes.
 *   4. Verify with `pnpm --filter @bell-markets/automation tsx
 *      scripts/verify-demo-registry.ts` (all 21 should decode).
 *
 * Re-import this module from every link-emitting surface (landing matrix,
 * left rail, trade-page strike pills, header nav, mobile bottom tabs)
 * so the live-strike list is one place to update when Bram re-seeds.
 */

/**
 * ATM strike (the `+0%` offset row in `coordination/demo-strikes.md`) per
 * ticker. Used by the rail accordion + hero CTA to pick a sensible default
 * landing strike. Full 3-strike-per-ticker list lives in
 * `DEMO_STRIKE_MARKETS` below.
 */
export const DEMO_LIVE_STRIKE: Record<string, number> = {
  META: 639,
  NVDA: 212,
  AAPL: 311,
  MSFT: 424,
  GOOGL: 385,
  AMZN: 269,
  TSLA: 440,
};

/**
 * Ticker considered "live" if Bram seeded it. Other tickers in the
 * mockup display fine, but clicking through to them shows the disable
 * banner. The hero CTA + main nav default to META.
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
 * META → [620, 639, 658]). Use `DEMO_STRIKE_MARKETS` as the source of
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
 * Source: `services/automation/scripts/seed-demo-liquidity.ts` output
 * captured on 2026-05-28 (post DR-020 / deploy_index=9 reseed).
 *
 * Why a PDA map (not a Pyth-feed map): Bram's current seed uses SOL/USD as
 * the `underlying_pyth_feed` for all 3 strikes (Pyth devnet doesn't have
 * MAG7 feeds), so feed-based grouping collapses everything into one group.
 * The PDA map is deterministic and survives until Pyth devnet adds real
 * MAG7 feeds (post-v1). Append new strikes as Bram seeds them.
 *
 * `spot` is a display-only snapshot from the seed run — the live value
 * comes from `/api/spot/[ticker]` (Bram's Pyth Hermes proxy). This field
 * is the fallback shown when the live fetch hasn't resolved yet.
 */
export interface DemoStrikeMarket {
  ticker: string;
  /** Display spot for the underlying — used by the matrix row + trade
   *  page header. Live source is /api/spot/<ticker> (Pyth Hermes). */
  spot: number;
  /** Strike price in whole-dollar units (matches what the URL carries). */
  strike: number;
  /** StrikeMarket PDA on devnet — the canonical key. */
  marketPda: string;
}

export const DEMO_STRIKE_MARKETS: DemoStrikeMarket[] = [
  // META — spot $638.99 (2026-05-28)
  { ticker: "META", spot: 638.99, strike: 620, marketPda: "C41aovnZA7moEBG1HhJ8FgGsvvxf2GB8GFbrzWV4qFM5" },
  { ticker: "META", spot: 638.99, strike: 639, marketPda: "B2CMJyfnecBw94fHiLyZN9TcHKwzQJfnTQqMvzoNrPA7" },
  { ticker: "META", spot: 638.99, strike: 658, marketPda: "6FobRfJCwhZhFwouEvbcgVh8fznLWQqfUdhhEJNVhXhf" },
  // NVDA — spot $212.32 (2026-05-28)
  { ticker: "NVDA", spot: 212.32, strike: 206, marketPda: "ZTc4MEWtCB784V6CBfYHTY28wfhvq5BCPe2wvyzW43w" },
  { ticker: "NVDA", spot: 212.32, strike: 212, marketPda: "BMSGx47bdwkvV2XQXQHYSfJh9d2sWmQ9UJhfAkNmaGT1" },
  { ticker: "NVDA", spot: 212.32, strike: 219, marketPda: "AFCjT9VEEGdJBVFSU76AVdrD7HYFohnNKU5chHGPXDRh" },
  // AAPL — spot $311.35 (2026-05-28)
  { ticker: "AAPL", spot: 311.35, strike: 302, marketPda: "861zTjh3DFb4Lo187qxQLdgsLCjJ8GD6XRn9f13E2WeE" },
  { ticker: "AAPL", spot: 311.35, strike: 311, marketPda: "68EFZBkPvTCg36vLLbANzPfK5o7bS3vatpD31tG8i7zC" },
  { ticker: "AAPL", spot: 311.35, strike: 321, marketPda: "8icim6Egkc6fg5teeFDpyFFGeuGur2Bbs8Vkca38yzq5" },
  // MSFT — spot $424.00 (2026-05-28)
  { ticker: "MSFT", spot: 424.00, strike: 411, marketPda: "GPMddZomEQWmHyU4TFHh4iYAFnHr6NbPTHFzqevGr5Dq" },
  { ticker: "MSFT", spot: 424.00, strike: 424, marketPda: "B3cedkevEYb7i4JAF4cHrkupxNDzhbwZSbF6zGL783HP" },
  { ticker: "MSFT", spot: 424.00, strike: 437, marketPda: "4ubXm1PynTZphSfpXwozep3sHdA49X7MQBARCAPqeC1b" },
  // GOOGL — spot $385.03 (2026-05-28)
  { ticker: "GOOGL", spot: 385.03, strike: 373, marketPda: "9qN2ABbu2hsW8c7twNysdo9LrWdXvSqPHGVu2HbATa9e" },
  { ticker: "GOOGL", spot: 385.03, strike: 385, marketPda: "FSPcu15UdcaXsPEn3Nh8oo4vGuUiZfMFA5tMHXxX4uc6" },
  { ticker: "GOOGL", spot: 385.03, strike: 397, marketPda: "J8qPMN3WpygdPsPphKwwTbnZ3zFn11TNoiPj7NgnBywX" },
  // AMZN — spot $269.16 (2026-05-28)
  { ticker: "AMZN", spot: 269.16, strike: 261, marketPda: "AUC4oZaJBM5Sz7FEr7v9bFP76xBffvugmLKwRbz9Safz" },
  { ticker: "AMZN", spot: 269.16, strike: 269, marketPda: "6gWrRyd144i8bwgLo4X9QR7NHJvdKe6RZ25fNkJqmk6v" },
  { ticker: "AMZN", spot: 269.16, strike: 277, marketPda: "5anQX2hxSMQ2PS33v77HXD846iLwcydUpuDP7ze1XMEs" },
  // TSLA — spot $440.35 (2026-05-28)
  { ticker: "TSLA", spot: 440.35, strike: 427, marketPda: "4JDNzJzhQSNscbH59NzDt97M6nsvdqBSxDw2VQCsNs3D" },
  { ticker: "TSLA", spot: 440.35, strike: 440, marketPda: "HkKTYj3DuDd6AxWfnVCMTacZLoWnDDaS9iJcTUSPHSCR" },
  { ticker: "TSLA", spot: 440.35, strike: 454, marketPda: "2EXiHiAt4VZsNHmdWBhsc1ZApEEjftDiy88eiapxRjg8" },
];

/** PDA → ticker (uppercase). Returns null when the market isn't in the
 *  registry — caller can fall back to "UNKNOWN" or hide the row. */
export function marketToTicker(pdaBase58: string): string | null {
  return (
    DEMO_STRIKE_MARKETS.find((m) => m.marketPda === pdaBase58)?.ticker ?? null
  );
}
