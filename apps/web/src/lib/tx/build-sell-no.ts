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

import { deriveNoMintPda, deriveYesMintPda } from "@/lib/solana/pdas";

import { callAnchorMethod } from "./anchor-helper";
import { PhoenixSide, buildPhoenixSwapIx } from "./phoenix";

export interface BuildSellNoParams {
  program: Program<Idl>;
  trader: PublicKey;
  /** BellMarkets `StrikeMarket` PDA (Anchor-owned). */
  marketPda: PublicKey;
  /** Phoenix Yes/USDC market loaded via MarketState.load(). */
  phoenixMarket: MarketState;
  /** USDC mint pubkey from MarketConfig. */
  usdcMint: PublicKey;
  /** No tokens to sell. Also the exact amount of Yes to buy + pair to redeem. */
  amount: bigint;
  /** Max USDC the trader is willing to spend on the Phoenix buy leg (slippage cap). */
  maxQuoteLotsToSpend: number;
}

export interface BuildSellNoResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  /** Phoenix swap (buy Yes for USDC). */
  buyYesIx: TransactionInstruction;
  /** BellMarkets redeem_pair (burn equal Yes+No for `amount` USDC back). */
  redeemPairIx: TransactionInstruction;
}

/**
 * Build the **atomic** Sell-No transaction per POV-3 / `specs/architecture.md`
 * §103 + Aria's `redeem_pair` instruction (her Day-3 follow-up that unblocked
 * this flow):
 *
 *   tx = [
 *     <ATA creates>,
 *     phoenix.swap(Side.Bid, numBaseLots=amount),   // buy exactly `amount` Yes
 *     bell_markets.redeem_pair(amount),             // burn amount Yes + amount No → amount USDC
 *   ]
 *
 * Net effect: user's No balance drops by `amount`, USDC balance net up by
 * approximately `amount * (1 - yesAsk)` (the difference between the $1
 * pair-redemption and the Phoenix swap cost). The user never sees an
 * intermediate Yes balance — POV-3 atomicity enforced at the tx level.
 *
 * Why `numBaseLots=amount` + `minBaseLotsToFill=amount` rather than a quote
 * budget: `redeem_pair` requires the user to hold EXACTLY `amount` Yes
 * (plus their existing `amount` No). If Phoenix returns fewer Yes due to
 * slippage, the redeem leg fails. By demanding exact base-lot fill with a
 * quote-lot ceiling, we abort the whole tx atomically if liquidity can't
 * support it — better UX than a half-completed flow.
 *
 * Tx-size note: same budget concerns as `buildBuyNoTx` apply (ATA creates +
 * 2 main ixes ≈ ~900 b under the 1232 cap). Documented escape hatch: split
 * ATA creates into a one-time setup tx per user per market.
 */
export async function buildSellNoTx(
  params: BuildSellNoParams,
): Promise<BuildSellNoResult> {
  const {
    program,
    trader,
    marketPda,
    phoenixMarket,
    usdcMint,
    amount,
    maxQuoteLotsToSpend,
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

  // Safety guard: Phoenix market base mint must match our derived yes_mint.
  // Mirrors the check in buildBuyNoTx — catches wrong-market arguments early.
  const phoenixBase = phoenixMarket.data.header.baseParams.mintKey;
  if (!phoenixBase.equals(yesMint)) {
    throw new Error(
      `buildSellNoTx: phoenixMarket.base (${phoenixBase.toBase58()}) != derived yes_mint (${yesMint.toBase58()}). Mismatched market arguments.`,
    );
  }

  const buyYesIx = buildPhoenixSwapIx({
    market: phoenixMarket,
    trader,
    side: PhoenixSide.Bid,
    numBaseLots: Number(amount),
    numQuoteLots: maxQuoteLotsToSpend,
    // Demand the exact amount or fail the tx — see docstring.
    minBaseLotsToFill: Number(amount),
  });

  const redeemPairIx = await callAnchorMethod(
    program,
    "redeemPair",
    new BN(amount.toString()),
    {
      user: trader,
      strikeMarket: marketPda,
      userYes,
      userNo,
      userUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(buyYesIx);
  tx.add(redeemPairIx);

  return { tx, prelude, buyYesIx, redeemPairIx };
}
