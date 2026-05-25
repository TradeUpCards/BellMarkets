import { BN, type Program, type Idl } from "@coral-xyz/anchor";
import {
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";

import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import { deriveFeeConfigPda } from "@/lib/solana/pdas";

export interface BuildUpdateFeeConfigParams {
  program: Program<Idl>;
  admin: PublicKey;
  mintFeeBps: number;
  platformRetainBps: number;
  weeklyPoolBps: number;
  monthlyPoolBps: number;
  creatorRebateBps: number;
  forceRedeemGraceSecs: bigint;
  /** 10 u16 entries; the on-chain handler enforces sum == 10000. */
  weeklyDistributionBps: number[];
  /** 10 u16 entries; sum == 10000. */
  monthlyDistributionBps: number[];
}

export interface BuildUpdateFeeConfigResult {
  tx: Transaction;
  ix: TransactionInstruction;
}

/**
 * Build the admin `update_fee_config(...)` tx. On-chain handler enforces:
 *  - `signer == MarketConfig.admin`
 *  - `platform_retain_bps + weekly_pool_bps + monthly_pool_bps == 10000`
 *  - `weekly_distribution_bps.iter().sum() == 10000`
 *  - `monthly_distribution_bps.iter().sum() == 10000`
 *  - `mint_fee_bps ≤ 10000`
 *  - `creator_rebate_bps ≤ 10000`
 *  - `force_redeem_grace_secs > 0`
 *
 * Caller is responsible for pre-flight UI validation; on-chain checks are
 * the authoritative defense.
 */
export async function buildUpdateFeeConfigTx(
  params: BuildUpdateFeeConfigParams,
): Promise<BuildUpdateFeeConfigResult> {
  const {
    program,
    admin,
    mintFeeBps,
    platformRetainBps,
    weeklyPoolBps,
    monthlyPoolBps,
    creatorRebateBps,
    forceRedeemGraceSecs,
    weeklyDistributionBps,
    monthlyDistributionBps,
  } = params;

  if (weeklyDistributionBps.length !== 10 || monthlyDistributionBps.length !== 10) {
    throw new Error(
      "buildUpdateFeeConfigTx: distribution arrays must be exactly 10 entries.",
    );
  }

  const [config] = deriveMarketConfigPda();
  const [feeConfig] = deriveFeeConfigPda();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builders = (program.methods as any).updateFeeConfig;
  if (!builders) {
    throw new Error("buildUpdateFeeConfigTx: 'updateFeeConfig' missing from IDL.");
  }
  const ix: TransactionInstruction = await builders(
    mintFeeBps,
    platformRetainBps,
    weeklyPoolBps,
    monthlyPoolBps,
    creatorRebateBps,
    new BN(forceRedeemGraceSecs.toString()),
    weeklyDistributionBps,
    monthlyDistributionBps,
  )
    .accounts({ admin, config, feeConfig })
    .instruction();

  const tx = new Transaction();
  tx.add(ix);
  return { tx, ix };
}
