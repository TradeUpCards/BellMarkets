"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import type { MarketState } from "@ellipsis-labs/phoenix-sdk";

import { buildBuyYesTx } from "@/lib/tx/build-buy-yes";
import { queryKeys } from "@/lib/queries/keys";

import { useSendTransaction } from "./use-send-transaction";
import type { TokenBalance } from "./use-token-balance";

export interface UseBuyYesArgs {
  /** Phoenix Yes/USDC market for this strike (from useOrderBook → market). */
  phoenixMarket: MarketState;
  /** BellMarkets `StrikeMarket` PDA. */
  marketPda: PublicKey;
}

export interface BuyYesParams {
  numQuoteLots: number;
  minBaseLotsToFill?: number;
  /**
   * Expected Yes base lots the user will receive (computed from the order
   * book ladder by the caller). Used for the optimistic balance bump — the
   * WebSocket bridge reconciles to actual once the on-chain ATA changes.
   */
  expectedYesLotsOut?: bigint;
}

/**
 * High-level "Buy Yes" composition. Reference pattern for the four trade
 * actions — the Trade panel composes `useBuyYes`, `useSellYes`, `useBuyNo`,
 * `useSellNo` from this same shape.
 *
 * **Optimistic update**: when caller passes `expectedYesLotsOut`, we bump
 * the cached Yes balance immediately on send. The WebSocket bridge in
 * `useAccountSubscription` overwrites the cache with the real on-chain
 * value once the trade fills — typically within ~1-2 s on devnet. If the
 * tx fails, `useSendTransaction.error` surfaces in the consumer and the
 * cache stays as-bumped until the next account event lands; for Day-3 we
 * accept that small inconsistency window. A proper rollback would require
 * snapshotting `queryClient.getQueryData(key)` pre-bump and restoring on
 * error — straightforward addition when the Trade panel demands it.
 *
 * Position-exclusivity (Hard YES #8) is enforced at the UI layer, not here.
 * The Trade panel inspects `usePosition().side` and disables the wrong-side
 * buttons; this hook just executes whatever it's called with.
 */
export function useBuyYes({ phoenixMarket, marketPda }: UseBuyYesArgs) {
  const { publicKey: trader } = useWallet();
  const queryClient = useQueryClient();

  const positionKey = trader
    ? queryKeys.position(trader, marketPda)
    : null;

  const sendTx = useSendTransaction({
    invalidateOnSuccess: positionKey ? [positionKey] : [],
  });

  const send = useCallback(
    async (params: BuyYesParams) => {
      if (!trader) throw new Error("useBuyYes: wallet not connected");

      const tx = buildBuyYesTx({
        phoenixMarket,
        trader,
        numQuoteLots: params.numQuoteLots,
        minBaseLotsToFill: params.minBaseLotsToFill,
      });

      // Optimistic balance bump — only when the caller has an expectation.
      // Runs synchronously before broadcast so the UI updates the instant
      // the user clicks; WebSocket reconciliation lands ~1-2 s later.
      if (params.expectedYesLotsOut !== undefined && positionKey) {
        const delta = params.expectedYesLotsOut;
        queryClient.setQueryData<TokenBalance | null>(positionKey, (prev) => {
          if (!prev) return prev ?? null;
          return {
            ...prev,
            amount: prev.amount + delta,
            uninitialized: false,
          };
        });
      }

      return sendTx.send(tx);
    },
    [trader, phoenixMarket, sendTx, positionKey, queryClient],
  );

  return {
    send,
    isPending: sendTx.isPending,
    error: sendTx.error,
    signature: sendTx.signature,
    status: sendTx.status,
    reset: sendTx.reset,
  };
}
