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

// ── Demo strike overrides (Bram's Path B seed on devnet) ──────────────────
const DEMO_LIVE_STRIKE: Record<string, number> = {
  META: 610,
  NVDA: 215,
  AAPL: 309,
};

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

const RAIL_TICKERS: RailTicker[] = [
  {
    sym: "META", mark: "M", spot: "$679.84", chg: "+0.32%", chgUp: true, vol: "$42K",
    strikes: [
      { px: 620, label: "$620", prob: 92, kind: "itm" },
      { px: 640, label: "$640", prob: 84, kind: "itm" },
      { px: 660, label: "$660", prob: 71, kind: "itm" },
      { px: 680, label: "$680 ATM", prob: 50, kind: "atm" },
      { px: 700, label: "$700", prob: 28, kind: "otm" },
      { px: 720, label: "$720", prob: 14, kind: "otm" },
      { px: 740, label: "$740", prob: 6, kind: "otm" },
    ],
  },
  {
    sym: "NVDA", mark: "N", spot: "$1,342.71", chg: "+1.39%", chgUp: true, vol: "$62K",
    strikes: [
      { px: 1220, label: "$1,220", prob: 96, kind: "itm" },
      { px: 1260, label: "$1,260", prob: 88, kind: "itm" },
      { px: 1300, label: "$1,300", prob: 73, kind: "itm" },
      { px: 1340, label: "$1,340 ATM", prob: 50, kind: "atm" },
      { px: 1380, label: "$1,380", prob: 27, kind: "otm" },
      { px: 1420, label: "$1,420", prob: 12, kind: "otm" },
      { px: 1460, label: "$1,460", prob: 4, kind: "otm" },
    ],
  },
  {
    sym: "AAPL", mark: "A", spot: "$229.84", chg: "+0.54%", chgUp: true, vol: "$29K",
    strikes: [
      { px: 210, label: "$210", prob: 94, kind: "itm" },
      { px: 220, label: "$220", prob: 82, kind: "itm" },
      { px: 225, label: "$225", prob: 68, kind: "itm" },
      { px: 230, label: "$230 ATM", prob: 50, kind: "atm" },
      { px: 235, label: "$235", prob: 32, kind: "otm" },
      { px: 240, label: "$240", prob: 18, kind: "otm" },
      { px: 250, label: "$250", prob: 5, kind: "otm" },
    ],
  },
  {
    sym: "MSFT", mark: "M", spot: "$441.62", chg: "+0.73%", chgUp: true, vol: "$20K",
    strikes: [
      { px: 420, label: "$420", prob: 91, kind: "itm" },
      { px: 430, label: "$430", prob: 78, kind: "itm" },
      { px: 435, label: "$435", prob: 65, kind: "itm" },
      { px: 440, label: "$440 ATM", prob: 50, kind: "atm" },
      { px: 445, label: "$445", prob: 35, kind: "otm" },
      { px: 455, label: "$455", prob: 17, kind: "otm" },
      { px: 465, label: "$465", prob: 7, kind: "otm" },
    ],
  },
  {
    sym: "GOOGL", mark: "G", spot: "$184.27", chg: "−0.50%", chgUp: false, vol: "$12K",
    strikes: [
      { px: 170, label: "$170", prob: 93, kind: "itm" },
      { px: 175, label: "$175", prob: 81, kind: "itm" },
      { px: 180, label: "$180", prob: 66, kind: "itm" },
      { px: 185, label: "$185 ATM", prob: 50, kind: "atm" },
      { px: 190, label: "$190", prob: 30, kind: "otm" },
      { px: 195, label: "$195", prob: 15, kind: "otm" },
      { px: 200, label: "$200", prob: 5, kind: "otm" },
    ],
  },
  {
    sym: "AMZN", mark: "A", spot: "$201.13", chg: "+0.20%", chgUp: true, vol: "$16K",
    strikes: [
      { px: 185, label: "$185", prob: 92, kind: "itm" },
      { px: 190, label: "$190", prob: 80, kind: "itm" },
      { px: 195, label: "$195", prob: 66, kind: "itm" },
      { px: 200, label: "$200 ATM", prob: 50, kind: "atm" },
      { px: 205, label: "$205", prob: 32, kind: "otm" },
      { px: 210, label: "$210", prob: 17, kind: "otm" },
      { px: 220, label: "$220", prob: 6, kind: "otm" },
    ],
  },
  {
    sym: "TSLA", mark: "T", spot: "$261.04", chg: "−0.70%", chgUp: false, vol: "$24K",
    strikes: [
      { px: 240, label: "$240", prob: 91, kind: "itm" },
      { px: 250, label: "$250", prob: 79, kind: "itm" },
      { px: 255, label: "$255", prob: 65, kind: "itm" },
      { px: 260, label: "$260 ATM", prob: 50, kind: "atm" },
      { px: 265, label: "$265", prob: 35, kind: "otm" },
      { px: 275, label: "$275", prob: 19, kind: "otm" },
      { px: 285, label: "$285", prob: 7, kind: "otm" },
    ],
  },
];

const RAIL_POSITIONS = [
  { market: "META.680.YES", side: "5 contracts · entry $0.62", pnl: "−$0.50", down: true },
  { market: "NVDA.1340.NO", side: "3 contracts · entry $0.50", pnl: "−$0.06", down: true },
  { market: "AAPL.230.YES", side: "8 contracts · entry $0.42", pnl: "+$2.80", down: false },
];

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

      <details className="rail-section" id="rail-tickers" open>
        <summary className="rail-section-h">
          <span className="rail-section-title">
            All tickers <span className="count">7</span>
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
