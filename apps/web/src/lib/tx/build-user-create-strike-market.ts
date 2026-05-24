import { BN, type Program, type Idl } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import {
  deriveNoMintPda,
  deriveStrikeMarketPda,
  deriveTickerConfigPda,
  deriveUsdcVaultPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";

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
  ix: TransactionInstruction;
  pdas: {
    strikeMarket: PublicKey;
    yesMint: PublicKey;
    noMint: PublicKey;
    usdcVault: PublicKey;
    config: PublicKey;
    tickerConfig: PublicKey;
  };
}

/**
 * Build (don't send) the user-funded strike-creation transaction (DR-005).
 *
 * Reconciled against the 20-ix IDL post-Aria P5 deploy. Account order /
 * names match `instructions[].select(.name == "user_create_strike_market")`
 * — including the `ticker_config` PDA I omitted in the IDL-pending stub.
 *
 *   tx = bell_markets.user_create_strike_market(strike, expiry)
 *
 * The signer pays ~0.00455 SOL rent for the StrikeMarket + Yes/No mints +
 * USDC vault and is recorded immutably as `StrikeMarket.creator` (DR-008
 * creator-rebate eligibility).
 *
 * **No ATA prelude here** — the create ix doesn't touch user token accounts.
 * The follow-up `mint_pair` call (typically bundled by the caller as the
 * first-trade flow per DR-005 §Consequences) is where ATAs get created.
 * Caller is responsible for: (a) checking tx-size budget if composing the
 * full `[user_create + mint_pair + phoenix_swap]` atomic flow — likely
 * requires a VersionedTransaction + address lookup tables; (b) prepending
 * the ATA creates if going that route.
 *
 * On-chain enforcement (per DR-005 §"On-chain enforcement"):
 *  - Strike within `ticker_config.max_user_strike_deviation_bps` of current spot
 *  - Strike aligned to `ticker_config.strike_tick_size` grid
 *  - Expiry must be 13:00 or 16:00 ET within 7 days (per DR-007)
 *  - Pyth must pass staleness + confidence checks at create time
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

  const [config] = deriveMarketConfigPda();
  const [tickerConfig] = deriveTickerConfigPda(underlyingPythFeed);
  const [strikeMarket] = deriveStrikeMarketPda(
    underlyingPythFeed,
    expiryUnix,
    strikePrice,
  );
  const [yesMint] = deriveYesMintPda(strikeMarket);
  const [noMint] = deriveNoMintPda(strikeMarket);
  const [usdcVault] = deriveUsdcVaultPda(strikeMarket);

  const ix = await callAnchorMethodPair(
    program,
    "userCreateStrikeMarket",
    new BN(strikePrice.toString()),
    new BN(expiryUnix.toString()),
    {
      user,
      config,
      tickerConfig,
      strikeMarket,
      underlyingPythFeed,
      yesMint,
      noMint,
      usdcVault,
      usdcMint,
      phoenixMarket,
      clock: SYSVAR_CLOCK_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    },
  );

  const tx = new Transaction().add(ix);

  return {
    tx,
    ix,
    pdas: { strikeMarket, yesMint, noMint, usdcVault, config, tickerConfig },
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
