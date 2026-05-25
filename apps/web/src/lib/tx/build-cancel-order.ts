import { BN, type Program, type Idl } from "@coral-xyz/anchor";
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

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import {
  deriveOrderBookPda,
  deriveUsdcEscrowPda,
  deriveYesEscrowPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";
import {
  SIDE_ASK,
  SIDE_BID,
} from "@/lib/solana/order-book";

export interface BuildCancelOrderParams {
  program: Program<Idl>;
  trader: PublicKey;
  /** BellMarkets `StrikeMarket` PDA. */
  marketPda: PublicKey;
  /** USDC mint pubkey from MarketConfig. */
  usdcMint: PublicKey;
  /** SIDE_BID (0) or SIDE_ASK (1) — the resting side being cancelled. */
  side: typeof SIDE_BID | typeof SIDE_ASK;
  /** Per-side monotonic seq from `Order.seq` (read from the order book). */
  seq: bigint;
}

export interface BuildCancelOrderResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  ix: TransactionInstruction;
}

/**
 * Build (don't send) a `cancel_order` transaction against the DR-020
 * in-program CLOB. The on-chain handler verifies `caller == order.owner`,
 * refunds the exact remaining escrow (USDC for bids, YES for asks) via
 * PDA-signed transfer, and removes the order from the book.
 *
 * Allowed while the market is paused or settled (recovery path).
 */
export async function buildCancelOrderTx(
  params: BuildCancelOrderParams,
): Promise<BuildCancelOrderResult> {
  const { program, trader, marketPda, usdcMint, side, seq } = params;

  const [config] = deriveMarketConfigPda();
  const [orderBook] = deriveOrderBookPda(marketPda);
  const [yesMint] = deriveYesMintPda(marketPda);
  const [usdcEscrow] = deriveUsdcEscrowPda(marketPda);
  const [yesEscrow] = deriveYesEscrowPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      userUsdc,
      trader,
      usdcMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      userYes,
      trader,
      yesMint,
    ),
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builders = (program.methods as any).cancelOrder;
  if (!builders) {
    throw new Error("buildCancelOrderTx: 'cancelOrder' missing from IDL.");
  }

  const ix: TransactionInstruction = await builders(side, new BN(seq.toString()))
    .accounts({
      user: trader,
      config,
      strikeMarket: marketPda,
      orderBook,
      yesMint,
      usdcMint,
      userYes,
      userUsdc,
      usdcEscrow,
      yesEscrow,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(ix);

  return { tx, prelude, ix };
}
