import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { MarketState } from "@ellipsis-labs/phoenix-sdk";

import { PhoenixSide, buildPhoenixSwapIx } from "./phoenix";

export interface BuildBuyYesParams {
  /** Phoenix Yes/USDC market, already loaded (likely from useOrderBook). */
  phoenixMarket: MarketState;
  trader: PublicKey;
  /** USDC quote lots to spend (the size budget). */
  numQuoteLots: number;
  /** Optional slippage floor: minimum Yes base lots to receive. */
  minBaseLotsToFill?: number;
}

/**
 * Build a single-instruction transaction that buys Yes tokens for USDC via
 * Phoenix IOC. Includes idempotent ATA-creation for the Yes mint + USDC mint
 * so first-time buyers don't fail at the token-account step.
 *
 * No interaction with the BellMarkets Anchor program — Yes/USDC trades go
 * straight to Phoenix per the architecture (CLOB is the matching engine,
 * BellMarkets owns vaults + settlement only).
 */
export function buildBuyYesTx(params: BuildBuyYesParams): Transaction {
  const { phoenixMarket, trader, numQuoteLots, minBaseLotsToFill } = params;

  const baseMint = phoenixMarket.data.header.baseParams.mintKey;
  const quoteMint = phoenixMarket.data.header.quoteParams.mintKey;
  const baseAta = getAssociatedTokenAddressSync(baseMint, trader, true);
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, trader, true);

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      baseAta,
      trader,
      baseMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      quoteAta,
      trader,
      quoteMint,
    ),
  ];

  const swap = buildPhoenixSwapIx({
    market: phoenixMarket,
    trader,
    side: PhoenixSide.Bid,
    numBaseLots: 0,
    numQuoteLots,
    minBaseLotsToFill,
  });

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(swap);
  return tx;
}
