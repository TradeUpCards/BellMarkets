"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { PublicKey } from "@solana/web3.js";

import { queryKeys } from "@/lib/queries/keys";

export type LeaderboardPeriod = "weekly" | "monthly";

export interface LeaderboardEntry {
  rank: number;
  userPubkey: string;
  streakCount: number;
  totalMarkets: number;
  /** Projected prize in USDC micros from the current pool × position bps. */
  prizeUsdcMicros: bigint;
}

export interface LeaderboardResponse {
  period: LeaderboardPeriod;
  /** Period ID — week number for weekly, year-month for monthly. */
  periodId: string;
  /** Top-N entries (top-10 per DR-010). */
  entries: LeaderboardEntry[];
  /** Pool balance (USDC micros) at indexer snapshot time. */
  poolBalanceMicros: bigint;
  /** On-chain Merkle commitment for verification (Option B per DR-010). */
  merkleRoot?: string;
  /** Arweave content id for the full leaderboard (DR-010 §"Verification model"). */
  arweaveContentId?: string;
  /** Indexer snapshot timestamp (UNIX seconds). */
  snapshotUnix: number;
}

/**
 * Fetch the current period's leaderboard from Bram's indexer API (DR-010).
 *
 * Bram's indexer URL is TBD — until it surfaces in his handoff we keep the
 * URL as an env var (`NEXT_PUBLIC_BELL_LEADERBOARD_URL`) so flipping it on
 * is a no-code change. If the env var is unset the hook returns `disabled:
 * true` data and stays in `isLoading: false` — the leaderboard page renders
 * an "indexer not configured" empty state instead of error.
 *
 * Polling note: the indexer cadence is "on every `settle_market` event + a
 * 60s safety tick" per DR-010. We poll at 60s as a belt-and-suspenders for
 * the safety tick — Hard YES #9 ("no polling") applies to ON-CHAIN reads,
 * which is where it matters for correctness. The leaderboard endpoint is an
 * off-chain HTTP API and is safe to refetch on a generous interval. Tate
 * confirmed this Day-3 — see `coordination/cory_questions_1_answers.md`
 * §"REV 2".
 */
export function useLeaderboard(
  period: LeaderboardPeriod,
  opts: { enabled?: boolean; refetchIntervalMs?: number } = {},
): UseQueryResult<LeaderboardResponse> {
  const { enabled = true, refetchIntervalMs = 60_000 } = opts;
  const baseUrl = process.env.NEXT_PUBLIC_BELL_LEADERBOARD_URL ?? "";

  return useQuery<LeaderboardResponse>({
    queryKey: queryKeys.leaderboard(period),
    enabled: enabled && baseUrl.length > 0,
    refetchInterval: refetchIntervalMs,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const url = `${baseUrl.replace(/\/$/, "")}/leaderboard/${period}`;
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!resp.ok) {
        throw new Error(
          `Leaderboard fetch failed: ${resp.status} ${resp.statusText}`,
        );
      }
      return (await resp.json()) as LeaderboardResponse;
    },
  });
}

/** Lookup helper for "where do I rank?" — undefined if user isn't in top-N. */
export function userRankIn(
  board: LeaderboardResponse | undefined,
  user: PublicKey | null,
): LeaderboardEntry | undefined {
  if (!board || !user) return undefined;
  const target = user.toBase58();
  return board.entries.find((e) => e.userPubkey === target);
}
