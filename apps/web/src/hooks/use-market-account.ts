"use client";

import { useCallback } from "react";
import { PublicKey } from "@solana/web3.js";

import { decodeStrikeMarket } from "@/lib/solana/coder";
import type { StrikeMarket } from "@/lib/solana/types";
import { queryKeys } from "@/lib/queries/keys";

import { useAccountSubscriptionOrNull } from "./use-account-subscription";

/**
 * Subscribe to a single StrikeMarket PDA. Returns `null` until the account
 * is fetched (or if it does not exist). Updates pushed via WebSocket on
 * every account change — no polling.
 */
export function useMarketAccount(marketPda: PublicKey | string | null) {
  const pubkey =
    typeof marketPda === "string" ? new PublicKey(marketPda) : marketPda;

  const decode = useCallback(
    (data: Buffer): StrikeMarket => decodeStrikeMarket(data),
    [],
  );

  return useAccountSubscriptionOrNull<StrikeMarket>(
    pubkey,
    decode,
    queryKeys.markets.detail(pubkey),
  );
}
