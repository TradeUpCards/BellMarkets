import type { Program, Idl } from "@coral-xyz/anchor";
import type {
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import {
  SIDE_BID,
  type OrderBookAccount,
  planFills,
} from "@/lib/solana/order-book";
import { buildPlaceOrderTx, type BuildPlaceOrderResult } from "./build-place-order";

export interface BuildBuyYesParams {
  program: Program<Idl>;
  trader: PublicKey;
  /** BellMarkets `StrikeMarket` PDA. */
  marketPda: PublicKey;
  /** USDC mint pubkey from MarketConfig. */
  usdcMint: PublicKey;
  /** Live OrderBook snapshot for off-chain plan_fills (required when isMarket=true or limit crosses). */
  book: OrderBookAccount | null;
  /**
   * YES base units to buy (10^6 = one macro YES). On chain, escrow is up to
   * `size` USDC base units (worst-case price = $1) for market orders.
   */
  size: bigint;
  /**
   * For limit: price in USDC base units per YES, range [1, PRICE_SCALE].
   * For market: ignored on chain (pass 0n).
   */
  price: bigint;
  isMarket: boolean;
}

export type BuildBuyYesResult = BuildPlaceOrderResult & {
  /** Total YES filled in the planning phase (incoming bid + crossing fills). */
  plannedFilled: bigint;
  /** YES that would rest on the book after fills (limit only; 0 for market). */
  plannedRest: bigint;
};

/**
 * Buy YES via the DR-020 in-program CLOB. Wraps `place_order` on the bid
 * side. For limit orders we walk the off-chain `book` to plan crossing
 * fills + maker payout ATAs; for market orders we drain the asks
 * best-first.
 *
 * Caller is responsible for the pre-flight UI check:
 *   - Market orders with empty asks book → refund silently (no fill, no
 *     stranded state — single-ix bid is a no-op).
 *   - Limit orders that don't cross → escrow USDC + rest on the book.
 *
 * The atomic Buy NO path is in `build-buy-no.ts` — it bundles `mint_pair` +
 * `place_order(side=ASK, market)` and enforces fill-or-revert at the
 * builder level.
 */
export async function buildBuyYesTx(
  params: BuildBuyYesParams,
): Promise<Transaction> {
  const built = await buildBuyYesBuilt(params);
  return built.tx;
}

export async function buildBuyYesBuilt(
  params: BuildBuyYesParams,
): Promise<BuildBuyYesResult> {
  const { program, trader, marketPda, usdcMint, book, size, price, isMarket } =
    params;

  const plan = book
    ? planFills(book, SIDE_BID, price, size, isMarket)
    : { fills: [], totalFilled: 0n, remaining: size };

  const result = await buildPlaceOrderTx({
    program,
    trader,
    marketPda,
    usdcMint,
    side: SIDE_BID,
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
