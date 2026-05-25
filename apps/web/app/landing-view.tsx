"use client";

/**
 * v8 landing — client view. Visual reference: `apps/web/public/mockups/v8-landing.html`.
 *
 * Scope per Tate's directive: hit the load-bearing sections — CNBC ticker
 * marquee → hero card → probability matrix → Leaderboard/Contests row →
 * Bell Pro / Recent Fills row → How it works. Skips the v8 left rail
 * (acceptable for v1 demo per the cut-if-short policy; left rail is a
 * navigation enhancement, not a load-bearing surface).
 */

import { useState } from "react";
import Link from "next/link";
import { useBellProSubscription, isBellProActive } from "@/hooks/use-bell-pro-subscription";

type MetricTab = "profit" | "streak" | "winrate";
type PeriodTab = "weekly" | "monthly";

const TICKERS = [
  { sym: "AAPL", spot: "$229.84", chg: "+0.54%", up: true },
  { sym: "MSFT", spot: "$441.62", chg: "+0.73%", up: true },
  { sym: "GOOGL", spot: "$184.27", chg: "−0.50%", up: false },
  { sym: "AMZN", spot: "$201.13", chg: "+0.20%", up: true },
  { sym: "NVDA", spot: "$1,342.71", chg: "+1.39%", up: true },
  { sym: "META", spot: "$679.84", chg: "+0.32%", up: true },
  { sym: "TSLA", spot: "$261.04", chg: "−0.70%", up: false },
];

// STATIC FIXTURE — wire to useAllMarkets() + useOrderBook() per row, post-MVP.
// (Strikes are real per-ticker shapes from the v8 mockup.)
const MATRIX_ROWS = [
  {
    sym: "META",
    spot: "$679.84",
    chg: "+0.32%",
    chgUp: true,
    cells: [
      { strike: "$620", prob: 92, cls: "p-95-100" },
      { strike: "$640", prob: 84, cls: "p-80-94" },
      { strike: "$660", prob: 71, cls: "p-60-79" },
      { strike: "$680", prob: 50, cls: "p-40-59 atm", atm: true },
      { strike: "$700", prob: 28, cls: "p-20-39" },
      { strike: "$720", prob: 14, cls: "p-5-19" },
      { strike: "$740", prob: 6, cls: "p-0-4" },
    ],
    vol: "$42,184",
    delta: "+18.2%",
    strikes: [620, 640, 660, 680, 700, 720, 740],
  },
  {
    sym: "NVDA",
    spot: "$1,342.71",
    chg: "+1.39%",
    chgUp: true,
    cells: [
      { strike: "$1,220", prob: 96, cls: "p-95-100" },
      { strike: "$1,260", prob: 88, cls: "p-80-94" },
      { strike: "$1,300", prob: 74, cls: "p-60-79" },
      { strike: "$1,340", prob: 52, cls: "p-40-59 atm", atm: true },
      { strike: "$1,380", prob: 31, cls: "p-20-39" },
      { strike: "$1,420", prob: 16, cls: "p-5-19" },
      { strike: "$1,460", prob: 7, cls: "p-0-4" },
    ],
    vol: "$61,892",
    delta: "+32.1%",
    strikes: [1220, 1260, 1300, 1340, 1380, 1420, 1460],
  },
  {
    sym: "AAPL",
    spot: "$229.84",
    chg: "+0.54%",
    chgUp: true,
    cells: [
      { strike: "$210", prob: 94, cls: "p-95-100" },
      { strike: "$220", prob: 78, cls: "p-60-79" },
      { strike: "$225", prob: 0, cls: "empty", empty: true },
      { strike: "$230", prob: 51, cls: "p-40-59 atm", atm: true },
      { strike: "$235", prob: 0, cls: "empty", empty: true },
      { strike: "$240", prob: 24, cls: "p-20-39" },
      { strike: "$250", prob: 9, cls: "p-5-19" },
    ],
    vol: "$28,743",
    delta: "+11.4%",
    strikes: [210, 220, 225, 230, 235, 240, 250],
  },
  {
    sym: "MSFT",
    spot: "$441.62",
    chg: "+0.73%",
    chgUp: true,
    cells: [
      { strike: "$400", prob: 95, cls: "p-95-100" },
      { strike: "$420", prob: 81, cls: "p-80-94" },
      { strike: "$430", prob: 0, cls: "empty", empty: true },
      { strike: "$440", prob: 54, cls: "p-40-59 atm", atm: true },
      { strike: "$450", prob: 0, cls: "empty", empty: true },
      { strike: "$460", prob: 27, cls: "p-20-39" },
      { strike: "$480", prob: 11, cls: "p-5-19" },
    ],
    vol: "$19,621",
    delta: "+8.7%",
    strikes: [400, 420, 430, 440, 450, 460, 480],
  },
  {
    sym: "GOOGL",
    spot: "$184.27",
    chg: "−0.50%",
    chgUp: false,
    cells: [
      { strike: "$170", prob: 91, cls: "p-95-100" },
      { strike: "$175", prob: 0, cls: "empty", empty: true },
      { strike: "$180", prob: 68, cls: "p-60-79" },
      { strike: "$184", prob: 50, cls: "p-40-59 atm", atm: true },
      { strike: "$190", prob: 36, cls: "p-20-39" },
      { strike: "$195", prob: 0, cls: "empty", empty: true },
      { strike: "$200", prob: 13, cls: "p-5-19" },
    ],
    vol: "$12,408",
    delta: "−3.2%",
    strikes: [170, 175, 180, 184, 190, 195, 200],
  },
  {
    sym: "AMZN",
    spot: "$201.13",
    chg: "+0.20%",
    chgUp: true,
    cells: [
      { strike: "$180", prob: 93, cls: "p-95-100" },
      { strike: "$190", prob: 76, cls: "p-60-79" },
      { strike: "$195", prob: 0, cls: "empty", empty: true },
      { strike: "$200", prob: 53, cls: "p-40-59 atm", atm: true },
      { strike: "$205", prob: 0, cls: "empty", empty: true },
      { strike: "$210", prob: 29, cls: "p-20-39" },
      { strike: "$220", prob: 12, cls: "p-5-19" },
    ],
    vol: "$16,237",
    delta: "+6.8%",
    strikes: [180, 190, 195, 200, 205, 210, 220],
  },
  {
    sym: "TSLA",
    spot: "$261.04",
    chg: "−0.70%",
    chgUp: false,
    cells: [
      { strike: "$240", prob: 85, cls: "p-80-94" },
      { strike: "$250", prob: 69, cls: "p-60-79" },
      { strike: "$255", prob: 0, cls: "empty", empty: true },
      { strike: "$260", prob: 48, cls: "p-40-59 atm", atm: true },
      { strike: "$265", prob: 0, cls: "empty", empty: true },
      { strike: "$270", prob: 26, cls: "p-20-39" },
      { strike: "$280", prob: 13, cls: "p-5-19" },
    ],
    vol: "$23,718",
    delta: "−5.4%",
    strikes: [240, 250, 255, 260, 265, 270, 280],
  },
];

// STATIC FIXTURE — wire to useLeaderboard() once Bram's indexer URL ships.
const LEADERS = [
  { rank: 1, rankCls: "gold", name: "degen.sol", avatar: "DG", profit: "+$2,847", trades: "47 · 32W 15L", winRate: "68%", streak: "9W" },
  { rank: 2, rankCls: "silver", name: "maxprob.eth", avatar: "MP", profit: "+$2,103", trades: "39 · 28W 11L", winRate: "72%", streak: "6W" },
  { rank: 3, rankCls: "bronze", name: "quantfox", avatar: "QF", profit: "+$1,876", trades: "62 · 38W 24L", winRate: "61%", streak: "4W" },
  { rank: 4, rankCls: "", name: "yotta.sol", avatar: "YS", profit: "+$1,452", trades: "29 · 22W 7L", winRate: "76%", streak: "7W" },
  { rank: 5, rankCls: "", name: "you", avatar: "YU", profit: "+$1,247", trades: "18 · 13W 5L", winRate: "72%", streak: "3W", isYou: true },
];

// STATIC FIXTURE — wire to a real fills feed (Helius webhook or program log subscription) post-MVP.
const FILLS = [
  { time: "14:46:31", market: "META.680", side: "BUY", price: "$0.520", size: 200 },
  { time: "14:46:18", market: "NVDA.1340", side: "SELL", price: "$0.485", size: 125 },
  { time: "14:46:11", market: "META.680", side: "SELL", price: "$0.480", size: 500 },
  { time: "14:45:54", market: "AAPL.230", side: "BUY", price: "$0.420", size: 100 },
  { time: "14:45:32", market: "META.680", side: "BUY", price: "$0.510", size: 75 },
  { time: "14:45:08", market: "META.680", side: "SELL", price: "$0.500", size: 320 },
  { time: "14:44:51", market: "NVDA.1340", side: "BUY", price: "$0.518", size: 180 },
  { time: "14:44:33", market: "META.680", side: "SELL", price: "$0.490", size: 450 },
];

export function LandingView() {
  const [period, setPeriod] = useState<PeriodTab>("weekly");
  const [metric, setMetric] = useState<MetricTab>("profit");
  const { data: sub } = useBellProSubscription();
  const proActive = isBellProActive(sub);

  return (
    <>
      {/* CNBC TICKER MARQUEE */}
      <div className="ticker-marquee" aria-label="Live ticker scroll">
        <div className="ticker-track">
          {[...TICKERS, ...TICKERS].map((t, i) => (
            <div className="tm-item" key={i}>
              <span className="tm-sym">{t.sym}</span>
              <span>{t.spot}</span>
              <span className={`tm-chg ${t.up ? "up" : "down"}`}>{t.chg}</span>
            </div>
          ))}
        </div>
      </div>

      <main>
        {/* HERO */}
        <div className="hero-grid">
          <div className="carousel">
            <div className="carousel-slides">
              <div className="carousel-slide" data-slide="markets">
                <div className="hero-card">
                  <div className="hero-eyebrow">Bell.Markets · MAG7 daily binaries</div>
                  <div className="hero-title">
                    Daily binary outcomes on the names you watch
                  </div>
                  <div className="hero-sub">
                    Pick a strike. Pick YES or NO. $1 bUSDC payouts settled
                    on-chain by Pyth at 4 PM ET. Non-custodial — you never
                    hand over a key.
                  </div>
                  <div className="hero-cta-row">
                    <Link href="/trade/META/680" className="hero-cta primary">
                      Open trade panel →
                    </Link>
                    <Link href="#matrix" className="hero-cta secondary">
                      See all 49 markets
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Session block */}
          <div className="session-block">
            <div className="session-block-h">
              <span className="eyebrow">Session</span>
              <span className="session-state mono">OPEN · 14:46 ET</span>
            </div>
            <div className="session-grid">
              <div className="session-cell">
                <span className="lbl">Settle</span>
                <span className="val mono accent">02:13:47</span>
              </div>
              <div className="session-cell">
                <span className="lbl">Markets</span>
                <span className="val mono">49 open</span>
              </div>
              <div className="session-cell">
                <span className="lbl">Volume 24h</span>
                <span className="val mono">$204,603</span>
              </div>
              <div className="session-cell">
                <span className="lbl">Cluster</span>
                <span className="val mono">DEVNET</span>
              </div>
            </div>
          </div>
        </div>

        {/* PROBABILITY MATRIX */}
        <div className="matrix-card" id="matrix">
          <div className="matrix-h">
            <h3>
              YES Probability Matrix <span className="badge">49 markets</span>
            </h3>
          </div>
          <div className="matrix-grid">
            <div className="matrix-thead">
              <div>Ticker</div>
              <div>Spot</div>
              <div>−9%</div>
              <div>−6%</div>
              <div>−3%</div>
              <div>ATM</div>
              <div>+3%</div>
              <div>+6%</div>
              <div>+9%</div>
              <div>Vol 24h</div>
              <div />
            </div>

            {MATRIX_ROWS.map((row) => (
              <Link key={row.sym} className="matrix-row" href={`/trade/${row.sym}/${row.strikes[3]}`}>
                <div className="matrix-ticker">
                  <span className="matrix-ticker-mark">{row.sym.slice(0, 1)}</span>
                  {row.sym}
                </div>
                <div className="matrix-spot mono">
                  <span className="px">{row.spot}</span>
                  <span className={`chg ${row.chgUp ? "up" : "down"}`}>{row.chg}</span>
                </div>
                {row.cells.map((c, ci) => (
                  <div key={ci} className={`prob-cell ${c.cls}`}>
                    <span className="strike">{c.strike}</span>
                    <span className="prob">{c.empty ? "—" : `${c.prob}%`}</span>
                  </div>
                ))}
                <div className="matrix-vol mono">
                  {row.vol}
                  <span className="delta">{row.delta}</span>
                </div>
                <div className="matrix-action">
                  <button type="button">OPEN →</button>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* LEADERBOARD + CONTESTS */}
        <div className="row-2col">
          <div className="half-section">
            <div className="section-h-block compact">
              <h2>
                <span className="eyebrow">Leaderboard</span> Top traders
              </h2>
              <Link href="/leaderboard" className="link">All →</Link>
            </div>
            <div className="lb-tabs">
              <div className="lb-tab-group period" role="tablist">
                {(["weekly", "monthly"] as const).map((p) => (
                  <button
                    key={p}
                    className={`lb-tab${period === p ? " active" : ""}`}
                    onClick={() => setPeriod(p)}
                    type="button"
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              <div className="lb-tab-group metric" role="tablist">
                {(["profit", "streak", "winrate"] as const).map((m) => (
                  <button
                    key={m}
                    className={`lb-tab${metric === m ? " active" : ""}`}
                    onClick={() => setMetric(m)}
                    type="button"
                  >
                    {m === "profit" ? "Profit" : m === "streak" ? "Win Streak" : "Win Rate"}
                  </button>
                ))}
              </div>
            </div>
            <div className="lb-period-meta">
              <span className="lb-period-state mono">{period === "weekly" ? "Weekly · 2d 14h left" : "Monthly · 8d left"}</span>
              <span className="lb-pool mono">${period === "weekly" ? "1,800" : "12,500"} pool</span>
            </div>
            <div className="leaderboard-card half-card">
              {LEADERS.map((u) => (
                <div
                  key={u.rank}
                  className="lb-row-item"
                  style={u.isYou ? { background: "rgba(34, 211, 238, 0.05)" } : undefined}
                >
                  <span className={`rank ${u.rankCls} mono`}>#{u.rank}</span>
                  <div className="lb-user-block">
                    <span className="lb-avatar">{u.avatar}</span>
                    <div>
                      <div className="lb-name" style={u.isYou ? { color: "var(--accent)" } : undefined}>
                        {u.name}
                      </div>
                      <div className="lb-meta mono">{u.trades} · winrate {u.winRate}</div>
                    </div>
                  </div>
                  <span className="lb-metric mono">
                    {metric === "profit" ? u.profit : metric === "streak" ? u.streak : u.winRate}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="half-section">
            <div className="section-h-block compact">
              <h2>
                <span className="eyebrow">Contests</span> Live pools
              </h2>
              <Link href="/leaderboard" className="link">All →</Link>
            </div>
            <div className="contest-list">
              <div className="contest-card half-card">
                <div className="contest-h">
                  <div className="contest-title">NVDA Earnings Surge</div>
                  <span className="contest-status mono">3d left</span>
                </div>
                <div className="contest-pool mono">$3,400 bUSDC prize pool</div>
                <div className="contest-meta">
                  <span>187 entries</span>
                  <button type="button" className="link">join →</button>
                </div>
              </div>
              <div className="contest-card half-card">
                <div className="contest-h">
                  <div className="contest-title">May Top-10</div>
                  <span className="contest-status mono">8d left</span>
                </div>
                <div className="contest-pool mono">$12,500 bUSDC prize pool</div>
                <div className="contest-meta">
                  <span>You · #5</span>
                  <button type="button" className="link">view →</button>
                </div>
              </div>
              <div className="contest-card half-card">
                <div className="contest-h">
                  <div className="contest-title">Daily Sharpshooter</div>
                  <span className="contest-status mono">14h left</span>
                </div>
                <div className="contest-pool mono">$420 bUSDC prize pool</div>
                <div className="contest-meta">
                  <span>42 entries</span>
                  <button type="button" className="link">join →</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* BELL PRO + RECENT FILLS */}
        <div className="row-2col">
          <div className="half-section">
            <div className="section-h-block compact">
              <h2>
                <span className="eyebrow">✦ Bell Pro</span> AI briefings + analytics
              </h2>
              <span className="link mono">{proActive ? "Active" : "$9 / mo"}</span>
            </div>
            <div className="bellpro-card half-card">
              <div className="bellpro-bullets">
                <div className="bellpro-bullet">
                  <span className="bullet-mark">→</span>
                  Daily AI briefings on the 7 MAG7 names — earnings, options
                  flow, recent news.
                </div>
                <div className="bellpro-bullet">
                  <span className="bullet-mark">→</span>
                  Bell Sense — surface markets where your size+conviction
                  outperforms the crowd.
                </div>
                <div className="bellpro-bullet">
                  <span className="bullet-mark">→</span>
                  Win-streak boosts + extra contest entries.
                </div>
                <div className="bellpro-bullet">
                  <span className="bullet-mark">→</span>
                  Priority support + custom Discord channel.
                </div>
              </div>
              <div className="bellpro-cta-row">
                {proActive ? (
                  <span className="hero-cta primary">You&apos;re Pro ✓</span>
                ) : (
                  <Link href="/settings#billing" className="hero-cta primary">
                    Upgrade · $9 / mo →
                  </Link>
                )}
                <span className="bellpro-disclaimer">
                  Information only. Not financial advice.
                </span>
              </div>
            </div>
          </div>

          <div className="half-section">
            <div className="section-h-block compact">
              <h2>
                <span className="eyebrow">Recent fills</span> Live tape
              </h2>
              <span className="link mono">{FILLS.length} shown</span>
            </div>
            <div className="recent-fills-card half-card">
              <div className="fills-rows-h">
                <div>time</div>
                <div>market</div>
                <div>side</div>
                <div>price</div>
                <div>size</div>
              </div>
              <div className="fills-scroll">
                {FILLS.map((f, i) => (
                  <div key={i} className="fill-row">
                    <span className="time mono">{f.time}</span>
                    <span className="mkt">{f.market}</span>
                    <span className={`side ${f.side.toLowerCase()}`}>{f.side}</span>
                    <span className={`price ${f.side === "BUY" ? "up" : "down"} mono`}>{f.price}</span>
                    <span className="size mono">{f.size}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* HOW IT WORKS */}
        <div className="how-section">
          <div className="section-h-block">
            <h2>
              <span className="eyebrow">How it works</span> Four steps from
              spot price to settled payout.
            </h2>
          </div>
          <div className="how-grid">
            <div className="how-step">
              <div className="how-step-num mono">01</div>
              <div className="how-step-title">Pick a market</div>
              <div className="how-step-body">
                One of 49 daily MAG7 strikes — pick a stock and a strike
                price. Strikes refresh every morning around the spot.
              </div>
            </div>
            <div className="how-step">
              <div className="how-step-num mono">02</div>
              <div className="how-step-title">Buy YES or NO</div>
              <div className="how-step-body">
                Each $1 bUSDC mints 1 YES + 1 NO contract. Trade the side you
                believe in; the other side is the opposite bet.
              </div>
            </div>
            <div className="how-step">
              <div className="how-step-num mono">03</div>
              <div className="how-step-title">Pyth settles at 4 PM</div>
              <div className="how-step-body">
                A permissionless `settle_market` call reads the official
                close price from Pyth and writes the outcome on-chain.
                Anyone can call it; the protocol pays.
              </div>
            </div>
            <div className="how-step">
              <div className="how-step-num mono">04</div>
              <div className="how-step-title">Redeem winners</div>
              <div className="how-step-body">
                Holders of the winning side burn their contracts for $1 bUSDC
                each. Losers expire worthless. Non-custodial throughout —
                you keep your keys.
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
