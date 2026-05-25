"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

/**
 * Fires `POST /api/users/upsert` exactly once per wallet-pubkey when a
 * wallet first connects in the current session. Idempotent on the server
 * side — repeated calls for the same wallet return the existing row.
 *
 * Fanalytics pattern: ensures a `users` row exists at first wallet-connect
 * with an auto-generated `BraveEagle983` handle + virtual email, so the
 * user has a working profile immediately (before they OAuth-link).
 *
 * Returns the resolved user (handle + email + ids), the loading state,
 * and any error. The UserMenu surfaces the handle once it lands.
 */
export interface EnsuredUser {
  id: string;
  walletPubkey: string;
  handle: string | null;
  email: string | null;
  avatarUrl: string | null;
  snsName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UseEnsureUserResult {
  user: EnsuredUser | null;
  isLoading: boolean;
  error: Error | null;
  /** True iff this call created the row (vs found an existing one). */
  created: boolean;
}

export function useEnsureUser(): UseEnsureUserResult {
  const wallet = useWallet();
  const pubkey = wallet.publicKey?.toBase58() ?? null;

  // Track which pubkey we've already attempted so a reconnect with the
  // same wallet doesn't trigger a second POST (the server is idempotent
  // but no need to roundtrip).
  const seenRef = useRef<Set<string>>(new Set());

  const [user, setUser] = useState<EnsuredUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [created, setCreated] = useState(false);

  useEffect(() => {
    if (!pubkey) {
      // Wallet disconnected — clear local state. Server-side row remains.
      setUser(null);
      setError(null);
      setCreated(false);
      return;
    }
    if (seenRef.current.has(pubkey)) return;
    seenRef.current.add(pubkey);

    const ctrl = new AbortController();
    setIsLoading(true);
    setError(null);
    fetch("/api/users/upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletPubkey: pubkey }),
      signal: ctrl.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`upsert ${res.status}: ${text.slice(0, 120)}`);
        }
        return (await res.json()) as { user: EnsuredUser; created: boolean };
      })
      .then(({ user: u, created: c }) => {
        setUser(u);
        setCreated(c);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setIsLoading(false));

    return () => ctrl.abort();
  }, [pubkey]);

  return { user, isLoading, error, created };
}
