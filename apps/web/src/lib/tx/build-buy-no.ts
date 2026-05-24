import { BN, type Program, type Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { MarketState } from "@ellipsis-labs/phoenix-sdk";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import {
  deriveFeeConfigPda,
  deriveMonthlyPoolPda,
  deriveNoMintPda,
  deriveUsdcVaultPda,
  deriveUserConfigPda,
  deriveWeeklyPoolPda,
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
  /** `MarketConfig.treasury` — fee-collector wallet (drives fee_collector_usdc ATA). */
  treasury: PublicKey;
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
 * Build the **atomic** Buy-No transaction per POV-3:
 *
 *   tx = [
 *     <ATA creates>,
 *     mint_pair(amount),          // → Yes:+amount, No:+amount, USDC:-(amount + fee)
 *     phoenix.swap(Side.Ask, numBaseLots=amount),  // → Yes:-amount, USDC:+~(amount * bid)
 *   ]
 *
 * Now wired against the 20-ix IDL's `mint_pair` shape — threads the full
 * DR-008/010 fee surface (fee_config, user_config, fee_collector_usdc,
 * weekly_pool, monthly_pool, clock). On the pre-flip default state
 * (`mint_fee_bps == 0`) no fee transfers fire so this remains a clean atomic
 * mint+swap; once admin flips fees on, the user pays `amount + fee` USDC and
 * the swap proceeds at the same base size.
 *
 * Net effect: user holds `+amount` No tokens, paid roughly `amount * (1-bid)`
 * USDC plus protocol fee. The user never sees intermediate Yes balances —
 * POV-3 atomicity enforced at the tx level.
 *
 * Tx-size budget: 4 ATA prelude ixes + mint_pair (18 accounts) + Phoenix
 * swap (8 accounts) — fits within the 1232-byte legacy-tx cap. If it ever
 * overflows post-deploy, the ATA creates can be moved into a separate
 * one-time setup tx per user per market.
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
    treasury,
    amount,
    minQuoteLotsToFill,
  } = params;

  const [config] = deriveMarketConfigPda();
  const [feeConfig] = deriveFeeConfigPda();
  const [userConfig] = deriveUserConfigPda(config, trader);
  const [weeklyPool] = deriveWeeklyPoolPda();
  const [monthlyPool] = deriveMonthlyPoolPda();
  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  const [usdcVault] = deriveUsdcVaultPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, trader, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, trader, true);
  const userNo = getAssociatedTokenAddressSync(noMint, trader, true);
  const feeCollectorUsdc = getAssociatedTokenAddressSync(
    usdcMint,
    treasury,
    true,
  );

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
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      feeCollectorUsdc,
      treasury,
      usdcMint,
    ),
  ];

  // Phoenix's Yes/USDC market base mint MUST match our derived yes_mint —
  // safety guard against the trader passing a phoenixMarket that belongs to
  // a different StrikeMarket. Catches a misuse pattern early.
  const phoenixBase = phoenixMarket.data.header.baseParams.mintKey;
  if (!phoenixBase.equals(yesMint)) {
    throw new Error(
      `buildBuyNoTx: phoenixMarket.base (${phoenixBase.toBase58()}) != derived yes_mint (${yesMint.toBase58()}). Mismatched market arguments.`,
    );
  }

  const mintPairIx = await callAnchorMethod(
    program,
    "mintPair",
    new BN(amount.toString()),
    {
      user: trader,
      config,
      feeConfig,
      userConfig,
      strikeMarket: marketPda,
      userUsdc,
      usdcVault,
      yesMint,
      noMint,
      userYes,
      userNo,
      feeCollectorUsdc,
      weeklyPool,
      monthlyPool,
      usdcMint,
      clock: SYSVAR_CLOCK_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    },
  );

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
