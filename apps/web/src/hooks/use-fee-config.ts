"use client";

import { useCallback, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";

import { useAccountSubscriptionOrNull } from "@/hooks/use-account-subscription";
import { queryKeys } from "@/lib/queries/keys";
import { decodeFeeConfig } from "@/lib/solana/coder";
import { deriveFeeConfigPda } from "@/lib/solana/pdas";
import type { FeeConfig } from "@/lib/solana/types";

/**
 * Subscribe to the global FeeConfig singleton — seeds `[b"fee_config"]`.
 * Holds `mint_fee_bps`, the platform/weekly/monthly split bps, creator
 * rebate bps, and the 10-slot weekly/monthly distribution arrays. Per
 * DR-008 the default `mint_fee_bps == 0` (mechanism present but disabled
 * until admin flip).
 *
 * Subscription-driven per Hard YES #9. Returns `null` if the account
 * hasn't been initialized yet (pre-`initialize_fee_config`).
 */
export function useFeeConfig() {
  const [pda] = useMemo(() => deriveFeeConfigPda(), []);
  const decode = useCallback(
    (data: Buffer): FeeConfig => {
      // Same snake_case → camelCase normalization pattern as
      // useMarketConfig / useAllMarkets. Anchor 0.30 + our IDL returns
      // mint_fee_bps / weekly_distribution_bps / etc., but downstream
      // consumers (admin-view especially) expect camelCase. Pre-fix the
      // admin page crashed on
      // `feeConfig.weeklyDistributionBps.join(" · ")` because the field
      // came back as weekly_distribution_bps and .join on undefined
      // throws.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = decodeFeeConfig(data) as any;
      return {
        config: raw.config,
        mintFeeBps: raw.mintFeeBps ?? raw.mint_fee_bps,
        platformRetainBps: raw.platformRetainBps ?? raw.platform_retain_bps,
        weeklyPoolBps: raw.weeklyPoolBps ?? raw.weekly_pool_bps,
        monthlyPoolBps: raw.monthlyPoolBps ?? raw.monthly_pool_bps,
        creatorRebateBps: raw.creatorRebateBps ?? raw.creator_rebate_bps,
        forceRedeemGraceSecs:
          raw.forceRedeemGraceSecs ?? raw.force_redeem_grace_secs,
        weeklyDistributionBps:
          raw.weeklyDistributionBps ?? raw.weekly_distribution_bps ?? [],
        monthlyDistributionBps:
          raw.monthlyDistributionBps ?? raw.monthly_distribution_bps ?? [],
        bump: raw.bump,
      };
    },
    [],
  );
  return useAccountSubscriptionOrNull<FeeConfig>(
    pda,
    decode,
    [...queryKeys.all, "fee-config"] as readonly unknown[],
  );
}

/** Re-export for callers that need the PDA pubkey without re-deriving. */
export function feeConfigPda(): PublicKey {
  return deriveFeeConfigPda()[0];
}
