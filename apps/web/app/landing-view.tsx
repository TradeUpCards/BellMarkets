"use client";

/**
 * v8 landing — pixel-port from `public/mockups/v8-landing.html` (the spec).
 *
 * Major sections (matching mockup line ranges):
 *   - Left rail (mockup 1827-2018): filter chips + per-ticker accordion +
 *     positions + watchlist
 *   - Main:
 *     - CNBC ticker marquee (mockup 2023-2055)
 *     - Hero grid: 4-slide carousel + session block (mockup 2057-2179)
 *     - Probability matrix with DATA + VIEW toggles + cell-level clicks
 *       (mockup 2186-2383)
 *     - Row-2col: Leaderboard tabs + Contests filters (mockup 2385-2533)
 *     - Row-2col: Bell Pro live briefing + Recent Fills (mockup 2539-2600)
 *     - How it works (mockup 2604-2629)
 *
 * Per-row strike pills + matrix cells route to /trade/<TICKER>/<STRIKE>.
 * Demo strikes (Bram's Path B seed) override the mockup ATM strike per
 * DEMO_LIVE_STRIKE.
 *
 * Live data integrations:
 *   - Bell Pro briefing card → /api/briefings/AAPL (live Sonnet body).
 *   - Pro subscription state → useBellProSubscription / isBellProActive.
 *
 * STATIC FIXTURE sections (marked `data-mock` where rendered):
 *   - Leaderboard rows / Contests / Recent Fills tape: until Bram's
 *     indexer events land. Each labeled inline.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  useBellProSubscription,
  isBellProActive,
} from "@/hooks/use-bell-pro-subscription";

// ── Demo strike overrides (Bram's Path B seed on devnet) ───────────────────
const DEMO_LIVE_STRIKE: Record<string, number> = {
  META: 610,
  NVDA: 215,
  AAPL: 309,
};

function navStrike(sym: string, fallback: number): number {
  return DEMO_LIVE_STRIKE[sym] ?? fallback;
}

const BELL_PRO_DEFAULT_TICKER = "AAPL";

type LiveBriefing = {
  ticker: string;
  body: string;
  model: string;
  generatedAt: string;
};

type MetricTab = "profit" | "streak" | "winrate";
type PeriodTab = "weekly" | "monthly";
type ContestPeriod = "active" | "upcoming" | "ended";
type ContestType = "all" | "weekly" | "monthly" | "event";
type MatrixData = "yes" | "no" | "bidask" | "volume";
type MatrixView = "matrix" | "cards" | "list";

// ── STATIC FIXTURE: top-of-page CNBC marquee (mockup 2024-2054) ────────────
const TICKERS = [
  { sym: "AAPL", spot: "$229.84", chg: "+0.54%", up: true },
  { sym: "MSFT", spot: "$441.62", chg: "+0.73%", up: true },
  { sym: "GOOGL", spot: "$184.27", chg: "−0.50%", up: false },
  { sym: "AMZN", spot: "$201.13", chg: "+0.20%", up: true },
  { sym: "NVDA", spot: "$1,342.71", chg: "+1.39%", up: true },
  { sym: "META", spot: "$679.84", chg: "+0.32%", up: true },
  { sym: "TSLA", spot: "$261.04", chg: "−0.70%", up: false },
];

// ── STATIC FIXTURE: left-rail ticker accordion data (mockup 1854-1978) ────
interface RailTicker {
  sym: string;
  mark: string;
  spot: string;
  chg: string;
  chgUp: boolean;
  vol: string;
  strikes: { px: number; label: string; prob: number; kind: "itm" | "atm" | "otm" }[];
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

// ── STATIC FIXTURE: probability matrix (mockup 2228-2380) ─────────────────
interface MatrixCell {
  strike: number;
  label: string;
  prob: number;
  cls: string;
  atm?: boolean;
  empty?: boolean;
}
interface MatrixRow {
  sym: string;
  mark: string;
  spot: string;
  chg: string;
  chgUp: boolean;
  cells: MatrixCell[];
  vol: string;
  delta: string;
  deltaUp: boolean;
}

const MATRIX_ROWS: MatrixRow[] = [
  {
    sym: "META", mark: "M", spot: "$679.84", chg: "+0.32%", chgUp: true,
    cells: [
      { strike: 620, label: "$620", prob: 92, cls: "p-95-100" },
      { strike: 640, label: "$640", prob: 84, cls: "p-80-94" },
      { strike: 660, label: "$660", prob: 71, cls: "p-60-79" },
      { strike: 680, label: "$680", prob: 50, cls: "p-40-59 atm", atm: true },
      { strike: 700, label: "$700", prob: 28, cls: "p-20-39" },
      { strike: 720, label: "$720", prob: 14, cls: "p-5-19" },
      { strike: 740, label: "$740", prob: 6, cls: "p-0-4" },
    ],
    vol: "$42,184", delta: "+18.2%", deltaUp: true,
  },
  {
    sym: "NVDA", mark: "N", spot: "$1,342.71", chg: "+1.39%", chgUp: true,
    cells: [
      { strike: 1220, label: "$1,220", prob: 96, cls: "p-95-100" },
      { strike: 1260, label: "$1,260", prob: 88, cls: "p-80-94" },
      { strike: 1300, label: "$1,300", prob: 74, cls: "p-60-79" },
      { strike: 1340, label: "$1,340", prob: 52, cls: "p-40-59 atm", atm: true },
      { strike: 1380, label: "$1,380", prob: 31, cls: "p-20-39" },
      { strike: 1420, label: "$1,420", prob: 16, cls: "p-5-19" },
      { strike: 1460, label: "$1,460", prob: 7, cls: "p-0-4" },
    ],
    vol: "$61,892", delta: "+32.1%", deltaUp: true,
  },
  {
    sym: "AAPL", mark: "A", spot: "$229.84", chg: "+0.54%", chgUp: true,
    cells: [
      { strike: 210, label: "$210", prob: 94, cls: "p-95-100" },
      { strike: 220, label: "$220", prob: 78, cls: "p-60-79" },
      { strike: 225, label: "$225", prob: 0, cls: "empty", empty: true },
      { strike: 230, label: "$230", prob: 51, cls: "p-40-59 atm", atm: true },
      { strike: 235, label: "$235", prob: 0, cls: "empty", empty: true },
      { strike: 240, label: "$240", prob: 24, cls: "p-20-39" },
      { strike: 250, label: "$250", prob: 9, cls: "p-5-19" },
    ],
    vol: "$28,743", delta: "+11.4%", deltaUp: true,
  },
  {
    sym: "MSFT", mark: "M", spot: "$441.62", chg: "+0.73%", chgUp: true,
    cells: [
      { strike: 400, label: "$400", prob: 95, cls: "p-95-100" },
      { strike: 420, label: "$420", prob: 81, cls: "p-80-94" },
      { strike: 430, label: "$430", prob: 0, cls: "empty", empty: true },
      { strike: 440, label: "$440", prob: 54, cls: "p-40-59 atm", atm: true },
      { strike: 450, label: "$450", prob: 0, cls: "empty", empty: true },
      { strike: 460, label: "$460", prob: 27, cls: "p-20-39" },
      { strike: 480, label: "$480", prob: 11, cls: "p-5-19" },
    ],
    vol: "$19,621", delta: "+8.7%", deltaUp: true,
  },
  {
    sym: "GOOGL", mark: "G", spot: "$184.27", chg: "−0.50%", chgUp: false,
    cells: [
      { strike: 170, label: "$170", prob: 91, cls: "p-95-100" },
      { strike: 175, label: "$175", prob: 0, cls: "empty", empty: true },
      { strike: 180, label: "$180", prob: 68, cls: "p-60-79" },
      { strike: 184, label: "$184", prob: 50, cls: "p-40-59 atm", atm: true },
      { strike: 190, label: "$190", prob: 36, cls: "p-20-39" },
      { strike: 195, label: "$195", prob: 0, cls: "empty", empty: true },
      { strike: 200, label: "$200", prob: 13, cls: "p-5-19" },
    ],
    vol: "$12,408", delta: "−3.2%", deltaUp: false,
  },
  {
    sym: "AMZN", mark: "A", spot: "$201.13", chg: "+0.20%", chgUp: true,
    cells: [
      { strike: 180, label: "$180", prob: 93, cls: "p-95-100" },
      { strike: 190, label: "$190", prob: 76, cls: "p-60-79" },
      { strike: 195, label: "$195", prob: 0, cls: "empty", empty: true },
      { strike: 200, label: "$200", prob: 53, cls: "p-40-59 atm", atm: true },
      { strike: 205, label: "$205", prob: 0, cls: "empty", empty: true },
      { strike: 210, label: "$210", prob: 29, cls: "p-20-39" },
      { strike: 220, label: "$220", prob: 12, cls: "p-5-19" },
    ],
    vol: "$16,237", delta: "+6.8%", deltaUp: true,
  },
  {
    sym: "TSLA", mark: "T", spot: "$261.04", chg: "−0.70%", chgUp: false,
    cells: [
      { strike: 240, label: "$240", prob: 85, cls: "p-80-94" },
      { strike: 250, label: "$250", prob: 69, cls: "p-60-79" },
      { strike: 255, label: "$255", prob: 0, cls: "empty", empty: true },
      { strike: 260, label: "$260", prob: 48, cls: "p-40-59 atm", atm: true },
      { strike: 265, label: "$265", prob: 0, cls: "empty", empty: true },
      { strike: 270, label: "$270", prob: 26, cls: "p-20-39" },
      { strike: 280, label: "$280", prob: 13, cls: "p-5-19" },
    ],
    vol: "$23,718", delta: "−5.4%", deltaUp: false,
  },
];

// ── STATIC FIXTURE: positions / leaderboard / fills / contests ─────────────
const RAIL_POSITIONS = [
  { market: "META.680.YES", side: "5 contracts · entry $0.62", pnl: "−$0.50", down: true },
  { market: "NVDA.1340.NO", side: "3 contracts · entry $0.50", pnl: "−$0.06", down: true },
  { market: "AAPL.230.YES", side: "8 contracts · entry $0.42", pnl: "+$2.80", down: false },
];

const LEADERS = [
  { rank: 1, rankCls: "gold", name: "degen.sol", avatar: "DG", profit: "+$2,847", trades: "12W streak · 47 trades", winRate: "68%", streak: "12W" },
  { rank: 2, rankCls: "silver", name: "maxprob.eth", avatar: "MX", profit: "+$2,103", trades: "8W streak · 38 trades", winRate: "72%", streak: "8W" },
  { rank: 3, rankCls: "bronze", name: "quantfox", avatar: "QF", profit: "+$1,876", trades: "6W streak · 52 trades", winRate: "61%", streak: "6W" },
  { rank: 4, rankCls: "", name: "pythheaad", avatar: "PY", profit: "+$1,421", trades: "4W streak · 29 trades", winRate: "76%", streak: "4W" },
  { rank: 5, rankCls: "", name: "you", avatar: "CV", profit: "+$1,247", trades: "3W streak · 24 trades", winRate: "72%", streak: "3W", isYou: true },
  { rank: 6, rankCls: "", name: "frontrun.sol", avatar: "FR", profit: "+$1,087", trades: "2W streak · 31 trades", winRate: "65%", streak: "2W" },
];

const FILLS = [
  { time: "14:42:18", ticker: "META", strike: 680, side: "BUY YES", sideCls: "buy-yes", price: "0.520", size: "$200" },
  { time: "14:42:11", ticker: "NVDA", strike: 1340, side: "BUY NO", sideCls: "buy-no", price: "0.480", size: "$500" },
  { time: "14:41:54", ticker: "AAPL", strike: 230, side: "SELL YES", sideCls: "sell-yes", price: "0.520", size: "$100" },
  { time: "14:41:32", ticker: "TSLA", strike: 260, side: "BUY NO", sideCls: "buy-no", price: "0.530", size: "$1,000" },
  { time: "14:41:08", ticker: "META", strike: 680, side: "BUY YES", sideCls: "buy-yes", price: "0.500", size: "$50" },
  { time: "14:40:51", ticker: "GOOGL", strike: 190, side: "BUY YES", sideCls: "buy-yes", price: "0.370", size: "$300" },
  { time: "14:40:33", ticker: "MSFT", strike: 440, side: "SELL YES", sideCls: "sell-yes", price: "0.450", size: "$150" },
  { time: "14:40:12", ticker: "NVDA", strike: 1300, side: "BUY YES", sideCls: "buy-yes", price: "0.730", size: "$250" },
  { time: "14:39:58", ticker: "META", strike: 680, side: "BUY NO", sideCls: "buy-no", price: "0.475", size: "$400" },
  { time: "14:39:42", ticker: "AMZN", strike: 205, side: "BUY YES", sideCls: "buy-yes", price: "0.610", size: "$120" },
  { time: "14:39:21", ticker: "NVDA", strike: 1340, side: "SELL YES", sideCls: "sell-yes", price: "0.510", size: "$800" },
  { time: "14:38:55", ticker: "TSLA", strike: 260, side: "BUY YES", sideCls: "buy-yes", price: "0.470", size: "$95" },
  { time: "14:38:33", ticker: "META", strike: 680, side: "BUY YES", sideCls: "buy-yes", price: "0.515", size: "$310" },
  { time: "14:38:11", ticker: "GOOGL", strike: 190, side: "SELL YES", sideCls: "sell-yes", price: "0.380", size: "$220" },
  { time: "14:37:48", ticker: "AAPL", strike: 230, side: "BUY NO", sideCls: "buy-no", price: "0.480", size: "$140" },
  { time: "14:37:22", ticker: "NVDA", strike: 1300, side: "BUY YES", sideCls: "buy-yes", price: "0.725", size: "$180" },
];

const CONTESTS = [
  {
    eyebrow: "EARNINGS WEEK",
    title: "NVDA Earnings Contest",
    body: "Pre-expansion strike grid open. Top-10 split by settled-trade accuracy through Friday's report.",
    pool: "$3,400",
    progress: 35,
    footerLeft: "3d left · 187 entries",
    footerRight: "join →",
    myRank: false,
  },
  {
    eyebrow: "MONTHLY · TOP 10",
    title: "May Trader Championship",
    body: "Settled-PNL leaderboard, top-10 traders split the monthly pool.",
    pool: "$12,500",
    progress: 72,
    footerLeft: "8d left · 524 entries",
    footerRight: "you · #5",
    myRank: true,
  },
];

// ── Carousel slide data (mockup 2062-2154) ─────────────────────────────────
interface CarouselSlide {
  kind: "markets" | "leaderboard" | "contests" | "ai";
  eyebrow: { icon: string; text: string };
  title: { lead: string; accent: string; trail?: string };
  body: string;
  ctaPrimary: { label: string; href: string };
  ctaSecondary: { label: string };
  stat: { num: string; lbl: string; meta?: React.ReactNode; numStyle?: React.CSSProperties };
}

const SLIDES: CarouselSlide[] = [
  {
    kind: "markets",
    eyebrow: { icon: "●", text: "49 markets live" },
    title: { lead: "Binary outcome ", accent: "contracts", trail: " on Solana" },
    body: "YES/NO on daily MAG7 stock closes. $1 bUSDC max payout per contract. Settles at 4 PM ET via Pyth oracle. Non-custodial. In-program CLOB.",
    ctaPrimary: { label: "Launch Terminal →", href: "/trade/META/610" },
    ctaSecondary: { label: "How it works" },
    stat: {
      num: "49",
      lbl: "live markets",
      meta: (
        <>
          <span><span className="dot" style={{ background: "var(--yes)" }}></span> 4 up</span>
          <span><span className="dot" style={{ background: "var(--no)" }}></span> 2 down</span>
          <span><span className="dot" style={{ background: "var(--text-muted)" }}></span> 1 flat</span>
        </>
      ),
    },
  },
  {
    kind: "leaderboard",
    eyebrow: { icon: "🏆", text: "Weekly Leaderboard" },
    title: { lead: "degen.sol leads ", accent: "+$2,847", trail: " this week" },
    body: "Top-10 traders split $12,500 monthly pool + $1,800 weekly streak prize. 50/25/25 fee split per DR-010 — funded by every settled contract.",
    ctaPrimary: { label: "View leaderboard →", href: "#" },
    ctaSecondary: { label: "Rules + prizes" },
    stat: {
      num: "+$2,847",
      lbl: "leader this week",
      numStyle: { color: "var(--yes)" },
      meta: <span style={{ color: "var(--amber)" }}>🏆 degen.sol</span>,
    },
  },
  {
    kind: "contests",
    eyebrow: { icon: "⚡", text: "Active Contests" },
    title: { lead: "Earnings week: ", accent: "NVDA", trail: " · $3,400 pool" },
    body: "Pre-expansion strike grid is open. 3 days until NVDA's report — top-10 split the pool by settled-trade accuracy. 187 entries so far.",
    ctaPrimary: { label: "Enter contest →", href: "#" },
    ctaSecondary: { label: "All contests" },
    stat: {
      num: "$3,400",
      lbl: "prize pool",
      numStyle: { color: "var(--amber)" },
      meta: <span>3d left · 187 entries</span>,
    },
  },
  {
    kind: "ai",
    eyebrow: { icon: "✦", text: "Bell Pro" },
    title: { lead: "AI briefings on all ", accent: "7 MAG7 tickers" },
    body: "Daily market intelligence powered by Anthropic Claude. Per-position PNL digests, earnings-week analysis, sensitivity context. 9 bUSDC/mo via Helio.",
    ctaPrimary: { label: "Try Bell Pro →", href: "#" },
    ctaSecondary: { label: "See features" },
    stat: {
      num: "7",
      lbl: "daily briefings",
      numStyle: { color: "var(--accent)", fontSize: 36 },
      meta: <span>All MAG7 · powered by Claude</span>,
    },
  },
];

// ───────────────────────────────────────────────────────────────────────────

export function LandingView() {
  const [period, setPeriod] = useState<PeriodTab>("weekly");
  const [metric, setMetric] = useState<MetricTab>("profit");
  const [contestPeriod, setContestPeriod] = useState<ContestPeriod>("active");
  const [contestType, setContestType] = useState<ContestType>("all");
  const [matrixData, setMatrixData] = useState<MatrixData>("yes");
  const [matrixView, setMatrixView] = useState<MatrixView>("matrix");
  const { data: sub } = useBellProSubscription();
  const proActive = isBellProActive(sub);

  // Live AAPL briefing (P2-paired-sprint pattern).
  const [briefing, setBriefing] = useState<LiveBriefing | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/briefings/${BELL_PRO_DEFAULT_TICKER}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) return null;
        const json = (await res.json()) as { briefing?: LiveBriefing | null };
        return json.briefing ?? null;
      })
      .then((b) => {
        if (b) setBriefing(b);
      })
      .catch(() => {
        /* leave fallback in place */
      });
    return () => ctrl.abort();
  }, []);

  // Carousel state — discrete index; slidesPerView=1 on mobile, can carry
  // ~2.5 on wide screens via CSS scroll-snap. JS just clamps the dot count
  // and scrolls the right amount.
  const [slideIdx, setSlideIdx] = useState(0);
  const slidesRef = useRef<HTMLDivElement | null>(null);
  const advance = (delta: number) => {
    setSlideIdx((cur) => {
      const next = (cur + delta + SLIDES.length) % SLIDES.length;
      slidesRef.current?.children[next]?.scrollIntoView({
        behavior: "smooth",
        inline: "start",
        block: "nearest",
      });
      return next;
    });
  };

  // Probability matrix cell display per DATA toggle.
  function renderCellLabel(cell: MatrixCell): string {
    if (cell.empty) return "—";
    switch (matrixData) {
      case "yes": return `${cell.prob}%`;
      case "no": return `${100 - cell.prob}%`;
      case "bidask": {
        // Simple bid/ask derived from prob centerline (mock-derived).
        const mid = cell.prob / 100;
        const bid = (mid - 0.01).toFixed(2);
        const ask = (mid + 0.01).toFixed(2);
        return `${bid}/${ask}`;
      }
      case "volume": {
        // Deterministic-ish mock derived from prob × row vol.
        const seedVol = 10 + Math.round(cell.prob / 4);
        return `$${seedVol}K`;
      }
    }
  }

  return (
    <div className="layout">
      {/* ──────────── LEFT RAIL — persistent market navigator ──────────── */}
      <aside className="left-rail">

        <details className="rail-section" id="rail-filters" open>
          <summary className="rail-section-h">
            <span className="rail-section-title">Filter matrix <span className="count">49 markets</span></span>
            <span className="rail-chevron" aria-hidden="true">▾</span>
          </summary>
          <div className="rail-section-body">
            <div className="rail-filters-help">Refines what shows in the probability matrix →</div>
            <div className="rail-filters">
              <button className="rail-filter active" title="Show all markets">All <span className="ct">49</span></button>
              <button className="rail-filter" title="Markets within ±3% of current spot">Near strike <span className="ct">14</span></button>
              <button className="rail-filter" title="Highest 24h volume">High vol <span className="ct">5</span></button>
              <button className="rail-filter" title="Markets where you hold positions">My positions <span className="ct">3</span></button>
              <button className="rail-filter" title="Markets you've starred">Watchlist <span className="ct">0</span></button>
            </div>
          </div>
        </details>

        <details className="rail-section" id="rail-tickers" open>
          <summary className="rail-section-h">
            <span className="rail-section-title">All tickers <span className="count">7</span></span>
            <span className="rail-chevron" aria-hidden="true">▾</span>
          </summary>
          <div className="rail-section-body">
            <div className="rail-ticker-list">
              {RAIL_TICKERS.map((t, i) => (
                <details
                  key={t.sym}
                  className={`ticker-accordion${i === 0 ? " active" : ""}`}
                  open={i === 0}
                >
                  <summary className="ticker-accordion-head">
                    <span className="rail-ticker-mark">{t.mark}</span>
                    <span className="ticker-sym-block">
                      <span className="rail-ticker-sym">{t.sym}</span>
                      <span className="rail-ticker-spot">{t.spot}</span>
                    </span>
                    <span className="ticker-meta-block">
                      <span className={`rail-ticker-chg ${t.chgUp ? "up" : "down"}`}>{t.chg}</span>
                      <span className="rail-ticker-vol">{t.vol}</span>
                    </span>
                    <span className="ticker-chevron" aria-hidden="true">▾</span>
                  </summary>
                  <div className="ticker-strikes">
                    {t.strikes.map((s) => {
                      const isDemoTicker = DEMO_LIVE_STRIKE[t.sym] !== undefined;
                      const routeStrike = isDemoTicker && s.kind === "atm"
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
              ))}
            </div>
          </div>
        </details>

        <div className="rail-section">
          <div className="rail-section-h">
            <span className="rail-section-title">My positions <span className="count">3</span></span>
          </div>
          <div className="rail-watchlist" data-mock="true">
            {RAIL_POSITIONS.map((p) => (
              <div className="rail-position" key={p.market}>
                <div className="rail-position-info">
                  <span className="rail-position-market">{p.market}</span>
                  <span className="rail-position-side">{p.side}</span>
                </div>
                <span className={`rail-position-pnl ${p.down ? "down" : "up"}`}>{p.pnl}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rail-section">
          <div className="rail-section-h">
            <span className="rail-section-title">Watchlist <span className="count">0</span></span>
          </div>
          <div className="rail-watchlist-empty">★ Star markets to track them here</div>
        </div>

      </aside>

      {/* ──────────── MAIN ──────────── */}
      <main>

        {/* CNBC ticker marquee */}
        <div className="ticker-marquee" aria-label="Live ticker scroll">
          <div className="ticker-track">
            {[...TICKERS, ...TICKERS].map((t, i) => (
              <span key={i} style={{ display: "contents" }}>
                <div className="tm-item">
                  <span className="tm-sym">{t.sym}</span>
                  <span>{t.spot}</span>
                  <span className={`tm-chg ${t.up ? "up" : "down"}`}>{t.chg}</span>
                </div>
                <div className="tm-div">·</div>
              </span>
            ))}
          </div>
        </div>

        {/* Hero grid: carousel + session block */}
        <div className="hero-grid">
          <div className="carousel" id="carousel" aria-label="Featured highlights">
            <div className="carousel-slides" id="slides" ref={slidesRef}>
              {SLIDES.map((s) => (
                <div className="carousel-slide" key={s.kind} data-slide={s.kind}>
                  <div className="slide-body">
                    <span className="slide-eyebrow">
                      <span aria-hidden="true">{s.eyebrow.icon}</span> {s.eyebrow.text}
                    </span>
                    <h1 className="slide-title">
                      {s.title.lead}
                      <span className="accent">{s.title.accent}</span>
                      {s.title.trail}
                    </h1>
                    <p>{s.body}</p>
                    <div className="slide-actions">
                      <Link href={s.ctaPrimary.href} className="btn-primary">
                        {s.ctaPrimary.label}
                      </Link>
                      <button type="button" className="btn-secondary">
                        {s.ctaSecondary.label}
                      </button>
                    </div>
                  </div>
                  <div className="slide-stat">
                    <div className="slide-stat-num" style={s.stat.numStyle}>
                      {s.stat.num}
                    </div>
                    <div className="slide-stat-lbl">{s.stat.lbl}</div>
                    {s.stat.meta && <div className="slide-stat-meta">{s.stat.meta}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="carousel-arrows">
              <button
                type="button"
                className="carousel-arrow"
                aria-label="Previous slide"
                onClick={() => advance(-1)}
              >
                ◀
              </button>
              <button
                type="button"
                className="carousel-arrow"
                aria-label="Next slide"
                onClick={() => advance(1)}
              >
                ▶
              </button>
            </div>
            <div className="carousel-dots" role="tablist" aria-label="Carousel pages">
              {SLIDES.map((s, i) => (
                <button
                  type="button"
                  key={s.kind}
                  className={`carousel-dot${i === slideIdx ? " active" : ""}`}
                  aria-label={`Go to slide ${i + 1}`}
                  onClick={() => {
                    setSlideIdx(i);
                    slidesRef.current?.children[i]?.scrollIntoView({
                      behavior: "smooth",
                      inline: "start",
                      block: "nearest",
                    });
                  }}
                />
              ))}
            </div>
          </div>

          {/* Session block */}
          <div className="session-block">
            <div className="session-block-h">
              <span>Today&apos;s session</span>
              <span className="session-h-countdown mono">
                <span className="lbl">Settle in</span>{" "}
                <span className="val amber">02:13:47</span>
              </span>
            </div>
            <div className="session-row">
              <span className="lbl">Markets active</span>
              <span className="val cyan">49</span>
            </div>
            <div className="session-row">
              <span className="lbl">Volume 24h</span>
              <span className="val">$184,723</span>
            </div>
            <div className="session-row">
              <span className="lbl">Trades 24h</span>
              <span className="val">2,847</span>
            </div>
            <div className="session-row">
              <span className="lbl">Active wallets</span>
              <span className="val">127</span>
            </div>
          </div>
        </div>

        {/* PROBABILITY MATRIX */}
        <div className="matrix-card" id="matrix" data-view={matrixView}>
          <div className="matrix-h">
            <h3>
              YES Probability Matrix <span className="badge">49 markets</span>
            </h3>
            <div className="matrix-h-controls">
              <div className="matrix-controls" role="tablist" aria-label="Data shown in cells">
                {([
                  ["yes", "YES %"],
                  ["no", "NO %"],
                  ["bidask", "Bid/Ask"],
                  ["volume", "Volume"],
                ] as const).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`matrix-control${matrixData === k ? " active" : ""}`}
                    onClick={() => setMatrixData(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div className="matrix-view-toggle" role="tablist" aria-label="Layout view">
                {([
                  ["matrix", "Matrix"],
                  ["cards", "Cards"],
                  ["list", "List"],
                ] as const).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`mv-btn${matrixView === k ? " active" : ""}`}
                    onClick={() => setMatrixView(k)}
                    aria-label={lbl}
                    title={`${lbl} view`}
                  >
                    {k === "matrix" && (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="4" height="4" /><rect x="10" y="2" width="4" height="4" /><rect x="2" y="10" width="4" height="4" /><rect x="10" y="10" width="4" height="4" /></svg>
                    )}
                    {k === "cards" && (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="5" rx="1" /><rect x="2" y="9" width="12" height="5" rx="1" /></svg>
                    )}
                    {k === "list" && (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="4" x2="14" y2="4" /><line x1="2" y1="8" x2="14" y2="8" /><line x1="2" y1="12" x2="14" y2="12" /></svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
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

            {MATRIX_ROWS.map((row) => {
              const atmIdx = row.cells.findIndex((c) => c.atm);
              const atmStrike = atmIdx >= 0 ? row.cells[atmIdx]!.strike : row.cells[3]?.strike ?? 0;
              const rowRoute = `/trade/${row.sym}/${navStrike(row.sym, atmStrike)}`;
              return (
                <div className="matrix-row" key={row.sym}>
                  <Link href={rowRoute} className="matrix-ticker">
                    <span className="matrix-ticker-mark">{row.mark}</span>
                    {row.sym}
                  </Link>
                  <div className="matrix-spot mono">
                    <span className="px">{row.spot}</span>
                    <span className={`chg ${row.chgUp ? "up" : "down"}`}>{row.chg}</span>
                  </div>
                  {row.cells.map((c) => {
                    if (c.empty) {
                      return (
                        <div key={c.strike} className={`prob-cell ${c.cls}`}>
                          <span className="strike">{c.label}</span>
                          <span className="prob">—</span>
                        </div>
                      );
                    }
                    return (
                      <Link
                        key={c.strike}
                        href={`/trade/${row.sym}/${navStrike(row.sym, c.strike)}`}
                        className={`prob-cell ${c.cls}`}
                      >
                        <span className="strike">{c.label}</span>
                        <span className="prob">{renderCellLabel(c)}</span>
                      </Link>
                    );
                  })}
                  <div className="matrix-vol mono">
                    {row.vol}
                    <span className={`delta ${row.deltaUp ? "up" : "down"}`}>{row.delta}</span>
                  </div>
                  <div className="matrix-action">
                    <Link href={rowRoute}>
                      <button type="button">OPEN →</button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Row-2col: Leaderboard + Contests */}
        <div className="row-2col">

          {/* Leaderboard */}
          <div className="half-section">
            <div className="section-h-block compact">
              <h2><span className="eyebrow">Leaderboard</span> Top traders</h2>
              <Link href="#" className="link">All →</Link>
            </div>
            <div className="lb-tabs">
              <div className="lb-tab-group period" role="tablist">
                {(["weekly", "monthly"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`lb-tab${period === p ? " active" : ""}`}
                    onClick={() => setPeriod(p)}
                  >
                    {p === "weekly" ? "Weekly" : "Monthly"}
                  </button>
                ))}
              </div>
              <div className="lb-tab-group metric" role="tablist">
                {([
                  ["profit", "Profit"],
                  ["streak", "Win Streak"],
                  ["winrate", "Win Rate"],
                ] as const).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`lb-tab${metric === k ? " active" : ""}`}
                    onClick={() => setMetric(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div className="lb-period-meta">
              <span className="lb-period-state mono">
                {period === "weekly" ? "Weekly · 2d 14h left" : "Monthly · 8d left"}
              </span>
              <span className="lb-pool mono">
                ${period === "weekly" ? "1,800" : "12,500"} pool
              </span>
            </div>
            <div className="leaderboard-card half-card" data-mock="true">
              {LEADERS.map((u) => {
                const metricVal =
                  metric === "profit"
                    ? u.profit
                    : metric === "streak"
                      ? u.streak
                      : u.winRate;
                return (
                  <div
                    key={u.rank}
                    className="lb-row-item"
                    style={u.isYou ? { background: "rgba(34, 211, 238, 0.06)" } : undefined}
                  >
                    <span
                      className={`rank ${u.rankCls} mono`}
                      style={u.isYou ? { color: "var(--accent)" } : undefined}
                    >
                      #{u.rank}
                    </span>
                    <div className="lb-user-block">
                      <span className="lb-avatar">{u.avatar}</span>
                      <div>
                        <div
                          className="lb-name"
                          style={u.isYou ? { color: "var(--accent)" } : undefined}
                        >
                          {u.name}
                        </div>
                        <div className="lb-meta">{u.trades}</div>
                      </div>
                    </div>
                    <span className="lb-pnl mono">{metricVal}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Contests */}
          <div className="half-section">
            <div className="section-h-block compact">
              <h2>
                <span
                  className="eyebrow"
                  style={{
                    background: "rgba(244, 114, 182, 0.12)",
                    color: "var(--pink)",
                    border: "1px solid var(--pink)",
                  }}
                >
                  Contests
                </span>{" "}
                Active prize pools
              </h2>
              <Link href="#" className="link">All →</Link>
            </div>
            <div className="lb-tabs">
              <div className="lb-tab-group period" role="tablist">
                {([
                  ["active", "Active"],
                  ["upcoming", "Upcoming"],
                  ["ended", "Ended"],
                ] as const).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`lb-tab${contestPeriod === k ? " active" : ""}`}
                    onClick={() => setContestPeriod(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div className="lb-tab-group metric" role="tablist">
                {([
                  ["all", "All"],
                  ["weekly", "Weekly"],
                  ["monthly", "Monthly"],
                  ["event", "Event"],
                ] as const).map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    className={`lb-tab${contestType === k ? " active" : ""}`}
                    onClick={() => setContestType(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div className="lb-period-meta">
              <span className="lb-period-state mono">3 active · 187+ entries</span>
              <span className="lb-pool mono">$17,700 total pool</span>
            </div>
            <div className="contests-stack" data-mock="true">
              {CONTESTS.map((c) => (
                <div className="contest-card" key={c.title}>
                  <span className="ct-eyebrow">{c.eyebrow}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  <div className="contest-pool-line">
                    <span className="contest-pool-amount mono">{c.pool}</span>
                    <span className="contest-pool-label">PRIZE POOL</span>
                  </div>
                  <div className="contest-progress">
                    <div className="contest-progress-fill" style={{ width: `${c.progress}%` }} />
                  </div>
                  <div className="contest-footer">
                    <span className="mono">{c.footerLeft}</span>
                    <span className={`mono${c.myRank ? " my-rank" : ""}`}>{c.footerRight}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* Row-2col: Bell Pro live briefing + Recent Fills */}
        <div className="row-2col">

          {/* Bell Pro */}
          <div className="half-section">
            <div className="bell-pro-card half-card">
              <span className="bp-eyebrow">
                <span aria-hidden="true">✦</span> Powered by Claude
              </span>
              {briefing ? (
                <>
                  <h2 className="bp-title">
                    <span className="accent">{briefing.ticker}</span> daily briefing
                  </h2>
                  <p
                    style={{
                      color: "var(--text-muted)",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      maxHeight: 220,
                      overflowY: "auto",
                      paddingRight: 6,
                      whiteSpace: "pre-wrap",
                      marginBottom: 12,
                    }}
                  >
                    {briefing.body}
                  </p>
                  <div className="bp-pricing-inline">
                    <div className="bp-pricing-block">
                      <div className="bp-price">
                        9<span className="small"> bUSDC</span>
                        <span className="bp-per">/mo</span>
                      </div>
                      {proActive ? (
                        <span className="bp-cta">You&apos;re Pro ✓</span>
                      ) : (
                        <Link href="/settings#billing" className="bp-cta">
                          UNLOCK BELL PRO →
                        </Link>
                      )}
                    </div>
                    <div className="bp-founder-block">
                      <span className="bp-founder-label">
                        {new Date(briefing.generatedAt).toLocaleDateString("en-US", {
                          timeZone: "America/New_York",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })}{" "}
                        ET · {briefing.model}
                      </span>
                      <span className="bp-founder-meta">
                        Information only — not financial advice.
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="bp-title">
                    Daily briefings on<br />
                    <span className="accent">7 MAG7 tickers</span>
                  </h2>
                  <p
                    style={{
                      color: "var(--text-muted)",
                      fontSize: 13,
                      lineHeight: 1.5,
                      marginBottom: 12,
                    }}
                  >
                    Pyth-grounded market intelligence. Per-position PNL digests. Earnings-week deep dives. Behavioral guardrails. Information only — never financial advice.
                  </p>
                  <ul className="bp-features bp-features-compact">
                    <li>All 7 MAG7 daily briefings</li>
                    <li>Per-position PNL digests</li>
                    <li>Earnings-week analysis</li>
                    <li>Sensitivity context</li>
                    <li>Behavioral coaching</li>
                    <li>MCP access (own agent)</li>
                  </ul>
                  <div className="bp-pricing-inline">
                    <div className="bp-pricing-block">
                      <div className="bp-price">
                        9<span className="small"> bUSDC</span>
                        <span className="bp-per">/mo</span>
                      </div>
                      {proActive ? (
                        <span className="bp-cta">You&apos;re Pro ✓</span>
                      ) : (
                        <Link href="/settings#billing" className="bp-cta">
                          UNLOCK BELL PRO →
                        </Link>
                      )}
                    </div>
                    <div className="bp-founder-block">
                      <span className="bp-founder-label">FOUNDER PASS</span>
                      <span className="bp-founder-meta">0.5 SOL · lifetime + gov + LP rebate</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Recent Fills */}
          <div className="half-section">
            <div className="activity-card half-card">
              <div className="activity-card-h">
                <h3>Recent Fills</h3>
                <span className="live">live · {FILLS.length} trades</span>
              </div>
              <div className="fills-scroll" data-mock="true">
                {FILLS.map((f, i) => (
                  <div className="fill-row" key={i}>
                    <span className="time">{f.time}</span>
                    <span className="market">
                      <span className="ticker">{f.ticker}</span>.{f.strike}
                    </span>
                    <span className={`side ${f.sideCls}`}>{f.side}</span>
                    <span className="price mono">{f.price}</span>
                    <span className="size mono">{f.size}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>

        {/* HOW IT WORKS */}
        <div className="how-section">
          <div className="how-h">How it works · 4 steps</div>
          <div className="how-grid">
            <div className="how-step">
              <div className="how-step-num">01 / PICK</div>
              <h4>Choose market + strike</h4>
              <p>Pick a MAG7 ticker and a strike price for today&apos;s 4 PM ET close.</p>
            </div>
            <div className="how-step">
              <div className="how-step-num">02 / TRADE</div>
              <h4>Atomic Buy/Sell</h4>
              <p>One signature. In-program CLOB matches orders. Sell anytime before settle.</p>
            </div>
            <div className="how-step">
              <div className="how-step-num">03 / SETTLE</div>
              <h4>Pyth oracle resolves</h4>
              <p>4:00 PM ET close written on-chain. Permissionless crank — cron is convenience, not authority.</p>
            </div>
            <div className="how-step">
              <div className="how-step-num">04 / REDEEM</div>
              <h4>Claim $1 bUSDC</h4>
              <p>Winners redeem $1 per contract. Losers burn to zero. Redeemable forever.</p>
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}
