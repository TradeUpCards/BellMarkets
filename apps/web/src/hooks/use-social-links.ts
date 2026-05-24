"use client";

import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import { queryKeys } from "@/lib/queries/keys";
import type { SocialLink, SocialProvider } from "@/types/profile";

/**
 * Read + unlink hook for the connected wallet's linked OAuth accounts.
 *
 * Linking is a separate flow (kicked off by the `SignInWithDiscord` /
 * `SignInWithGoogle` / `SignInWithX` components; NextAuth's signIn
 * callback writes the `social_accounts` row). This hook only:
 *   - lists the links for the connected wallet
 *   - unlinks a provider via DELETE /api/profile/social-links/:provider
 *
 * Returns `[]` for wallets with no profile yet — no error.
 */
export interface UseSocialLinksResult {
  links: SocialLink[];
  query: UseQueryResult<SocialLink[]>;
  unlink: UseMutationResult<SocialLink[], Error, SocialProvider>;
}

export function useSocialLinks(): UseSocialLinksResult {
  const wallet = useWallet();
  const walletBase58 = useMemo(
    () => wallet.publicKey?.toBase58() ?? null,
    [wallet.publicKey],
  );
  const queryClient = useQueryClient();

  const query = useQuery<SocialLink[]>({
    queryKey: queryKeys.socialLinks(walletBase58),
    enabled: !!walletBase58,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async () => {
      if (!walletBase58) return [];
      const url = `/api/profile/social-links?wallet=${encodeURIComponent(walletBase58)}`;
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (resp.status === 404) return [];
      if (!resp.ok) {
        throw new Error(`Social-links fetch failed: ${resp.status}`);
      }
      const body = (await resp.json()) as {
        ok: boolean;
        links?: SocialLink[];
        error?: string;
      };
      if (!body.ok) throw new Error(body.error ?? "Social-links response malformed.");
      return body.links ?? [];
    },
  });

  const unlink = useMutation<SocialLink[], Error, SocialProvider>({
    mutationFn: async (provider) => {
      if (!walletBase58) {
        throw new Error("Cannot unlink without a connected wallet.");
      }
      const resp = await fetch(
        `/api/profile/social-links/${encodeURIComponent(provider)}?wallet=${encodeURIComponent(walletBase58)}`,
        { method: "DELETE" },
      );
      if (!resp.ok) {
        throw new Error(`Unlink failed: ${resp.status}`);
      }
      const body = (await resp.json()) as {
        ok: boolean;
        links?: SocialLink[];
        error?: string;
      };
      if (!body.ok) throw new Error(body.error ?? "Unlink response malformed.");
      return body.links ?? [];
    },
    onSuccess: (links) => {
      queryClient.setQueryData(queryKeys.socialLinks(walletBase58), links);
      // Cascade — profile + avatar resolver depend on socials.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.profile(walletBase58),
      });
    },
  });

  return { links: query.data ?? [], query, unlink };
}
