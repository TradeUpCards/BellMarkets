"use client";

import type { PublicKey } from "@solana/web3.js";
import { useCallback, useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import { useAccountSubscriptionOrNull } from "@/hooks/use-account-subscription";
import { queryKeys } from "@/lib/queries/keys";
import { decodeTickerConfig } from "@/lib/solana/coder";
import { deriveTickerConfigPda } from "@/lib/solana/pdas";
import type { TickerConfig } from "@/lib/solana/types";

/**
 * Subscribe to a per-ticker TickerConfig PDA (DR-005 / DR-006). Drives the
 * Markets-grid strike-availability column + the DR-011 earnings-eve
 * "wider strikes available" indicator.
 *
 * Hard YES #9 compliant — WebSocket subscription via
 * `useAccountSubscriptionOrNull`. Returns `null` until the PDA is fetched
 * or if the account doesn't exist yet (admin/cron hasn't run
 * `update_ticker_config` for this feed).
 */
export function useTickerConfig(
  pythFeed: PublicKey | null,
): UseQueryResult<TickerConfig | null> {
  const pda = useMemo(
    () => (pythFeed ? deriveTickerConfigPda(pythFeed)[0] : null),
    [pythFeed?.toBase58() ?? null], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const decode = useCallback(
    (data: Buffer): TickerConfig => decodeTickerConfig(data),
    [],
  );

  return useAccountSubscriptionOrNull<TickerConfig>(
    pda,
    decode,
    queryKeys.tickerConfig(pythFeed),
  );
}
