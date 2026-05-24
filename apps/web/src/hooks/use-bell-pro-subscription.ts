"use client";

import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import type { BellProSubscription } from "@/lib/billing/types";
import { queryKeys } from "@/lib/queries/keys";

/**
 * Read-side state for Bell Pro subscription (DR-014 + AI v2 §6).
 *
 * Polls `/api/billing?wallet=...` on a generous 60s cadence — Hard YES #9
 * ("no polling") governs ON-CHAIN reads only. Subscription state is
 * off-chain (Helio webhook → Neon row); a 60s tick is acceptable for the
 * upgrade-CTA + lock-state surfaces and isn't subscription-eventable
 * client-side until Bram adds a Server-Sent Events / WS path.
 *
 * When no wallet is connected, the hook returns `data: null` with no
 * fetch — no network call until the user is identified.
 *
 * NEVER returns wallet info or subscription metadata for a wallet the
 * current user hasn't connected — the input is always `wallet.publicKey`
 * from the live adapter. The route handler itself is wallet-keyed and
 * carries no PII; this is defense-in-depth for the call-site.
 */
export function useBellProSubscription(): UseQueryResult<BellProSubscription | null> {
  const wallet = useWallet();
  const walletBase58 = useMemo(
    () => wallet.publicKey?.toBase58() ?? null,
    [wallet.publicKey],
  );

  return useQuery<BellProSubscription | null>({
    queryKey: queryKeys.bellProSubscription(walletBase58),
    enabled: !!walletBase58,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      if (!walletBase58) return null;
      const url = `/api/billing?wallet=${encodeURIComponent(walletBase58)}`;
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!resp.ok) {
        throw new Error(`Billing fetch failed: ${resp.status}`);
      }
      const body = (await resp.json()) as {
        ok: boolean;
        subscription?: BellProSubscription;
        error?: string;
      };
      if (!body.ok || !body.subscription) {
        throw new Error(body.error ?? "Billing response malformed.");
      }
      return body.subscription;
    },
  });
}

/** Pure projection — does this subscription unlock Bell Pro features now? */
export function isBellProActive(sub: BellProSubscription | null | undefined): boolean {
  if (!sub) return false;
  if (sub.status !== "active") return false;
  if (sub.expiresAtUnix === null) return false;
  return sub.expiresAtUnix * 1000 > Date.now();
}
