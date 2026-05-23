"use client";

import { useCallback } from "react";
import {
  MarketState,
  Side,
  toNum,
  type OrderId,
  type RestingOrder,
} from "@ellipsis-labs/phoenix-sdk";
import { PublicKey } from "@solana/web3.js";

import { queryKeys } from "@/lib/queries/keys";
import { useAccountSubscription } from "./use-account-subscription";

/**
 * One resting Phoenix order for a trader. The fields a caller needs to:
 *  - Render a "your open orders" row (priceUi + sizeBaseLots + side).
 *  - Build a `CancelMultipleOrdersById` ix (side + priceInTicks +
 *    orderSequenceNumber — exactly what `buildCancelOrderTx` consumes).
 */
export interface OpenOrder {
  side: Side;
  priceInTicks: bigint;
  orderSequenceNumber: bigint;
  /** Human-readable price (quote per base). */
  priceUi: number;
  /** Resting size in base lots. */
  sizeBaseLots: bigint;
  /** Phoenix-tracked TTL. 0 = no expiry. */
  lastValidSlot: bigint;
}

export interface OpenOrdersSnapshot {
  market: PublicKey;
  trader: PublicKey | null;
  orders: OpenOrder[];
  uninitialized: boolean;
}

const EMPTY_RESULT = (
  market: PublicKey | null,
  trader: PublicKey | null,
  uninitialized: boolean,
): OpenOrdersSnapshot => ({
  market: market ?? PublicKey.default,
  trader,
  orders: [],
  uninitialized,
});

/**
 * Subscribe to a trader's resting orders on a Phoenix market. Same RPC
 * subscription Phoenix uses for the order book — Phoenix updates the market
 * account on every place/fill/cancel and the WebSocket bridge in
 * `useAccountSubscription` flushes the cache.
 *
 * Filters Phoenix's `MarketData.bids` + `MarketData.asks` by the trader's
 * index (looked up from `traderPubkeyToTraderIndex`). If the trader has no
 * seat on the market, returns `orders: []` with `uninitialized: false` —
 * Phoenix's IOC swaps (used by all four BellMarkets trade actions) are
 * seatless so most users never appear here.
 *
 * Hard YES #9: subscription-driven, no polling.
 */
export function useOpenOrders(
  phoenixMarketPda: PublicKey | null,
  trader: PublicKey | null,
) {
  const decode = useCallback(
    (info: { data: Buffer } | null): OpenOrdersSnapshot => {
      if (!phoenixMarketPda || !info) {
        return EMPTY_RESULT(phoenixMarketPda, trader, true);
      }
      try {
        const market = MarketState.load({
          address: phoenixMarketPda,
          buffer: info.data,
        });
        if (!trader) {
          return EMPTY_RESULT(phoenixMarketPda, trader, false);
        }
        const traderKey = trader.toBase58();
        const traderIndex =
          market.data.traderPubkeyToTraderIndex.get(traderKey);
        if (traderIndex === undefined) {
          // No seat = no resting orders. Empty list is the right answer.
          return EMPTY_RESULT(phoenixMarketPda, trader, false);
        }

        const orders: OpenOrder[] = [];
        const collect = (
          entries: Array<[OrderId, RestingOrder]>,
          side: Side,
        ) => {
          for (const [id, resting] of entries) {
            if (toNum(resting.traderIndex) !== traderIndex) continue;
            const priceInTicks = BigInt(toNum(id.priceInTicks));
            const seq = BigInt(toNum(id.orderSequenceNumber));
            orders.push({
              side,
              priceInTicks,
              orderSequenceNumber: seq,
              priceUi: market.ticksToFloatPrice(toNum(id.priceInTicks)),
              sizeBaseLots: BigInt(toNum(resting.numBaseLots)),
              lastValidSlot: BigInt(toNum(resting.lastValidSlot)),
            });
          }
        };

        collect(market.data.bids, Side.Bid);
        collect(market.data.asks, Side.Ask);

        return {
          market: phoenixMarketPda,
          trader,
          orders,
          uninitialized: false,
        };
      } catch {
        return EMPTY_RESULT(phoenixMarketPda, trader, true);
      }
    },
    [phoenixMarketPda, trader?.toBase58() ?? null], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return useAccountSubscription<OpenOrdersSnapshot>(
    phoenixMarketPda,
    decode,
    queryKeys.openOrders(phoenixMarketPda, trader),
  );
}
