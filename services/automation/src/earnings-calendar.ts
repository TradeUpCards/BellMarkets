// MAG7 earnings calendar + pre-expansion / restoration helpers per DR-011.
//
// What this does:
//   - Tracks hardcoded MAG7 quarterly earnings announcement dates for 2026.
//   - Surfaces per-ticker "pre-expansion" deviation cap (default × 2) the
//     trading day BEFORE an earnings event, so users can spawn wider strikes
//     in anticipation of the post-AMC announcement gap.
//   - Surfaces "restoration" of default cap the trading day AFTER an
//     earnings event, normalizing back to standard volatility envelope.
//
// What this does NOT do:
//   - Override the wild-swing detection (DR-006 Phase 2/3) — both are
//     additive. If pre-expansion misses an earnings date OR a non-earnings
//     surprise happens, DR-006 still catches drift > threshold.
//   - Predict the direction of the gap. We only widen the strike-creation
//     envelope; we do NOT pre-create strikes nor adjust capCenter.
//
// IMPORTANT: 2026 dates are best-effort approximations from public quarterly
// reporting patterns. They are NOT pulled from a live calendar API. Annual
// refresh is required each January. V2 path: integrate `yahoo-finance2` /
// Polygon.io / Alpha Vantage.
//
// Why "approximations": companies do not pre-publish exact earnings dates a
// year in advance. NVDA's fiscal calendar is offset from the rest of MAG7
// (Jan/Apr/Jul/Oct reporting → calendar Q4/Q1/Q2/Q3). Dates here are based on
// 2025 actuals + typical week-of-month patterns; verify against IR pages
// before relying on them for production demos.

import type { Ticker } from "./types.js";
import { isTradingDay, nextTradingDay, previousTradingDay, toEtDateString } from "./calendar.js";
import { TICKER_DEFAULTS } from "./ticker-config.js";

// ---------------------------------------------------------------------------
// 2026 MAG7 earnings calendar (best-effort approximations)
// ---------------------------------------------------------------------------
//
// Conventions:
//   - All dates are TRADING DAYS (weekday + non-holiday). If Tate's
//     prompt-template date fell on a weekend, snapped to the nearest
//     preceding/following weekday (Thursday/Friday is the typical earnings
//     announce day).
//   - All dates are interpreted in America/New_York (ET).
//   - Earnings happen AMC (after market close) — the cap should be pre-
//     expanded by 4:30 PM ET on the trading day immediately before each
//     date, and restored by 4:30 PM ET on the trading day after.
//
// VERIFY THESE BEFORE ANY DEMO. Quarterly earnings dates are public on
// company IR pages — replace approximations with confirmed dates.
export const EARNINGS_DATES_2026: Record<Ticker, readonly string[]> = {
  // AAPL: Q1 FY26 (calendar Q4 2025) reported ~Jan 29. Q2 FY26 ~May 1.
  //       Q3 ~Jul 30. Q4 ~Oct 29.
  AAPL: ["2026-01-29", "2026-05-01", "2026-07-30", "2026-10-29"],
  // MSFT: Q2 FY26 ~Jan 30. Q3 ~Apr 30. Q4 ~Jul 30. Q1 FY27 ~Oct 30.
  MSFT: ["2026-01-30", "2026-04-30", "2026-07-30", "2026-10-30"],
  // GOOGL: Q4 2025 ~Jan 29 (snapped from Sun Feb 1). Q1 ~Apr 30. Q2 ~Jul 30.
  //        Q3 ~Oct 30.
  GOOGL: ["2026-01-29", "2026-04-30", "2026-07-30", "2026-10-30"],
  // AMZN: Q4 2025 ~Jan 29 (snapped from Sun Feb 1). Q1 ~May 1. Q2 ~Jul 30
  //       (snapped from Sat Aug 1). Q3 ~Oct 30.
  AMZN: ["2026-01-29", "2026-05-01", "2026-07-30", "2026-10-30"],
  // META: Q4 2025 ~Jan 29 (snapped from Sun Feb 1). Q1 ~Apr 30. Q2 ~Jul 30.
  //       Q3 ~Oct 30.
  META: ["2026-01-29", "2026-04-30", "2026-07-30", "2026-10-30"],
  // NVDA: fiscal calendar offset. Q4 FY26 ~Feb 19 (snapped from Sat Feb 21).
  //       Q1 FY27 ~May 22. Q2 FY27 ~Aug 28. Q3 FY27 ~Nov 20.
  NVDA: ["2026-02-19", "2026-05-22", "2026-08-28", "2026-11-20"],
  // TSLA: Q4 2025 ~Jan 22 (snapped from Sat Jan 24). Q1 ~Apr 24. Q2 ~Jul 24.
  //       Q3 ~Oct 23.
  TSLA: ["2026-01-22", "2026-04-24", "2026-07-24", "2026-10-23"],
};

// ---------------------------------------------------------------------------
// Pre-expansion magnitude per DR-011
// ---------------------------------------------------------------------------
//
// Defaults from DR-005:
//   High-vol  (NVDA/META/TSLA): 3000 bps (30%) → pre-expand 5000 bps (50%)
//   Mid-vol   (AMZN):           2000 bps (20%) → pre-expand 3000 bps (30%)
//   Low-vol   (AAPL/MSFT/GOOGL):1500 bps (15%) → pre-expand 2500 bps (25%)

export const EARNINGS_PREEXPAND_BPS: Record<Ticker, number> = {
  NVDA: 5000,
  META: 5000,
  TSLA: 5000,
  AMZN: 3000,
  AAPL: 2500,
  MSFT: 2500,
  GOOGL: 2500,
};

// ---------------------------------------------------------------------------
// Lookup helpers — used by both unit tests and the cron orchestrator
// ---------------------------------------------------------------------------

/**
 * Returns the tickers that have an earnings event on the given date.
 * Empty array if no MAG7 ticker reports that day. Date interpreted as ET.
 */
export function tickersReportingOn(date: Date): Ticker[] {
  const dateStr = toEtDateString(date);
  const tickers: Ticker[] = [];
  for (const ticker of Object.keys(EARNINGS_DATES_2026) as Ticker[]) {
    if (EARNINGS_DATES_2026[ticker].includes(dateStr)) {
      tickers.push(ticker);
    }
  }
  return tickers;
}

/**
 * Returns true if `date` is a trading day AND any MAG7 ticker reports earnings
 * on it. Used by tests and the demo-narrative to surface "earnings day" labels.
 */
export function isEarningsDay(date: Date): boolean {
  if (!isTradingDay(date)) return false;
  return tickersReportingOn(date).length > 0;
}

/**
 * Tickers that should be PRE-EXPANDED at the 4:30 PM ET cron on `today`:
 * any ticker reporting on `nextTradingDay(today)`. Empty if no earnings
 * scheduled for the next trading session.
 */
export function tickersToPreExpand(today: Date): Ticker[] {
  return tickersReportingOn(nextTradingDay(today));
}

/**
 * Tickers that should be RESTORED at the 4:30 PM ET cron on `today`:
 * any ticker that reported earnings on `previousTradingDay(today)`. Empty
 * if no earnings happened on the previous session.
 */
export function tickersToRestore(today: Date): Ticker[] {
  return tickersReportingOn(previousTradingDay(today));
}

/**
 * Sanity check exported for tests + diagnostics: every hardcoded earnings
 * date must be a trading day (so the pre-expand/restore crons can find
 * it via nextTradingDay/previousTradingDay).
 */
export function listMalformedEarningsDates(): Array<{ ticker: Ticker; date: string }> {
  const bad: Array<{ ticker: Ticker; date: string }> = [];
  for (const ticker of Object.keys(EARNINGS_DATES_2026) as Ticker[]) {
    for (const ymd of EARNINGS_DATES_2026[ticker]) {
      const parts = ymd.split("-");
      if (parts.length !== 3) {
        bad.push({ ticker, date: ymd });
        continue;
      }
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      const d = Number(parts[2]);
      const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
      if (!isTradingDay(date)) {
        bad.push({ ticker, date: ymd });
      }
    }
  }
  return bad;
}

/**
 * Sanity check: pre-expand cap must be GREATER than default cap (otherwise
 * we'd shrink the envelope on earnings day, which makes no sense).
 */
export function listInvalidExpansionCaps(): Array<{ ticker: Ticker; default: number; expanded: number }> {
  const bad: Array<{ ticker: Ticker; default: number; expanded: number }> = [];
  for (const ticker of Object.keys(EARNINGS_PREEXPAND_BPS) as Ticker[]) {
    const def = TICKER_DEFAULTS[ticker].defaultDeviationCapBps;
    const exp = EARNINGS_PREEXPAND_BPS[ticker];
    if (exp <= def) bad.push({ ticker, default: def, expanded: exp });
  }
  return bad;
}
