import { BN, type Program, type Idl } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import {
  deriveNoMintPda,
  deriveStrikeMarketPda,
  deriveUsdcVaultPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";
import { deriveMarketConfigPda } from "@/lib/solana/anchor";

import { callAnchorMethod } from "./anchor-helper";

export interface BuildUserCreateStrikeMarketParams {
  program: Program<Idl>;
  /** User who pays the ~0.00455 SOL rent + becomes `StrikeMarket.creator`. */
  user: PublicKey;
  /** Strike price scaled to i64 per Pyth exponent (e.g. $230 + expo=-8 → 23_000_000_000n). */
  strikePrice: bigint;
  /** Unix seconds — must align to a US-equity close time per DR-007. */
  expiryUnix: bigint;
  /** Pyth feed for the underlying (binds the strike to a ticker). */
  underlyingPythFeed: PublicKey;
  /** Phoenix v1 FIFO market for Yes/USDC (admin-pre-allocated per ticker). */
  phoenixMarket: PublicKey;
  /** USDC mint pubkey from MarketConfig.usdc_mint. */
  usdcMint: PublicKey;
}

export interface BuildUserCreateStrikeMarketResult {
  tx: Transaction;
  prelude: TransactionInstruction[];
  ix: TransactionInstruction;
  pdas: {
    strikeMarket: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    usdcVault: PublicKey;
    config: PublicKey;
  };
  ataKeys: {
    userUsdc: PublicKey;
    userYes: PublicKey;
    userNo: PublicKey;
  };
}

/**
 * Build (don't send) the user-funded strike-creation transaction (DR-005).
 *
 *   tx = [
 *     <ATA creates: USDC + Yes + No>,
 *     bell_markets.user_create_strike_market(strike, expiry),
 *   ]
 *
 * The signer pays ~0.00455 SOL rent for the StrikeMarket + Yes/No mints + USDC
 * vault and is recorded immutably as `StrikeMarket.creator` (DR-008 creator-
 * rebate eligibility).
 *
 * On-chain enforcement (per DR-005 §"On-chain enforcement"):
 *  - Strike within per-ticker `max_user_strike_deviation_bps` of current spot
 *  - Strike aligned to per-ticker `strike_tick_size` grid
 *  - Expiry must be 13:00 or 16:00 UTC (post-EDT/EST adjustment) within 7 days
 *  - Pyth must pass staleness + confidence checks at create time
 *
 * **IDL note:** the `user_create_strike_market` ix has not landed in
 * `apps/web/src/idl/bell_markets.json` yet (10-ix IDL as of session start).
 * Once Aria's refresh hits main, `useBellMarketsProgram()` picks it up
 * automatically — no changes needed here. `callAnchorMethod` will throw a
 * clear "method missing from IDL" until then; callers should gate via
 * `program.idl.instructions.some(i => i.name === "userCreateStrikeMarket")`.
 */
export async function buildUserCreateStrikeMarketTx(
  params: BuildUserCreateStrikeMarketParams,
): Promise<BuildUserCreateStrikeMarketResult> {
  const {
    program,
    user,
    strikePrice,
    expiryUnix,
    underlyingPythFeed,
    phoenixMarket,
    usdcMint,
  } = params;

  const [strikeMarket] = deriveStrikeMarketPda(
    underlyingPythFeed,
    expiryUnix,
    strikePrice,
  );
  const [yesMint] = deriveYesMintPda(strikeMarket);
  const [noMint] = deriveNoMintPda(strikeMarket);
  const [usdcVault] = deriveUsdcVaultPda(strikeMarket);
  const [config] = deriveMarketConfigPda();

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user, true);
  const userYes = getAssociatedTokenAddressSync(yesMint, user, true);
  const userNo = getAssociatedTokenAddressSync(noMint, user, true);

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
  ];

  const ix = await callAnchorMethodPair(
    program,
    "userCreateStrikeMarket",
    new BN(strikePrice.toString()),
    new BN(expiryUnix.toString()),
    {
      creator: user,
      config,
      strikeMarket,
      underlyingPythFeed,
      yesMint,
      noMint,
      usdcVault,
      usdcMint,
      phoenixMarket,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    },
  );

  const tx = new Transaction();
  for (const p of prelude) tx.add(p);
  tx.add(ix);

  return {
    tx,
    prelude,
    ix,
    pdas: { strikeMarket, yesMint, noMint, usdcVault, config },
    ataKeys: { userUsdc, userYes, userNo },
  };
}

/**
 * `user_create_strike_market` is a two-arg ix (strike + expiry) and the
 * generic `callAnchorMethod` only supports single-arg. Inline the unsafe
 * narrowing once here rather than touch the helper everyone shares.
 */
async function callAnchorMethodPair(
  program: Program<Idl>,
  method: string,
  arg1: BN,
  arg2: BN,
  accounts: Record<string, PublicKey>,
): Promise<TransactionInstruction> {
  type Builder = {
    accounts: (
      a: Record<string, PublicKey>,
    ) => { instruction: () => Promise<TransactionInstruction> };
  };
  const methods = program.methods as unknown as Record<
    string,
    ((a: BN, b: BN) => Builder) | undefined
  >;
  const builder = methods[method];
  if (!builder) {
    throw new Error(`Anchor method "${method}" missing from IDL.`);
  }
  return builder(arg1, arg2).accounts(accounts).instruction();
}
