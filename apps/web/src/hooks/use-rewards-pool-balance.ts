"use client";

import { useCallback, useMemo } from "react";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { AccountLayout } from "@solana/spl-token";

import { queryKeys } from "@/lib/queries/keys";
import { useAccountSubscription } from "./use-account-subscription";
import {
  deriveMonthlyRewardsPoolPda,
  deriveWeeklyRewardsPoolPda,
} from "@/lib/solana/pdas";

export type RewardsPoolPeriod = "weekly" | "monthly";

export interface RewardsPoolBalance {
  period: RewardsPoolPeriod;
  pool: PublicKey;
  /** USDC balance in micros (lamports of the USDC mint). */
  balanceMicros: bigint;
  uninitialized: boolean;
}

/**
 * Subscribe to the USDC token-account balance held by one of the rewards
 * pools (DR-010). The pool PDAs are USDC token accounts owned by the program,
 * so we decode the standard SPL Token `AccountLayout` and project `amount`.
 *
 * On a deploy that hasn't yet been bootstrapped with the pool PDAs, the
 * account returns null → `uninitialized: true` and `balanceMicros: 0n`.
 *
 * Hard YES #9: WebSocket subscription via `useAccountSubscription`.
 */
export function useRewardsPoolBalance(
  period: RewardsPoolPeriod,
): {
  data: RewardsPoolBalance | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const pool = useMemo(
    () =>
      period === "weekly"
        ? deriveWeeklyRewardsPoolPda()[0]
        : deriveMonthlyRewardsPoolPda()[0],
    [period],
  );

  const decode = useCallback(
    (info: AccountInfo<Buffer> | null): RewardsPoolBalance => {
      if (!info) {
        return {
          period,
          pool,
          balanceMicros: 0n,
          uninitialized: true,
        };
      }
      try {
        const acct = AccountLayout.decode(info.data);
        return {
          period,
          pool,
          balanceMicros: BigInt(acct.amount.toString()),
          uninitialized: false,
        };
      } catch {
        return {
          period,
          pool,
          balanceMicros: 0n,
          uninitialized: true,
        };
      }
    },
    [period, pool],
  );

  const query = useAccountSubscription<RewardsPoolBalance>(
    pool,
    decode,
    queryKeys.rewardsPool(period),
  );

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error ?? null,
  };
}
