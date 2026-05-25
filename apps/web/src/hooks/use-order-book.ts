"use client";

import { useCallback, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";

import { queryKeys } from "@/lib/queries/keys";
import { deriveOrderBookPda } from "@/lib/solana/pdas";
import {
  PRICE_SCALE,
  decodeOrderBook,
  type OrderBookAccount,
} from "@/lib/solana/order-book";

import { useAccountSubscription } from "./use-account-subscription";

export interface OrderBookLevel {
  /** Price in dollars (USDC, e.g. `0.520`). */
  price: number;
  /** Macro-YES quantity (e.g. `200`). */
  quantity: number;
}

export interface OrderBook {
  market: PublicKey;
  /** Descending price (best bid first). */
  bids: OrderBookLevel[];
  /** Ascending price (best ask first). */
  asks: OrderBookLevel[];
  /** Midpoint price in dollars; `undefined` if either side is empty. */
  mid: number | undefined;
  /** Spread in dollars; `undefined` if either side is empty. */
  spread: number | undefined;
}

export interface OrderBookSnapshot {
  /** StrikeMarket PDA this book serves (not the OrderBook PDA — keeps consumers tied to the trade-route concept). */
  market: PublicKey;
  /** Decoded-for-UI view (dollar-denominated prices). `null` until the OrderBook account exists + has been `grow_order_book`'d. */
  book: OrderBook | null;
  /**
   * Raw on-chain account — full bigint fidelity, with `owner` / `seq` per
   * order. Required by the tx builders (place_order needs maker pubkeys to
   * construct `remaining_accounts`; cancel_order needs `seq`). `null` when
   * the account doesn't exist or is pre-grow.
   */
  raw: OrderBookAccount | null;
  /** True if the OrderBook PDA doesn't exist yet (`init_order_book` not yet run). */
  uninitialized: boolean;
}

const TOKEN_SCALE_F = 1_000_000;

function toUiLevels(orders: OrderBookAccount["bids" | "asks"]): OrderBookLevel[] {
  // Aggregate same-price orders so the L2 view shows one row per price level.
  const acc = new Map<bigint, bigint>();
  for (const o of orders) {
    acc.set(o.price, (acc.get(o.price) ?? 0n) + o.size);
  }
  return [...acc.entries()].map(([price, size]) => ({
    price: Number(price) / Number(PRICE_SCALE),
    quantity: Number(size) / TOKEN_SCALE_F,
  }));
}

/**
 * Subscribe to a strike's in-program CLOB OrderBook (DR-020, deploy_index=7).
 *
 * - Pass the `StrikeMarket` PDA; the OrderBook PDA is derived internally via
 *   `[b"order_book", strike_market]`.
 * - Returns `null` book + `uninitialized: true` when no account exists yet
 *   (typically because `init_order_book` hasn't been cranked for this strike).
 * - Returns `null` book + `uninitialized: false` if the account exists but is
 *   pre-`grow_order_book` size — trading is gated off on chain in that case.
 *
 * Subscription-driven via `connection.onAccountChange` per Hard YES #9 (no
 * polling). The WebSocket bridge writes decoded snapshots into the cache on
 * every place/cancel/match-induced state change.
 *
 * Aggregates same-price `Order` slots into single `OrderBookLevel` rows so
 * the UI shows the conventional L2 view. The `raw` field exposes the
 * per-order data the tx builders need.
 */
export function useOrderBook(strikeMarketPda: PublicKey | null) {
  const orderBookPda = useMemo(() => {
    if (!strikeMarketPda) return null;
    return deriveOrderBookPda(strikeMarketPda)[0];
  }, [strikeMarketPda]);

  const decode = useCallback(
    (info: { data: Buffer } | null): OrderBookSnapshot => {
      if (!strikeMarketPda) {
        return {
          market: PublicKey.default,
          book: null,
          raw: null,
          uninitialized: true,
        };
      }
      if (!info) {
        return {
          market: strikeMarketPda,
          book: null,
          raw: null,
          uninitialized: true,
        };
      }
      const raw = decodeOrderBook(info.data);
      if (!raw) {
        // Pre-grow account — trading gate rejects on chain.
        return {
          market: strikeMarketPda,
          book: null,
          raw: null,
          uninitialized: false,
        };
      }
      const bids = toUiLevels(raw.bids);
      const asks = toUiLevels(raw.asks);
      const bestBid = bids[0]?.price;
      const bestAsk = asks[0]?.price;
      return {
        market: strikeMarketPda,
        book: {
          market: strikeMarketPda,
          bids,
          asks,
          mid:
            bestBid !== undefined && bestAsk !== undefined
              ? (bestBid + bestAsk) / 2
              : undefined,
          spread:
            bestBid !== undefined && bestAsk !== undefined
              ? bestAsk - bestBid
              : undefined,
        },
        raw,
        uninitialized: false,
      };
    },
    [strikeMarketPda],
  );

  return useAccountSubscription<OrderBookSnapshot>(
    orderBookPda,
    decode,
    queryKeys.orderBook(orderBookPda),
  );
}
