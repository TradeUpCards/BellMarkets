"use client";

import { useCallback } from "react";

import { useAccountSubscriptionOrNull } from "@/hooks/use-account-subscription";
import { queryKeys } from "@/lib/queries/keys";
import { decodeMarketConfig } from "@/lib/solana/coder";
import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import type { MarketConfig } from "@/lib/solana/types";

/**
 * Subscribe to the singleton MarketConfig PDA. Returns the decoded config
 * — admin / usdc_mint / treasury / paused / etc. Source of truth for the
 * Trade panel's fee-collector ATA derivation (per build-mint-pair).
 *
 * Hard YES #9 — subscription-driven via useAccountSubscriptionOrNull.
 */
export function useMarketConfig() {
  const [pda] = deriveMarketConfigPda();
  const decode = useCallback(
    (data: Buffer): MarketConfig => {
      // Same casing normalization as useAllMarkets — Anchor 0.30
      // BorshAccountsCoder + snake_case IDL returns fields like `usdc_mint`
      // instead of `usdcMint`. Read either, return camelCase.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = decodeMarketConfig(data) as any;
      return {
        admin: raw.admin,
        usdcMint: raw.usdcMint ?? raw.usdc_mint,
        treasury: raw.treasury,
        priceStalenessSecs: raw.priceStalenessSecs ?? raw.price_staleness_secs,
        priceConfidenceBps: raw.priceConfidenceBps ?? raw.price_confidence_bps,
        adminOverrideDelaySecs:
          raw.adminOverrideDelaySecs ?? raw.admin_override_delay_secs,
        paused: raw.paused,
        bump: raw.bump,
      };
    },
    [],
  );
  return useAccountSubscriptionOrNull<MarketConfig>(
    pda,
    decode,
    queryKeys.config(),
  );
}
