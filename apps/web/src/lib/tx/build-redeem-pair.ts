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
  deriveNoMintPda,
  deriveUsdcVaultPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";

import { callAnchorMethod } from "./anchor-helper";

export interface BuildRedeemPairParams {
  program: Program<Idl>;
  trader: PublicKey;
  marketPda: PublicKey;
  usdcMint: PublicKey;
  /** Pair count to redeem. Burns this many YES + NO; refunds `amount` USDC. */
  amount: bigint;
}

export interface BuildRedeemPairResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  ix: TransactionInstruction;
}

/**
 * Build the standalone `redeem_pair` transaction — pre-settlement burn of an
 * equal pair of YES + NO tokens for $1 USDC each. Inverse of `mint_pair`,
 * and the recovery path for users who somehow end up with matched pairs
 * (typically a partial-fill that didn't end up atomic, or a Buy YES trade
 * strategy that wants to unwind into cash).
 *
 * No fee, permissionless, pre-settle only. Same `redeem_pair` ix used as the
 * second leg of `buildSellNoTx`.
 */
export async function buildRedeemPairTx(
  params: BuildRedeemPairParams,
): Promise<BuildRedeemPairResult> {
  const { program, trader, marketPda, usdcMint, amount } = params;

  if (amount <= 0n) {
    throw new Error("buildRedeemPairTx: amount must be > 0");
  }

  const [config] = deriveMarketConfigPda();
  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  const [usdcVault] = deriveUsdcVaultPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);
  const userNo = getAssociatedTokenAddressSync(noMint, trader, true);

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(trader, userUsdc, trader, usdcMint),
  ];

  const ix = await callAnchorMethod(
    program,
    "redeemPair",
    new BN(amount.toString()),
    {
      user: trader,
      config,
      strikeMarket: marketPda,
      yesMint,
      noMint,
      userYes,
      userNo,
      usdcVault,
      userUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(ix);

  return { tx, prelude, ix };
}
