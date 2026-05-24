// DR-015 — compute the 4 ranking metrics from the indexer's tables.
//
// Period scoping: all metrics filter against `settle_events.observed_at`
// within `[period_start, period_end)`. Streak is the exception — current_streak
// is the user's live state at period close (cumulative across all-time, not
// period-scoped) because resetting weekly would defeat the point of streaks.
//
// Data sources per metric:
//   0x00 profit     — user_market_holds.{yes_held, no_held} × outcome×result
//                     against settle_events within period
//   0x01 streak     — user_streaks.current_streak (cumulative state at period close)
//   0x02 win_rate   — user_market_holds aggregated within period; ≥20 trades to qualify
//   0x03 ROI        — profit / capital_deployed (capital_deployed not yet indexed;
//                     STUB returns [] in v1; documented data dep for v1.5).
//
// Returns MetricLeaderboardEntry[] with rank pre-assigned (1..N, top first).
// `amountBaseUnits` is the USDC base-unit value that will be paid out for
// that rank (zero here — caller fills with positional bps×pool math).

import type { SqlClient } from "../db/client.js";
import { getSqlClient } from "../db/client.js";
import type { MetricLeaderboardEntry } from "./merkle-v2.ts";

export type MetricQueryDeps = { sql?: SqlClient };

function clientOf(deps?: MetricQueryDeps): SqlClient {
  return deps?.sql ?? getSqlClient();
}

export type PeriodWindow = {
  start: Date;
  end: Date;
};

// ---------------------------------------------------------------------------
// 0x00 — absolute profit (USDC), period-scoped
// ---------------------------------------------------------------------------

/**
 * Per-user "won amount" within the period — sum of winning-side holdings on
 * markets settled in the period. Limitation: this approximates profit by
 * ignoring mint cost (which would need a separate mint_pair indexer; tracked
 * as v1.5 follow-up).
 *
 * Returns top-N descending. `rank` is 1-indexed. `amountBaseUnits` is set to
 * 0n here — the orchestrator fills it from positional bps × pool balance.
 */
export async function topProfitLeaderboard(
  window: PeriodWindow,
  limit = 10,
  deps?: MetricQueryDeps,
): Promise<MetricLeaderboardEntry[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT
      umh.user_pubkey,
      SUM(
        CASE
          WHEN umh.outcome = 'yes' AND umh.result = 'won' THEN umh.yes_held
          WHEN umh.outcome = 'no'  AND umh.result = 'won' THEN umh.no_held
          ELSE 0
        END
      ) AS won_amount
    FROM user_market_holds umh
    JOIN settle_events se ON se.id = umh.settle_event_id
    WHERE se.observed_at >= ${window.start.toISOString()}
      AND se.observed_at <  ${window.end.toISOString()}
    GROUP BY umh.user_pubkey
    HAVING SUM(
      CASE
        WHEN umh.outcome = 'yes' AND umh.result = 'won' THEN umh.yes_held
        WHEN umh.outcome = 'no'  AND umh.result = 'won' THEN umh.no_held
        ELSE 0
      END
    ) > 0
    ORDER BY won_amount DESC
    LIMIT ${limit}
  `) as Array<{ user_pubkey: string; won_amount: string | number }>;
  return rows.map((r, idx) => ({
    recipient: r.user_pubkey,
    rank: idx + 1,
    amountBaseUnits: 0n,
  }));
}

// ---------------------------------------------------------------------------
// 0x01 — win streak (cumulative, snapshot at period close)
// ---------------------------------------------------------------------------

/**
 * Top-N by current_streak; tiebreak by total_markets_traded DESC. Aligns with
 * existing DR-010 `topNLeaderboard` query but exposes the streak metric
 * explicitly + emits `MetricLeaderboardEntry` shape for the multi-metric
 * tree.
 */
export async function topStreakLeaderboard(
  _window: PeriodWindow,
  limit = 10,
  deps?: MetricQueryDeps,
): Promise<MetricLeaderboardEntry[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT user_pubkey, current_streak, total_markets_traded
    FROM user_streaks
    WHERE current_streak > 0
    ORDER BY current_streak DESC, total_markets_traded DESC
    LIMIT ${limit}
  `) as Array<{ user_pubkey: string; current_streak: number; total_markets_traded: number }>;
  return rows.map((r, idx) => ({
    recipient: r.user_pubkey,
    rank: idx + 1,
    amountBaseUnits: 0n,
  }));
}

// ---------------------------------------------------------------------------
// 0x02 — win rate (period-scoped, min 20 trades to qualify)
// ---------------------------------------------------------------------------

export const WIN_RATE_MIN_TRADES = 20;

/**
 * Top-N by period win-rate. Counts settle results within the window:
 *   numerator   = COUNT(result='won')
 *   denominator = COUNT(result IN ('won','lost','invalid')) — excludes abstain
 *
 * Excludes users with <`WIN_RATE_MIN_TRADES` denominators (otherwise a
 * single lucky trade would top the leaderboard).
 */
export async function topWinRateLeaderboard(
  window: PeriodWindow,
  limit = 10,
  deps?: MetricQueryDeps,
): Promise<MetricLeaderboardEntry[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT
      umh.user_pubkey,
      COUNT(*) FILTER (WHERE umh.result = 'won') AS wins,
      COUNT(*) FILTER (WHERE umh.result IN ('won','lost','invalid')) AS trades
    FROM user_market_holds umh
    JOIN settle_events se ON se.id = umh.settle_event_id
    WHERE se.observed_at >= ${window.start.toISOString()}
      AND se.observed_at <  ${window.end.toISOString()}
    GROUP BY umh.user_pubkey
    HAVING COUNT(*) FILTER (WHERE umh.result IN ('won','lost','invalid')) >= ${WIN_RATE_MIN_TRADES}
    ORDER BY (
      COUNT(*) FILTER (WHERE umh.result = 'won')::numeric
      / NULLIF(COUNT(*) FILTER (WHERE umh.result IN ('won','lost','invalid')), 0)
    ) DESC, trades DESC
    LIMIT ${limit}
  `) as Array<{ user_pubkey: string; wins: number; trades: number }>;
  return rows.map((r, idx) => ({
    recipient: r.user_pubkey,
    rank: idx + 1,
    amountBaseUnits: 0n,
  }));
}

// ---------------------------------------------------------------------------
// 0x03 — ROI (STUB in v1; requires mint_pair capital indexing)
// ---------------------------------------------------------------------------

/**
 * STUB: returns [] until v1.5 mint_pair capital indexing lands.
 *
 * Rationale: ROI = profit / capital_deployed. `profit` we approximate via
 * `topProfitLeaderboard`. `capital_deployed` needs sum of mint_pair amounts
 * within the period — but `mint_pair` events aren't currently indexed. The
 * Helius webhook parser (helius-webhook.ts deploy-5) recognizes the ix but
 * doesn't persist it.
 *
 * v1.5 follow-up:
 *   1. New table `mint_events` (user_pubkey, market_pubkey, amount, observed_at, tx_sig)
 *   2. Indexer pipeline: Helius webhook on `mint_pair` → insertMintEvent
 *   3. This function joins mint_events × profit aggregation, computes ROI,
 *      caps at 99% (avoid runaway gaming from $1 mints).
 *
 * Per DR-015 §"Initial metric set", ROI is also Bell Pro tier — gated by
 * DR-014 subscription state. v1 returns empty.
 */
export async function topRoiLeaderboard(
  _window: PeriodWindow,
  _limit = 10,
  _deps?: MetricQueryDeps,
): Promise<MetricLeaderboardEntry[]> {
  return [];
}

// ---------------------------------------------------------------------------
// Combined fetcher — returns all 4 in parallel
// ---------------------------------------------------------------------------

export type FourMetricLeaderboard = {
  profit: MetricLeaderboardEntry[];
  streak: MetricLeaderboardEntry[];
  winRate: MetricLeaderboardEntry[];
  roi: MetricLeaderboardEntry[];
};

export async function fetchAllMetricLeaderboards(
  window: PeriodWindow,
  limit = 10,
  deps?: MetricQueryDeps,
): Promise<FourMetricLeaderboard> {
  const [profit, streak, winRate, roi] = await Promise.all([
    topProfitLeaderboard(window, limit, deps),
    topStreakLeaderboard(window, limit, deps),
    topWinRateLeaderboard(window, limit, deps),
    topRoiLeaderboard(window, limit, deps),
  ]);
  return { profit, streak, winRate, roi };
}
