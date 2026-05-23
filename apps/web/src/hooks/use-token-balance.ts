"use client";

import { useCallback, useMemo } from "react";
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { useAccountSubscriptionOrNull } from "./use-account-subscription";

export interface TokenBalance {
  /** Raw amount (smallest unit; convert with decimals to display). */
  amount: bigint;
  /** Associated token account address. */
  ata: PublicKey;
  /** True when the ATA does not exist yet. Balance is 0n in that case. */
  uninitialized: boolean;
}

/**
 * Subscribe to a user's ATA balance for a given mint. Returns 0n if the ATA
 * does not exist yet — common pre-`mint_pair`. Update-driven via WebSocket.
 */
export function useTokenBalance(
  mint: PublicKey | null,
  owner: PublicKey | null,
  queryKey: readonly unknown[],
) {
  const ata = useMemo(() => {
    if (!mint || !owner) return null;
    return getAssociatedTokenAddressSync(mint, owner, true);
  }, [mint, owner]);

  const decode = useCallback((data: Buffer): TokenBalance => {
    const acc = AccountLayout.decode(data);
    return {
      amount: acc.amount,
      ata: ata!,
      uninitialized: false,
    };
  }, [ata]);

  const q = useAccountSubscriptionOrNull<TokenBalance>(
    ata,
    decode,
    queryKey,
  );

  const value: TokenBalance | null = q.data
    ? q.data
    : ata
      ? { amount: 0n, ata, uninitialized: true }
      : null;

  return { ...q, data: value };
}
