"use client";

import type { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import { useAccountSubscriptionOrNull } from "@/hooks/use-account-subscription";
import { queryKeys } from "@/lib/queries/keys";
import { deriveTickerConfigPda } from "@/lib/solana/pdas";

/**
 * Decoded `TickerConfig` shape per DR-005 / DR-006.
 *
 * Field names mirror DR-006 §"`TickerConfig` schema":
 *   cap_center, allowed_strikes, max_dev_bps, tick_size, threshold_bps,
 *   last_updated_slot, updated_by_phase.
 *
 * `strikePriceMicros` and `tickSizeMicros` use the Pyth-feed exponent scale
 * (typically e-8 or e-6 depending on feed). Allowed strikes are i64 micros.
 */
export interface TickerConfigView {
  pythFeed: PublicKey;
  capCenter: bigint;
  allowedStrikes: bigint[];
  maxDeviationBps: number;
  tickSizeMicros: bigint;
  thresholdBps: number;
  lastUpdatedSlot: bigint;
  updatedByPhase: "anchor" | "ah-window" | "pm-window" | "manual";
}

/**
 * Placeholder decoder. Returns `null` until Aria's IDL refresh lands AND the
 * `decodeTickerConfig` helper is added to `lib/solana/coder.ts`. The hook
 * still subscribes — empty account `data` returns null cleanly — so the
 * Markets table can render "ticker config loading" instead of "missing."
 *
 * When the IDL lands, replace this body with a `BorshAccountsCoder.decode`
 * call on the bytes (see `coder.ts` pattern for MarketConfig + StrikeMarket).
 */
function decodeTickerConfigPlaceholder(_data: Buffer): TickerConfigView | null {
  return null;
}

export function useTickerConfig(
  pythFeed: PublicKey | null,
): UseQueryResult<TickerConfigView | null> {
  const pda = useMemo(
    () => (pythFeed ? deriveTickerConfigPda(pythFeed)[0] : null),
    [pythFeed?.toBase58() ?? null], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return useAccountSubscriptionOrNull<TickerConfigView | null>(
    pda,
    decodeTickerConfigPlaceholder,
    queryKeys.tickerConfig(pythFeed),
  );
}
