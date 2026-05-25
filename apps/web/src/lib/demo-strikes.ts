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

export const DEMO_LIVE_STRIKE: Record<string, number> = {
  META: 610,
  NVDA: 215,
  AAPL: 309,
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
 * ticker. Today: a single live strike per seeded ticker. When Bram
 * re-seeds with multiple strikes per ticker, just extend the map values
 * to arrays.
 *
 * Returns `null` for tickers without a live strike — caller falls back
 * to the mockup STRIKES range so the visual hierarchy stays intact (the
 * disable banner does the rest).
 */
export function liveStrikesForTicker(sym: string): number[] | null {
  const s = DEMO_LIVE_STRIKE[sym.toUpperCase()];
  return s !== undefined ? [s] : null;
}

/** Default destination for the main nav "Trade" link + bottom tab. */
export const DEFAULT_TRADE_ROUTE = `/trade/META/${DEMO_LIVE_STRIKE.META}`;
