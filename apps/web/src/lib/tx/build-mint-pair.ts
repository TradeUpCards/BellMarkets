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

import {
  deriveNoMintPda,
  deriveUsdcVaultPda,
  deriveYesMintPda,
} from "@/lib/solana/pdas";

import { callAnchorMethod } from "./anchor-helper";

export interface BuildMintPairParams {
  program: Program<Idl>;
  user: PublicKey;
  marketPda: PublicKey;
  /** USDC mint pubkey from MarketConfig.usdc_mint. */
  usdcMint: PublicKey;
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
  };
}

/**
 * Build (don't send) a Transaction that calls `mint_pair(amount)`:
 *   - Idempotently creates the user's USDC / Yes / No ATAs as needed.
 *   - Issues the BellMarkets `mint_pair` instruction.
 *
 * Caller is responsible for setting recentBlockhash + feePayer and submitting
 * through the wallet adapter. Returns the constituent instructions too so
 * upstream callers (the atomic Buy No bundler) can compose them with
 * additional Phoenix instructions.
 */
export async function buildMintPairTx(
  params: BuildMintPairParams,
): Promise<BuildMintPairResult> {
  const { program, user, marketPda, usdcMint, amount } = params;

  const [yesMint] = deriveYesMintPda(marketPda);
  const [noMint] = deriveNoMintPda(marketPda);
  // usdc_vault PDA — referenced for clarity even though Anchor resolves it.
  deriveUsdcVaultPda(marketPda);

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

  // `program.methods` is typed as `Record<string, ... | undefined>` because
  // we instantiate Program<Idl> against the broad Idl type. The discriminator
  // self-consistency check in verify-idl.mjs guarantees mint_pair exists.
  const ix = await callAnchorMethod(
    program,
    "mintPair",
    new BN(amount.toString()),
    {
      user,
      strikeMarket: marketPda,
      userUsdc,
      userYes,
      userNo,
      usdcMint,
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
    ataKeys: { userUsdc, userYes, userNo },
  };
}
