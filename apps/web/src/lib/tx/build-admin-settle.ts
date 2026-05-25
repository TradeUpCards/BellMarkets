import type { Program, Idl } from "@coral-xyz/anchor";
import {
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import type { Outcome } from "@/lib/solana/types";

export type ForcedOutcome = "yes" | "no" | "invalid";

export interface BuildAdminSettleParams {
  program: Program<Idl>;
  admin: PublicKey;
  marketPda: PublicKey;
  forcedOutcome: ForcedOutcome;
}

export interface BuildAdminSettleResult {
  tx: Transaction;
  ix: TransactionInstruction;
}

/**
 * Build the admin `admin_settle(forced_outcome: Outcome)` tx. The on-chain
 * handler enforces:
 *  - `signer == MarketConfig.admin`
 *  - `now >= strike_market.admin_override_eligible_at` (= `expiry_unix +
 *    config.admin_override_delay_secs`)
 *  - `strike_market.outcome == Unsettled` (no double-settle)
 *
 * The UI should pre-flight both gates; the on-chain checks are the
 * authoritative defense.
 */
export async function buildAdminSettleTx(
  params: BuildAdminSettleParams,
): Promise<BuildAdminSettleResult> {
  const { program, admin, marketPda, forcedOutcome } = params;
  const [config] = deriveMarketConfigPda();

  // Anchor encodes the enum variant as `{ <camelCaseName>: {} }`. "Unsettled"
  // is intentionally not a valid forced outcome on chain.
  const outcomeArg: Outcome =
    forcedOutcome === "yes"
      ? { yes: {} }
      : forcedOutcome === "no"
        ? { no: {} }
        : { invalid: {} };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builders = (program.methods as any).adminSettle;
  if (!builders) {
    throw new Error("buildAdminSettleTx: 'adminSettle' missing from IDL.");
  }
  const ix: TransactionInstruction = await builders(outcomeArg)
    .accounts({
      admin,
      config,
      strikeMarket: marketPda,
      clock: SYSVAR_CLOCK_PUBKEY,
    })
    .instruction();

  const tx = new Transaction();
  tx.add(ix);
  return { tx, ix };
}
