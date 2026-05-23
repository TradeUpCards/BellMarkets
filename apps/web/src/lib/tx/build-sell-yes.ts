import {
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

export interface BuildSellYesParams {
  phoenixMarket: MarketState;
  trader: PublicKey;
  /** Yes base lots to sell. */
  numBaseLots: number;
  /** Optional slippage floor: minimum USDC quote lots to receive. */
  minQuoteLotsToFill?: number;
}

/**
 * Build a single-instruction transaction that sells Yes tokens for USDC via
 * Phoenix IOC. Idempotent ATA-creation for USDC so first-time sellers'
 * proceeds land cleanly.
 */
export function buildSellYesTx(params: BuildSellYesParams): Transaction {
  const { phoenixMarket, trader, numBaseLots, minQuoteLotsToFill } = params;

  const quoteMint = phoenixMarket.data.header.quoteParams.mintKey;
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, trader, true);

  const prelude: TransactionInstruction[] = [
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
    side: PhoenixSide.Ask,
    numBaseLots,
    numQuoteLots: 0,
    minQuoteLotsToFill,
  });

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(swap);
  return tx;
}
