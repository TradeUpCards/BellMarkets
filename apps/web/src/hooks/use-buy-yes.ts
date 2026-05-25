"use client";

/**
 * DR-020 (deploy_index=7) deprecation note:
 *   This hook predates the in-program CLOB. The Phoenix-MarketState shape is
 *   gone; the new path is `trade-view.tsx` calling `buildBuyYesTx` directly
 *   with an OrderBookAccount snapshot. Kept as a stub so any stale import
 *   surfaces as a clear compile error rather than a silent runtime miss.
 *   Re-introduce a composition hook here once we have multiple call sites.
 */

export function useBuyYes(): never {
  throw new Error(
    "useBuyYes hook is deprecated under DR-020. Call buildBuyYesTx + useSendTransaction directly from your component (see trade-view.tsx).",
  );
}
