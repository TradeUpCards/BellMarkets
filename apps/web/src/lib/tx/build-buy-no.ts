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
import type { MarketState } from "@ellipsis-labs/phoenix-sdk";

import {
  deriveNoMintPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";

import { callAnchorMethod } from "./anchor-helper";
import { PhoenixSide, buildPhoenixSwapIx } from "./phoenix";

export interface BuildBuyNoParams {
  program: Program<Idl>;
  trader: PublicKey;
  /** BellMarkets `StrikeMarket` PDA (Anchor-owned). */
  marketPda: PublicKey;
  /** Phoenix Yes/USDC market loaded via MarketState.load(). */
  phoenixMarket: MarketState;
  /** USDC mint pubkey from MarketConfig. */
  usdcMint: PublicKey;
  /** Pair count to mint = also the base lots sold on Phoenix. */
  amount: bigint;
  /** Slippage floor on the Phoenix sell-Yes leg. */
  minQuoteLotsToFill?: number;
}

export interface BuildBuyNoResult {
  tx: Transaction;
  /** ATA-creation ixes prepended. */
  prelude: TransactionInstruction[];
  /** The BellMarkets mint_pair ix. */
  mintPairIx: TransactionInstruction;
  /** The Phoenix swap (sell Yes) ix. */
  sellYesIx: TransactionInstruction;
}

/**
 * Build the **atomic** Buy-No transaction per POV-3 / `specs/architecture.md`
 * §"Buy No / Sell No atomicity":
 *
 *   tx = [
 *     <ATA creates>,
 *     mint_pair(amount),          // → Yes:+amount, No:+amount, USDC:-amount
 *     phoenix.swap(Side.Ask, numBaseLots=amount),  // → Yes:-amount, USDC:+~(amount * bid)
 *   ]
 *
 * Net effect: user holds `+amount` No tokens, paid roughly `amount * (1-bid)`
 * USDC. The user never sees intermediate Yes balances — POV-3 atomicity is
 * enforced at the tx level by both instructions being in one signed bundle.
 *
 * Caveat — tx size budget: a Solana tx is capped at 1232 bytes. With the
 * three ATA prelude ixes + mint_pair + Phoenix swap we land around ~900 b
 * (rough), within budget. If the actual signed tx ever overflows, the ATA
 * creates can be moved into a separate setup tx (one-time per user per
 * market) so the trade itself stays single-tx. Day-3 visual layer should
 * not yet attempt this optimization.
 */
export async function buildBuyNoTx(
  params: BuildBuyNoParams,
): Promise<BuildBuyNoResult> {
  const {
    program,
    trader,
    marketPda,
    phoenixMarket,
    usdcMint,
    amount,
    minQuoteLotsToFill,
  } = params;

  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);
  const userNo = getAssociatedTokenAddressSync(noMint, trader, true);

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
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      userNo,
      trader,
      noMint,
    ),
  ];

  const mintPairIx = await callAnchorMethod(
    program,
    "mintPair",
    new BN(amount.toString()),
    {
      user: trader,
      strikeMarket: marketPda,
      userUsdc,
      userYes,
      userNo,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

  // Phoenix's Yes/USDC market base mint MUST match our derived yes_mint —
  // safety guard against the trader passing a phoenixMarket that belongs to
  // a different StrikeMarket. Catches a misuse pattern early.
  const phoenixBase = phoenixMarket.data.header.baseParams.mintKey;
  if (!phoenixBase.equals(yesMint)) {
    throw new Error(
      `buildBuyNoTx: phoenixMarket.base (${phoenixBase.toBase58()}) != derived yes_mint (${yesMint.toBase58()}). Mismatched market arguments.`,
    );
  }

  const sellYesIx = buildPhoenixSwapIx({
    market: phoenixMarket,
    trader,
    side: PhoenixSide.Ask,
    numBaseLots: Number(amount),
    numQuoteLots: 0,
    minQuoteLotsToFill,
  });

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(mintPairIx);
  tx.add(sellYesIx);

  return { tx, prelude, mintPairIx, sellYesIx };
}
