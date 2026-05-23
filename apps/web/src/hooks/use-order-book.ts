"use client";

import { useCallback } from "react";
import { MarketState, type UiLadder } from "@ellipsis-labs/phoenix-sdk";
import { PublicKey } from "@solana/web3.js";

import { queryKeys } from "@/lib/queries/keys";

import { useAccountSubscription } from "./use-account-subscription";

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  market: PublicKey;
  /** Descending price (best bid first). */
  bids: OrderBookLevel[];
  /** Ascending price (best ask first). */
  asks: OrderBookLevel[];
  /** Midpoint price; `undefined` if either side is empty. */
  mid: number | undefined;
  /** Spread in quote-token units; `undefined` if either side is empty. */
  spread: number | undefined;
}

export interface OrderBookSnapshot {
  market: PublicKey;
  book: OrderBook | null;
  /** True if the Phoenix market account does not exist on chain yet. */
  uninitialized: boolean;
}

const EMPTY: UiLadder = { bids: [], asks: [] };

/**
 * Subscribe to a Phoenix v1 FIFO market's order book. Subscription-driven —
 * Phoenix updates the market account on every fill / place / cancel and the
 * WebSocket bridge in `useAccountSubscription` writes the new snapshot into
 * the cache.
 *
 * `levels` controls L2 depth (default 10). Returns `null` book when the
 * account doesn't exist yet (no devnet markets created until Aria's
 * `create_strike_market` runs against a real Phoenix market — see her
 * handoff §"Risks" #1).
 *
 * Phoenix's `UiLadder` quantities are already in "raw base units" — for
 * BellMarkets these are Yes tokens (or No tokens, depending on which
 * Phoenix market you subscribe to). Caller is responsible for understanding
 * the base / quote orientation of the specific Phoenix market.
 */
export function useOrderBook(
  phoenixMarketPda: PublicKey | null,
  levels: number = 10,
) {
  const decode = useCallback(
    (info: { data: Buffer } | null): OrderBookSnapshot => {
      if (!phoenixMarketPda) {
        return {
          market: PublicKey.default,
          book: null,
          uninitialized: true,
        };
      }
      if (!info) {
        return {
          market: phoenixMarketPda,
          book: null,
          uninitialized: true,
        };
      }
      try {
        const market = MarketState.load({
          address: phoenixMarketPda,
          buffer: info.data,
        });
        const ladder: UiLadder = market.getUiLadder(levels) ?? EMPTY;
        const bestBid = ladder.bids[0]?.price;
        const bestAsk = ladder.asks[0]?.price;
        return {
          market: phoenixMarketPda,
          book: {
            market: phoenixMarketPda,
            bids: ladder.bids,
            asks: ladder.asks,
            mid:
              bestBid !== undefined && bestAsk !== undefined
                ? (bestBid + bestAsk) / 2
                : undefined,
            spread:
              bestBid !== undefined && bestAsk !== undefined
                ? bestAsk - bestBid
                : undefined,
          },
          uninitialized: false,
        };
      } catch {
        // Non-Phoenix account at this address, or malformed buffer.
        return {
          market: phoenixMarketPda,
          book: null,
          uninitialized: true,
        };
      }
    },
    [phoenixMarketPda, levels],
  );

  return useAccountSubscription<OrderBookSnapshot>(
    phoenixMarketPda,
    decode,
    queryKeys.orderBook(phoenixMarketPda),
  );
}
