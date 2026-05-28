"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { queryKeys } from "@/lib/queries/keys";

export interface SpotPriceResponse {
  ok: true;
  ticker: string;
  priceUsd: number;
  expo: number;
  publishTime: number;
  publishTimeIso: string;
  feedId: string;
  source: "pyth-hermes";
}

/**
 * Live MAG7 spot price via Bram's `/api/spot/[ticker]` Pyth Hermes proxy
 * (commit 447e322).
 *
 * Polls every 5 seconds. Bram's edge cache (s-maxage=3,
 * stale-while-revalidate=10) collapses concurrent browser polls to ~1
 * upstream Hermes call per edge region per 3s window, so this isn't
 * punishing on Hermes quotas.
 *
 * Returns `undefined` while the first fetch is in flight; callers should
 * fall back to the static `DEMO_STRIKE_MARKETS[].spot` snapshot for the
 * initial render to avoid a "—" flash.
 */
export function useSpotPrice(
  ticker: string | null,
): UseQueryResult<SpotPriceResponse | null> {
  return useQuery<SpotPriceResponse | null>({
    queryKey: queryKeys.spotPrice(ticker),
    queryFn: async () => {
      if (!ticker) return null;
      const res = await fetch(`/api/spot/${ticker.toUpperCase()}`, {
        cache: "default", // honor Bram's edge cache headers
      });
      if (!res.ok) {
        throw new Error(`/api/spot/${ticker} returned ${res.status}`);
      }
      return (await res.json()) as SpotPriceResponse;
    },
    enabled: ticker !== null && ticker.length > 0,
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: false,
  });
}
