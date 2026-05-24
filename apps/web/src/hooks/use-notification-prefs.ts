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
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
} from "@/types/profile";

/**
 * Read/write hook for `Profile.notificationPrefs`. Wraps a TanStack `useQuery`
 * + `useMutation` pair so the UI toggle component is a thin click handler:
 *
 *   const { prefs, update } = useNotificationPrefs();
 *   <Toggle checked={prefs?.email.newsletter} onChange={v =>
 *     update({ email: { ...prefs.email, newsletter: v } })
 *   } />
 *
 * The mutation does an optimistic update + invalidates `profile(wallet)` on
 * success so the downstream `useProfile` reflects fresh state. Optimistic
 * rollback fires on error.
 */
export interface UseNotificationPrefsResult {
  prefs: NotificationPrefs | null;
  query: UseQueryResult<NotificationPrefs | null>;
  update: UseMutationResult<NotificationPrefs, Error, Partial<NotificationPrefs>>;
}

export function useNotificationPrefs(): UseNotificationPrefsResult {
  const wallet = useWallet();
  const walletBase58 = useMemo(
    () => wallet.publicKey?.toBase58() ?? null,
    [wallet.publicKey],
  );
  const queryClient = useQueryClient();

  const query = useQuery<NotificationPrefs | null>({
    queryKey: queryKeys.notificationPrefs(walletBase58),
    enabled: !!walletBase58,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async () => {
      if (!walletBase58) return null;
      const url = `/api/profile/notification-prefs?wallet=${encodeURIComponent(walletBase58)}`;
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (resp.status === 404) return DEFAULT_NOTIFICATION_PREFS;
      if (!resp.ok) {
        throw new Error(`Notification-prefs fetch failed: ${resp.status}`);
      }
      const body = (await resp.json()) as {
        ok: boolean;
        prefs?: NotificationPrefs;
        error?: string;
      };
      if (!body.ok)
        throw new Error(body.error ?? "Notification-prefs response malformed.");
      return body.prefs ?? DEFAULT_NOTIFICATION_PREFS;
    },
  });

  const update = useMutation<NotificationPrefs, Error, Partial<NotificationPrefs>>({
    mutationFn: async (patch) => {
      if (!walletBase58) {
        throw new Error("Cannot update notification prefs without a connected wallet.");
      }
      const resp = await fetch(`/api/profile/notification-prefs`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: walletBase58, patch }),
      });
      if (!resp.ok) {
        throw new Error(`Notification-prefs update failed: ${resp.status}`);
      }
      const body = (await resp.json()) as {
        ok: boolean;
        prefs?: NotificationPrefs;
        error?: string;
      };
      if (!body.ok || !body.prefs)
        throw new Error(body.error ?? "Update response malformed.");
      return body.prefs;
    },
    onMutate: async (patch) => {
      // Optimistic update — merge patch over current prefs.
      const key = queryKeys.notificationPrefs(walletBase58);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<NotificationPrefs | null>(key);
      const next = mergePrefs(prev ?? DEFAULT_NOTIFICATION_PREFS, patch);
      queryClient.setQueryData(key, next);
      return { prev };
    },
    onError: (_err, _patch, ctx) => {
      const key = queryKeys.notificationPrefs(walletBase58);
      const prev = (ctx as { prev?: NotificationPrefs | null } | undefined)?.prev;
      if (prev !== undefined) {
        queryClient.setQueryData(key, prev);
      }
    },
    onSuccess: (data) => {
      const key = queryKeys.notificationPrefs(walletBase58);
      queryClient.setQueryData(key, data);
      // Cascade-invalidate profile so any embedded prefs in `useProfile` refresh.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.profile(walletBase58),
      });
    },
  });

  return { prefs: query.data ?? null, query, update };
}

function mergePrefs(
  current: NotificationPrefs,
  patch: Partial<NotificationPrefs>,
): NotificationPrefs {
  return {
    email: { ...current.email, ...(patch.email ?? {}) },
    discord: { ...current.discord, ...(patch.discord ?? {}) },
    browserPush: { ...current.browserPush, ...(patch.browserPush ?? {}) },
    telegram:
      patch.telegram === undefined
        ? current.telegram
        : { ...(current.telegram ?? { settlements: false }), ...patch.telegram },
  };
}
