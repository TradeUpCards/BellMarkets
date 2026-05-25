import type { Program, Idl } from "@coral-xyz/anchor";
import type {
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import {
  SIDE_ASK,
  type OrderBookAccount,
  planFills,
} from "@/lib/solana/order-book";
import { buildPlaceOrderTx, type BuildPlaceOrderResult } from "./build-place-order";

export interface BuildSellYesParams {
  program: Program<Idl>;
  trader: PublicKey;
  marketPda: PublicKey;
  usdcMint: PublicKey;
  /** Live OrderBook snapshot (required for crossing/market plans). */
  book: OrderBookAccount | null;
  /** YES base units to sell. */
  size: bigint;
  /**
   * For limit: ask price in USDC base units per YES, range [1, PRICE_SCALE].
   * For market: ignored on chain (pass 0n).
   */
  price: bigint;
  isMarket: boolean;
}

export type BuildSellYesResult = BuildPlaceOrderResult & {
  plannedFilled: bigint;
  plannedRest: bigint;
};

/**
 * Sell YES via the DR-020 in-program CLOB. Wraps `place_order` on the ask
 * side. Escrow on chain = `size` YES tokens — refunded on cancel / unfilled
 * market remainder.
 */
export async function buildSellYesTx(
  params: BuildSellYesParams,
): Promise<Transaction> {
  const built = await buildSellYesBuilt(params);
  return built.tx;
}

export async function buildSellYesBuilt(
  params: BuildSellYesParams,
): Promise<BuildSellYesResult> {
  const { program, trader, marketPda, usdcMint, book, size, price, isMarket } =
    params;

  const plan = book
    ? planFills(book, SIDE_ASK, price, size, isMarket)
    : { fills: [], totalFilled: 0n, remaining: size };

  const result = await buildPlaceOrderTx({
    program,
    trader,
    marketPda,
    usdcMint,
    side: SIDE_ASK,
    price,
    size,
    isMarket,
    plannedFills: plan.fills,
  });

  return {
    ...result,
    plannedFilled: plan.totalFilled,
    plannedRest: isMarket ? 0n : plan.remaining,
  };
}
