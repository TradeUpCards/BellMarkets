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
  /** BellMarkets `StrikeMarket` PDA. */
  marketPda: PublicKey;
  /** USDC mint pubkey from MarketConfig.usdc_mint. */
  usdcMint: PublicKey;
  /** Pair count to redeem. Burns this many YES + NO, refunds `amount` USDC. */
  amount: bigint;
}

export interface BuildRedeemPairResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  ix: TransactionInstruction;
}

/**
 * Build the standalone `redeem_pair` transaction — pre-settlement burn of an
 * equal pair of YES + NO tokens for $1 USDC each. This is the inverse of
 * `mint_pair` and the recovery path for users who somehow end up holding
 * matched pairs (e.g., a partial-fill that escaped the IOC gate, a malformed
 * UI bypass, or a deliberate Buy YES → trade strategy that wants to unwind).
 *
 * Mirrors the `redeem_pair` ix shape already used by `buildSellNoTx` — the
 * difference is just the absence of the Phoenix swap leg. No fee surface,
 * permissionless (any user, any time before settlement).
 */
export async function buildRedeemPairTx(
  params: BuildRedeemPairParams,
): Promise<BuildRedeemPairResult> {
  const { program, trader, marketPda, usdcMint, amount } = params;

  const [config] = deriveMarketConfigPda();
  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  const [usdcVault] = deriveUsdcVaultPda(marketPda);

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
