"use client";

import type { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import { useAccountSubscriptionOrNull } from "@/hooks/use-account-subscription";
import { queryKeys } from "@/lib/queries/keys";
import { feeBpsForTier, tierForVolume, type FeeTier } from "@/lib/fees";
import { deriveUserConfigPda } from "@/lib/solana/pdas";

/**
 * Decoded `UserConfig` shape per DR-008. Mirrors the on-chain fields once
 * Aria's IDL refresh lands; until then the placeholder decoder returns
 * `null` and consumers default to tier 1.
 */
export interface UserConfigView {
  user: PublicKey;
  /** Rolling 30-day USDC volume in micros. */
  mintVolume30dMicros: bigint;
  /** Lifetime USDC mint volume in micros. */
  mintVolumeLifetimeMicros: bigint;
  /** Last slot the 30-day window was decayed. */
  lastDecaySlot: bigint;
  /** Tier derived from `mintVolume30dMicros`. */
  tier: FeeTier;
  /** Default tier-fee bps. Composes with creator-rebate at mint time. */
  projectedFeeBps: number;
  /** Approximate seconds until the 30-day window starts decaying old volume. */
  decayRemainingSecs: number;
}

/**
 * Placeholder decoder — returns `null` until Aria's IDL refresh lands. The
 * subscription still wires the cache-update path; UI just shows "tier 1" as
 * a sensible default for users whose UserConfig PDA hasn't been initialized
 * (which is most users until their first mint_pair call).
 */
function decodeUserConfigPlaceholder(_data: Buffer): UserConfigView | null {
  return null;
}

export interface UseUserConfigResult {
  data: UserConfigView | null | undefined;
  /** True when query is fetching or no data yet. */
  isLoading: boolean;
  error: Error | null;
  /** Synthetic "default" view for users without a UserConfig PDA yet. */
  derived: {
    tier: FeeTier;
    projectedFeeBps: number;
    mintVolume30dMicros: bigint;
  };
}

/**
 * Subscribe to a user's `UserConfig` PDA. Returns the decoded view + a
 * `derived` block that gives sensible defaults (tier 1, 200 bps, $0 30d
 * volume) when the PDA doesn't yet exist on chain.
 *
 * Hard YES #9 compliant — subscription-driven via `useAccountSubscriptionOrNull`.
 */
export function useUserConfig(
  userPubkey: PublicKey | null,
): UseUserConfigResult {
  const pda = useMemo(
    () => (userPubkey ? deriveUserConfigPda(userPubkey)[0] : null),
    [userPubkey?.toBase58() ?? null], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const query: UseQueryResult<UserConfigView | null> =
    useAccountSubscriptionOrNull<UserConfigView | null>(
      pda,
      decodeUserConfigPlaceholder,
      queryKeys.userConfig(userPubkey),
    );

  const volumeMicros = query.data?.mintVolume30dMicros ?? 0n;
  const tier = tierForVolume(volumeMicros);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error ?? null,
    derived: {
      tier,
      projectedFeeBps: feeBpsForTier(tier),
      mintVolume30dMicros: volumeMicros,
    },
  };
}
