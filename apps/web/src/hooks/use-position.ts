"use client";

import { useMemo } from "react";
import type { PublicKey } from "@solana/web3.js";

import { queryKeys } from "@/lib/queries/keys";
import type { StrikeMarket } from "@/lib/solana/types";

import { useMarketAccount } from "./use-market-account";
import { useTokenBalance } from "./use-token-balance";

export interface Position {
  yesBalance: bigint;
  noBalance: bigint;
  /** Position-exclusivity classification (Hard YES #8, UX-enforced). */
  side: "yes" | "no" | "both" | "none";
}

export interface UsePositionResult {
  /** Materialized position; `null` until both balances are known. */
  data: Position | null;
  /** Aggregate loading state — true while any of the three sub-queries is loading. */
  isLoading: boolean;
  /** First non-null error across the composed queries (market, yes, no). */
  error: Error | null;
  /** Underlying queries exposed for consumers that need direct access (refetch, etc.). */
  market: ReturnType<typeof useMarketAccount>;
  yes: ReturnType<typeof useTokenBalance>;
  no: ReturnType<typeof useTokenBalance>;
}

/**
 * Subscribe to a user's Yes + No token balances for a market. Both balances
 * update via WebSocket as the user trades. `side` summarizes for UI gating
 * per Hard YES #8 — "both" is a transient state during composite tx flows
 * (Buy No / Sell No bundle mint_pair with a Phoenix order), benign at rest.
 *
 * Composition layer: this combines `useMarketAccount(marketPda)` (to learn
 * yes_mint / no_mint) with two `useTokenBalance` calls. The Position object
 * is materialized client-side — there is no on-chain Position account.
 *
 * Return shape conforms to the project-wide `{ data, isLoading, error }`
 * contract (see `useAccountSubscription` for the canonical TanStack shape).
 * `data: null` means "data not yet available" (either still loading, or one
 * of the underlying ATAs has not been created yet).
 */
export function usePosition(
  wallet: PublicKey | null,
  marketPda: PublicKey | null,
): UsePositionResult {
  const market = useMarketAccount(marketPda);
  const data: StrikeMarket | null = market.data ?? null;

  const yes = useTokenBalance(
    data?.yesMint ?? null,
    wallet,
    queryKeys.position(wallet, marketPda),
  );
  const no = useTokenBalance(
    data?.noMint ?? null,
    wallet,
    [...queryKeys.position(wallet, marketPda), "no"],
  );

  const position = useMemo<Position | null>(() => {
    if (!yes.data || !no.data) return null;
    const yesAmount = yes.data.amount;
    const noAmount = no.data.amount;
    const side: Position["side"] =
      yesAmount > 0n && noAmount > 0n
        ? "both"
        : yesAmount > 0n
          ? "yes"
          : noAmount > 0n
            ? "no"
            : "none";
    return { yesBalance: yesAmount, noBalance: noAmount, side };
  }, [yes.data, no.data]);

  const error: Error | null =
    (market.error as Error | null) ??
    (yes.error as Error | null) ??
    (no.error as Error | null) ??
    null;

  return {
    market,
    yes,
    no,
    data: position,
    isLoading: market.isLoading || yes.isLoading || no.isLoading,
    error,
  };
}
