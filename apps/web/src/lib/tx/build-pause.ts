import type { Program, Idl } from "@coral-xyz/anchor";
import {
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";

export interface BuildPauseParams {
  program: Program<Idl>;
  admin: PublicKey;
  /** true = pause; false = unpause. */
  paused: boolean;
}

export interface BuildPauseResult {
  tx: Transaction;
  ix: TransactionInstruction;
}

/**
 * Build the admin `pause(paused: bool)` tx. Single instruction; the
 * on-chain handler checks `signer == MarketConfig.admin` and writes the
 * flag. Used by the admin emergency-pause toggle in `apps/web/app/admin/`.
 *
 * Effect: when `paused=true`, mint_pair / place_order / cancel_order /
 * redeem / settle all revert with `MarketPaused`. Restoration is symmetric
 * — call again with `paused=false`.
 */
export async function buildPauseTx(
  params: BuildPauseParams,
): Promise<BuildPauseResult> {
  const { program, admin, paused } = params;
  const [config] = deriveMarketConfigPda();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builders = (program.methods as any).pause;
  if (!builders) {
    throw new Error("buildPauseTx: 'pause' missing from IDL.");
  }
  const ix: TransactionInstruction = await builders(paused)
    .accounts({ admin, config })
    .instruction();

  const tx = new Transaction();
  tx.add(ix);
  return { tx, ix };
}
