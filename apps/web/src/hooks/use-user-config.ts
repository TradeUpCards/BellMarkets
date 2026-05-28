"use client";

import type { PublicKey } from "@solana/web3.js";
import { useCallback, useMemo } from "react";

import { useAccountSubscriptionOrNull } from "@/hooks/use-account-subscription";
import { queryKeys } from "@/lib/queries/keys";
import { decodeUserConfig } from "@/lib/solana/coder";
import { feeBpsForTier, tierForVolume, type FeeTier } from "@/lib/fees";
import { deriveMarketConfigPda } from "@/lib/solana/anchor";
import { deriveUserConfigPda } from "@/lib/solana/pdas";
import type { UserConfig } from "@/lib/solana/types";

export interface UseUserConfigResult {
  data: UserConfig | null | undefined;
  /** True when query is fetching or no data yet. */
  isLoading: boolean;
  error: Error | null;
  /** PDA the hook subscribed to (useful for invalidation by other hooks). */
  pda: PublicKey | null;
  /** Synthetic "default" view for users without a UserConfig PDA yet. */
  derived: {
    tier: FeeTier;
    projectedFeeBps: number;
    mintVolume30dMicros: bigint;
  };
}

/**
 * Subscribe to a user's `UserConfig` PDA. PDA seed per IDL =
 * `[b"user", config, user]`. Returns the decoded view + a `derived` block
 * that gives sensible defaults (tier 1, 200 bps, $0 30d volume) when the
 * PDA doesn't yet exist on chain (which is most users until their first
 * `mint_pair` call — `init_if_needed` creates it then).
 *
 * Hard YES #9 compliant — subscription-driven via `useAccountSubscriptionOrNull`.
 */
export function useUserConfig(
  userPubkey: PublicKey | null,
): UseUserConfigResult {
  const [config] = useMemo(() => deriveMarketConfigPda(), []);

  const pda = useMemo(
    () => (userPubkey ? deriveUserConfigPda(config, userPubkey)[0] : null),
    [config, userPubkey?.toBase58() ?? null], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const decode = useCallback(
    (data: Buffer): UserConfig => {
      // Same snake_case → camelCase normalization as useFeeConfig /
      // useMarketConfig / useAllMarkets. Anchor 0.30 BorshAccountsCoder +
      // our IDL returns `mint_volume_30d` etc.; pre-fix the trade page
      // crashed whenever a wallet with an initialized UserConfig PDA
      // (e.g. the platform admin) connected because
      // `query.data.mintVolume30d` was undefined and `.toString()` threw.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = decodeUserConfig(data) as any;
      return {
        user: raw.user,
        mintVolume30d: raw.mintVolume30d ?? raw.mint_volume_30d,
        mintVolumeLifetime:
          raw.mintVolumeLifetime ?? raw.mint_volume_lifetime,
        lastDecayUnix: raw.lastDecayUnix ?? raw.last_decay_unix,
        bump: raw.bump,
      };
    },
    [],
  );

  const query = useAccountSubscriptionOrNull<UserConfig>(
    pda,
    decode,
    queryKeys.userConfig(userPubkey),
  );

  const volumeMicros =
    query.data && query.data.mintVolume30d
      ? BigInt(query.data.mintVolume30d.toString())
      : 0n;
  const tier = tierForVolume(volumeMicros);

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error ?? null,
    pda,
    derived: {
      tier,
      projectedFeeBps: feeBpsForTier(tier),
      mintVolume30dMicros: volumeMicros,
    },
  };
}
