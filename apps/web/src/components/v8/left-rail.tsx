"use client";

/**
 * Shared left rail — used on the landing page AND the trade page so the
 * sidebar behavior is identical across surfaces. The only page-specific
 * variant is the "Filter matrix" section, which only makes sense on the
 * landing page (it filters the probability-matrix card); pass
 * `showFilters={false}` on the trade page to omit it.
 *
 * Reference: `public/mockups/v8-landing.html` lines 1827-2018 (the rail
 * spec). The mockup CSS classes live in `apps/web/app/v8-landing.css` and
 * are imported by both routes' `page.tsx`, so styling carries over.
 */

import type { CSSProperties } from "react";
import Link from "next/link";

// Canonical demo-strike map — single source of truth across LeftRail,
// landing matrix, trade-page strike pills, and header nav. See
// `apps/web/src/lib/demo-strikes.ts`.
import {
  DEMO_LIVE_STRIKE,
  DEMO_STRIKE_MARKETS,
} from "@/lib/demo-strikes";

interface RailStrike {
  px: number;
  label: string;
  prob: number;
  kind: "itm" | "atm" | "otm";
}
interface RailTicker {
  sym: string;
  mark: string;
  spot: string;
  chg: string;
  chgUp: boolean;
  vol: string;
  strikes: RailStrike[];
}

/**
 * Derive the rail accordion data from `DEMO_STRIKE_MARKETS` so every
 * strike click routes to a live on-chain market (Bram's seeded 3 strikes
 * per ticker: -3% / 0% / +3%). When Bram adds more strikes to the
 * registry, this list grows automatically — no per-ticker hand-coding.
 *
 * Strike `kind` (itm / atm / otm) drives the heatmap CSS class. Spot is
 * the latest seed value Bram published; chg + vol are placeholders until
 * Bram's indexer surfaces price + volume history (post-v1).
 */
const TICKER_MARKS: Record<string, string> = {
  META: "M", NVDA: "N", AAPL: "A", MSFT: "M", GOOGL: "G", AMZN: "A", TSLA: "T",
};

const RAIL_TICKERS: RailTicker[] = (() => {
  const byTicker = new Map<string, typeof DEMO_STRIKE_MARKETS>();
  for (const m of DEMO_STRIKE_MARKETS) {
    const arr = byTicker.get(m.ticker) ?? [];
    arr.push(m);
    byTicker.set(m.ticker, arr);
  }
  return Array.from(byTicker.entries()).map(([ticker, markets]) => {
    const sorted = [...markets].sort((a, b) => a.strike - b.strike);
    const spot = sorted[0]?.spot ?? 0;
    const atm = DEMO_LIVE_STRIKE[ticker] ?? sorted[Math.floor(sorted.length / 2)]?.strike ?? 0;
    return {
      sym: ticker,
      mark: TICKER_MARKS[ticker] ?? ticker.slice(0, 1),
      spot: `$${spot.toFixed(2)}`,
      // chg + vol are placeholders until Bram's indexer surfaces real data.
      chg: "+0.00%",
      chgUp: true,
      vol: "—",
      strikes: sorted.map((m) => {
        const kind = m.strike < atm ? "itm" : m.strike > atm ? "otm" : "atm";
        const label = kind === "atm" ? `$${m.strike} ATM` : `$${m.strike}`;
        // Prob 50% is the honest pre-book heuristic (we don't poll order
        // books from the rail — that'd be 21 subscriptions for a nav
        // surface). Live midpoint shows on the trade page strike pills.
        return { px: m.strike, label, prob: 50, kind };
      }),
    };
  });
})();

const RAIL_POSITIONS = [
  { market: "META.680.YES", side: "5 contracts · entry $0.62", pnl: "−$0.50", down: true },
  { market: "NVDA.1340.NO", side: "3 contracts · entry $0.50", pnl: "−$0.06", down: true },
  { market: "AAPL.230.YES", side: "8 contracts · entry $0.42", pnl: "+$2.80", down: false },
];

/**
 * Stand-alone ticker accordion — same markup the left rail uses, but
 * extractable so the landing page can render it inline as the primary
 * market navigator on mobile (where the rail is hidden by CSS).
 *
 * The wrapping `<details className="rail-section">` keeps the section
 * header + collapse affordance consistent with the rail. Pass
 * `defaultOpen={false}` if you want the section collapsed by default
 * (e.g., when stacking multiple sections on a small viewport).
 */
export interface TickerAccordionProps {
  activeTicker?: string;
  defaultOpen?: boolean;
  /** Override the section title — defaults to "All tickers". */
  title?: string;
}

export function TickerAccordion({
  activeTicker,
  defaultOpen = true,
  title = "All tickers",
}: TickerAccordionProps) {
  return (
    <details className="rail-section" id="rail-tickers" open={defaultOpen}>
      <summary className="rail-section-h">
        <span className="rail-section-title">
          {title} <span className="count">{RAIL_TICKERS.length}</span>
        </span>
        <span className="rail-chevron" aria-hidden="true">▾</span>
      </summary>
      <div className="rail-section-body">
        <div className="rail-ticker-list">
          {RAIL_TICKERS.map((t) => {
            const isActive =
              !!activeTicker && t.sym === activeTicker.toUpperCase();
            return (
              <details
                key={t.sym}
                className={`ticker-accordion${isActive ? " active" : ""}`}
                open={isActive}
              >
                <summary className="ticker-accordion-head">
                  <span className="rail-ticker-mark">{t.mark}</span>
                  <span className="ticker-sym-block">
                    <span className="rail-ticker-sym">{t.sym}</span>
                    <span className="rail-ticker-spot">{t.spot}</span>
                  </span>
                  <span className="ticker-meta-block">
                    <span
                      className={`rail-ticker-chg ${t.chgUp ? "up" : "down"}`}
                    >
                      {t.chg}
                    </span>
                    <span className="rail-ticker-vol">{t.vol}</span>
                  </span>
                  <span className="ticker-chevron" aria-hidden="true">▾</span>
                </summary>
                <div className="ticker-strikes">
                  {t.strikes.map((s) => {
                    const isDemoTicker = DEMO_LIVE_STRIKE[t.sym] !== undefined;
                    const routeStrike =
                      isDemoTicker && s.kind === "atm"
                        ? DEMO_LIVE_STRIKE[t.sym]
                        : s.px;
                    return (
                      <Link
                        key={s.px}
                        className={`ticker-strike ${s.kind}`}
                        href={`/trade/${t.sym}/${routeStrike}`}
                      >
                        <span className="px">{s.label}</span>
                        <span className="prob">{s.prob}%</span>
                      </Link>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </details>
  );
}

export interface LeftRailProps {
  /** Highlight a specific ticker as the active one (e.g., the page's ticker on /trade). */
  activeTicker?: string;
  /** Show the "Filter matrix" section (landing-only). Default false. */
  showFilters?: boolean;
  /** Inline style override (e.g., to constrain height on the trade page). */
  style?: CSSProperties;
}

export function LeftRail({
  activeTicker,
  showFilters = false,
  style,
}: LeftRailProps) {
  return (
    <aside className="left-rail" style={style}>

      {showFilters && (
        <details className="rail-section" id="rail-filters" open>
          <summary className="rail-section-h">
            <span className="rail-section-title">
              Filter matrix <span className="count">49 markets</span>
            </span>
            <span className="rail-chevron" aria-hidden="true">▾</span>
          </summary>
          <div className="rail-section-body">
            <div className="rail-filters-help">
              Refines what shows in the probability matrix →
            </div>
            <div className="rail-filters">
              <button className="rail-filter active" title="Show all markets">
                All <span className="ct">49</span>
              </button>
              <button
                className="rail-filter"
                title="Markets within ±3% of current spot"
              >
                Near strike <span className="ct">14</span>
              </button>
              <button className="rail-filter" title="Highest 24h volume">
                High vol <span className="ct">5</span>
              </button>
              <button
                className="rail-filter"
                title="Markets where you hold positions"
              >
                My positions <span className="ct">3</span>
              </button>
              <button
                className="rail-filter"
                title="Markets you've starred"
              >
                Watchlist <span className="ct">0</span>
              </button>
            </div>
          </div>
        </details>
      )}

      <TickerAccordion activeTicker={activeTicker} />

      <div className="rail-section">
        <div className="rail-section-h">
          <span className="rail-section-title">
            My positions <span className="count">3</span>
          </span>
        </div>
        <div className="rail-watchlist" data-mock="true">
          {RAIL_POSITIONS.map((p) => (
            <div className="rail-position" key={p.market}>
              <div className="rail-position-info">
                <span className="rail-position-market">{p.market}</span>
                <span className="rail-position-side">{p.side}</span>
              </div>
              <span className={`rail-position-pnl ${p.down ? "down" : "up"}`}>
                {p.pnl}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="rail-section">
        <div className="rail-section-h">
          <span className="rail-section-title">
            Watchlist <span className="count">0</span>
          </span>
        </div>
        <div className="rail-watchlist-empty">
          ★ Star markets to track them here
        </div>
      </div>

    </aside>
  );
}
