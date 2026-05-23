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

export interface BuildMintPairParams {
  program: Program<Idl>;
  user: PublicKey;
  marketPda: PublicKey;
  /** USDC mint pubkey from MarketConfig.usdc_mint. */
  usdcMint: PublicKey;
  /**
   * `MarketConfig.treasury` — fee-collector wallet. The fee-collector USDC
   * ATA is derived from this + `usdcMint`. Caller reads it from
   * `useMarketConfig().treasury` (or `coordination/devnet-pubkeys.md` —
   * `FAc2J…UrjS` on current devnet).
   */
  treasury: PublicKey;
  /** Pair count (one $1 USDC mints one Yes + one No). u64 on chain. */
  amount: bigint;
}

export interface BuildMintPairResult {
  tx: Transaction;
  /** Extra ATA-creation ixes prepended (informational; useful for budgeting). */
  prelude: TransactionInstruction[];
  /** The mint_pair Anchor instruction itself. */
  ix: TransactionInstruction;
  ataKeys: {
    userUsdc: PublicKey;
    userYes: PublicKey;
    userNo: PublicKey;
    feeCollectorUsdc: PublicKey;
  };
  pdas: {
    config: PublicKey;
    feeConfig: PublicKey;
    userConfig: PublicKey;
    weeklyPool: PublicKey;
    monthlyPool: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    usdcVault: PublicKey;
  };
}

/**
 * Build (don't send) a Transaction that calls `mint_pair(amount)` per the
 * 20-ix IDL post-Aria P5 deploy. The instruction now requires the full
 * DR-008 + DR-010 fee-routing surface:
 *
 *   - `fee_config` (PDA `[b"fee_config"]`) — read-only fee parameters.
 *   - `user_config` (PDA `[b"user", config, user]`) — writable, init_if_needed
 *     on first mint per user (~$0.16 rent). Tracks `mint_volume_30d`.
 *   - `fee_collector_usdc` — ATA(usdc_mint, treasury) — destination for the
 *     `platform_retain_bps` share.
 *   - `weekly_pool` (PDA `[b"weekly_pool"]`) — destination for `weekly_pool_bps`.
 *   - `monthly_pool` (PDA `[b"monthly_pool"]`) — destination for `monthly_pool_bps`.
 *   - `clock` sysvar — used by the linear-decay logic on `UserConfig`.
 *
 * **Pre-flip safety:** the on-chain default `mint_fee_bps == 0` means the
 * fee transfers don't actually fire even though the accounts must still be
 * passed. So this builder is safe to use against the live program TODAY —
 * fees are infrastructure, not behavior.
 */
export async function buildMintPairTx(
  params: BuildMintPairParams,
): Promise<BuildMintPairResult> {
  const { program, user, marketPda, usdcMint, treasury, amount } = params;

  const [config] = deriveMarketConfigPda();
  const [feeConfig] = deriveFeeConfigPda();
  const [userConfig] = deriveUserConfigPda(config, user);
  const [weeklyPool] = deriveWeeklyPoolPda();
  const [monthlyPool] = deriveMonthlyPoolPda();
  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  const [usdcVault] = deriveUsdcVaultPda(marketPda);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, user, true);
  const userNo = getAssociatedTokenAddressSync(noMint, user, true);
  const feeCollectorUsdc = getAssociatedTokenAddressSync(
    usdcMint,
    treasury,
    true,
  );

  const prelude: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userUsdc,
      user,
      usdcMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userYes,
      user,
      yesMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userNo,
      user,
      noMint,
    ),
    // Idempotent — most fee-collector ATAs already exist (Bram bootstraps).
    // Including here means a first-of-its-kind treasury never blocks mint.
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      feeCollectorUsdc,
      treasury,
      usdcMint,
    ),
  ];

  const ix = await callAnchorMethod(
    program,
    "mintPair",
    new BN(amount.toString()),
    {
      user,
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

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(ix);

  return {
    tx,
    prelude,
    ix,
    ataKeys: { userUsdc, userYes, userNo, feeCollectorUsdc },
    pdas: {
      config,
      feeConfig,
      userConfig,
      weeklyPool,
      monthlyPool,
      yesMint,
      noMint,
      usdcVault,
    },
  };
}
