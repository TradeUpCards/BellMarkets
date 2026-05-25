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
    (data: Buffer): FeeConfig => decodeFeeConfig(data),
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
