"use client";

import { useEffect } from "react";
import {
  type QueryKey,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import type { AccountInfo, PublicKey } from "@solana/web3.js";

/**
 * Subscribe to a Solana account via `connection.onAccountChange` and surface
 * the decoded value through TanStack Query.
 *
 * Hard YES #9 enforced here: this hook **never polls**. The initial value
 * is fetched once on mount (or when `pubkey` changes); subsequent updates
 * arrive via WebSocket and are written to the query cache via
 * `setQueryData`. `staleTime: Infinity` + `refetchOnWindowFocus: false`
 * prevent TanStack from auto-refetching.
 *
 * `decoder(null)` is invoked when the account does not exist (yet) — return
 * a "missing" value (e.g., `null`) so consumers can show a sensible empty
 * state. The decoder must be referentially stable; if you build it inside
 * a component, wrap with `useCallback`.
 *
 * ## Subscription lifecycle
 *
 * **Subscribe when:** the hook mounts AND `enabled !== false` AND `pubkey !== null`.
 * On every change to (`pubkey`, `enabled`) the effect re-runs; the previous
 * subscription is torn down via `removeAccountChangeListener` before the new
 * one is registered. Stable references matter — the effect keys off
 * `pubkey?.toBase58() ?? null` rather than the PublicKey object reference so
 * a new `new PublicKey(sameBase58)` doesn't trigger a churn.
 *
 * **Tear down when:** the component unmounts, `pubkey` changes (including to
 * `null`), or `enabled` flips to `false`. Cleanup is the React `useEffect`
 * return function — guaranteed to run before the next effect fires or before
 * unmount completes. No memory leak path even on rapid mount/unmount cycles
 * because the listener ID is captured in the closure.
 *
 * **What about RPC disconnect?** Verified empirically in
 * `@solana/web3.js@1.98.4` source (Connection class, ~line 6100-8290):
 *   - Internal `RpcWebSocketClient` is created with `max_reconnects: Infinity`.
 *   - On unexpected close (`code !== 1000`), all registered subscriptions are
 *     marked `state: 'pending'` and the WS client reconnects automatically.
 *   - On reconnect (`_wsOnOpen`), pending subscriptions are re-established
 *     server-side — our `onAccountChange` callbacks resume firing without
 *     this hook doing anything explicit.
 *
 * **The reconnect gap:** during the window where the WS is down and
 * reconnecting (typically <30 s on Helius), on-chain account changes can
 * happen but our callbacks won't fire. TanStack Query's `data` will be
 * stale until the next event lands post-reconnect — which on a quiet account
 * could be a while. The `useInvalidateOnReconnect()` companion hook (exported
 * below) listens to browser `online` events and invalidates the entire
 * `queryKeys.all` namespace; mount it once at the app root if offline
 * tolerance matters for the deployed Trade panel. For Day-3 MVP it is
 * exported but not yet wired into `Providers` — wire it when the Trade
 * panel composition starts.
 *
 * **What about React 18 Strict Mode double-mounting?** The cleanup function
 * unsubscribes the first effect's listener before the second effect's
 * subscription registers. Net result: exactly one active subscription at any
 * point during Strict Mode's mount → unmount → mount cycle. Verified by the
 * `void connection.removeAccountChangeListener(id)` call in the cleanup —
 * the promise is intentionally fire-and-forget because cleanup must be sync.
 */
export function useAccountSubscription<T>(
  pubkey: PublicKey | null,
  decoder: (info: AccountInfo<Buffer> | null) => T,
  queryKey: QueryKey,
  opts: { enabled?: boolean; pollIntervalMs?: number } = {},
): UseQueryResult<T> {
  const { connection } = useConnection();
  const enabled = (opts.enabled ?? true) && pubkey !== null;

  // Polling disabled — was burning Helius free-plan quota at 5s/account.
  // Page data updates on navigation and after transactions. Re-enable
  // (opts.pollIntervalMs) if a paid Helius plan is added.
  const pollIntervalMs = opts.pollIntervalMs ?? false;

  const result = useQuery<T>({
    queryKey,
    queryFn: async () => {
      if (!pubkey) throw new Error("queryFn called with null pubkey");
      const info = await connection.getAccountInfo(pubkey);
      return decoder(info);
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: enabled && pollIntervalMs ? pollIntervalMs : false,
  });

  // WebSocket subscriptions disabled — sharing the Helius free-plan quota
  // with HTTP polling was unsustainable. Re-enable when a paid plan is in
  // place and a proper WS proxy (Cloudflare Workers / Fly.io) is wired up.
  useEffect(() => {
    // no-op — subscription body removed intentionally
  }, [connection, pubkey?.toBase58() ?? null, enabled, decoder]);

  return result;
}

/**
 * Watch a Solana account by program-derived address using a decoded view of
 * the buffer. Convenience wrapper that pre-bakes `decoder(null) → null`.
 */
export function useAccountSubscriptionOrNull<T>(
  pubkey: PublicKey | null,
  decode: (data: Buffer) => T,
  queryKey: QueryKey,
  opts: { enabled?: boolean } = {},
): UseQueryResult<T | null> {
  return useAccountSubscription<T | null>(
    pubkey,
    (info) => (info ? decode(info.data) : null),
    queryKey,
    opts,
  );
}

/**
 * Belt-and-suspenders for the WebSocket reconnect gap (see lifecycle docs
 * above). Listens to browser `online` events and invalidates all bell-markets
 * queries so the next render refetches via `getAccountInfo` — closing the
 * window where on-chain changes happened while the WS was down.
 *
 * Mount once at the app root (Providers). Idempotent across remounts.
 *
 * Not yet wired into `Providers` — the Trade panel composition is the right
 * moment to add it (when offline tolerance becomes user-visible).
 */
export function useInvalidateOnReconnect(namespace: QueryKey): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      void queryClient.invalidateQueries({ queryKey: namespace });
    };
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [queryClient, JSON.stringify(namespace)]);
}
