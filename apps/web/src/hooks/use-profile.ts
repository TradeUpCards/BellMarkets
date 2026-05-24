"use client";

import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import { queryKeys } from "@/lib/queries/keys";
import { resolveAvatar, type ResolvedAvatar } from "@/lib/profile/avatar-resolver";
import type { Profile } from "@/types/profile";

/**
 * Read-only profile lookup for the connected wallet. Returns:
 *  - `data: Profile` when Bram's `/api/profile?wallet=...` endpoint resolves
 *  - `data: null` when the wallet has no profile yet (the route returns 404
 *    which we convert to null so consumers can show "create profile" CTAs)
 *  - throws on transport errors / 5xx
 *
 * The hook also exposes `avatar: ResolvedAvatar` — the DR-014 resolver chain
 * applied to whatever profile state we have. Works even when `data === null`
 * (returns the identicon fallback keyed by walletPubkey), so the header
 * avatar never flashes empty after the wallet connects.
 *
 * Off-chain HTTP fetch (Hard YES #9 governs on-chain reads only) — TanStack
 * defaults are conservative here: 30s staleTime, 5min cacheTime, no
 * window-focus refetch. Mutations from `useNotificationPrefs` /
 * `useSocialLinks` invalidate this query via `queryKeys.profile(wallet)`.
 */
export interface UseProfileResult {
  query: UseQueryResult<Profile | null>;
  avatar: ResolvedAvatar;
  walletBase58: string | null;
}

export function useProfile(): UseProfileResult {
  const wallet = useWallet();
  const walletBase58 = useMemo(
    () => wallet.publicKey?.toBase58() ?? null,
    [wallet.publicKey],
  );

  const query = useQuery<Profile | null>({
    queryKey: queryKeys.profile(walletBase58),
    enabled: !!walletBase58,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async () => {
      if (!walletBase58) return null;
      const url = `/api/profile?wallet=${encodeURIComponent(walletBase58)}`;
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (resp.status === 404) return null;
      if (!resp.ok) {
        throw new Error(`Profile fetch failed: ${resp.status}`);
      }
      const body = (await resp.json()) as {
        ok: boolean;
        profile?: Profile;
        error?: string;
      };
      if (!body.ok) throw new Error(body.error ?? "Profile response malformed.");
      return body.profile ?? null;
    },
  });

  const avatar = useMemo<ResolvedAvatar>(
    () =>
      resolveAvatar({
        walletPubkey: walletBase58 ?? "",
        profile: query.data ?? null,
      }),
    [walletBase58, query.data],
  );

  return { query, avatar, walletBase58 };
}
