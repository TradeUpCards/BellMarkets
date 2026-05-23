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

import type { Outcome, StrikeMarket } from "@/lib/solana/types";
import { outcomeTag } from "@/lib/solana/types";

import { callAnchorMethod } from "./anchor-helper";

export interface BuildRedeemParams {
  program: Program<Idl>;
  user: PublicKey;
  marketPda: PublicKey;
  /** Decoded StrikeMarket — caller already has it from `useMarketAccount`. */
  market: StrikeMarket;
  /** USDC mint pubkey from MarketConfig.usdc_mint. */
  usdcMint: PublicKey;
  /** Token amount to burn (u64 on chain). */
  amount: bigint;
}

export interface BuildRedeemResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  ix: TransactionInstruction;
  /**
   * Which on-chain instruction was used:
   *  - "yes" / "no": `redeem(amount)` against the winning mint
   *  - "invalid":    `redeem_invalid(amount)` — burns equal Yes+No for full refund
   */
  branch: "yes" | "no" | "invalid";
}

/**
 * Build (don't send) a Transaction that redeems against a SETTLED
 * StrikeMarket. Dispatches by outcome:
 *
 *   - `Outcome::Yes` or `Outcome::No`  → `redeem(amount)` with the winning mint
 *   - `Outcome::Invalid`               → `redeem_invalid(amount)` — burns
 *                                        equal Yes+No, refunds `amount` USDC
 *                                        (per Aria's Day-3 follow-up)
 *   - `Outcome::Unsettled`             → throws (use `buildSellNoTx` /
 *                                        `buildBuyNoTx` for pre-settlement
 *                                        liquidation, both atomic via
 *                                        `redeem_pair` under the hood)
 */
export async function buildRedeemTx(
  params: BuildRedeemParams,
): Promise<BuildRedeemResult> {
  const { program, user, marketPda, market, usdcMint, amount } = params;

  const tag = outcomeTag(market.outcome);
  if (tag === "unsettled") {
    throw new Error(
      "buildRedeemTx: market is unsettled — use buildSellNoTx or buildBuyNoTx for pre-settlement liquidation.",
    );
  }

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user, true);
  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdcMint,
    ),
  ];

  // Invalid branch — Aria's `redeem_invalid` instruction. Burns equal
  // amounts of Yes + No, transfers `amount` USDC back from the vault. The
  // shape mirrors `redeem_pair` (pre-settle) but is gated on Outcome=Invalid.
  if (tag === "invalid") {
    const userYes = getAssociatedTokenAddressSync(market.yesMint, user, true);
    const userNo = getAssociatedTokenAddressSync(market.noMint, user, true);
    const ix = await callAnchorMethod(
      program,
      "redeemInvalid",
      new BN(amount.toString()),
      {
        user,
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
    tx.add(ix);
    return { tx, prelude, ix, branch: "invalid" };
  }

  // Yes / No branches — standard binary payout via the `redeem` instruction.
  const winningSide: "yes" | "no" = tag === "yes" ? "yes" : "no";
  const winningMint = winningSide === "yes" ? market.yesMint : market.noMint;
  const userWinningToken = getAssociatedTokenAddressSync(winningMint, user, true);

  const ix = await callAnchorMethod(
    program,
    "redeem",
    new BN(amount.toString()),
    {
      user,
      strikeMarket: marketPda,
      winningMint,
      userWinningToken,
      userUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(ix);

  return { tx, prelude, ix, branch: winningSide };
}

/**
 * UI gating predicate. Now that `redeem_invalid` is shipped, every settled
 * outcome (Yes / No / Invalid) has a callable redeem path. Only Unsettled
 * remains non-redeemable — those positions liquidate via the atomic Buy No
 * / Sell No flows that use `redeem_pair` under the hood.
 */
export function canRedeem(outcome: Outcome): boolean {
  return outcomeTag(outcome) !== "unsettled";
}
