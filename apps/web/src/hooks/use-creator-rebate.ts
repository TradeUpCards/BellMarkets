"use client";

import { useMemo } from "react";
import type { PublicKey } from "@solana/web3.js";

import { isSettled, outcomeTag } from "@/lib/solana/types";
import { useMarketAccount } from "./use-market-account";

export interface CreatorRebateInfo {
  /** True iff `market.creator == user && market is unsettled`. */
  applies: boolean;
  /** Reason flag — useful for UI rendering ("market settled, rebate inactive"). */
  reason:
    | "applies"
    | "not-creator"
    | "settled"
    | "no-market"
    | "no-user"
    | "no-creator-field";
  /** Echo the creator pubkey for display, if known. */
  creator: PublicKey | null;
}

/**
 * Pure projection over `useMarketAccount(marketPda)`. Per DR-008 §"Creator
 * rebate":
 *
 *   creator-rebated  ↔  market.creator == user && market.outcome == Unsettled
 *
 * Returns a flag + reason string. The UI uses this to render "you opened
 * this market: 0% fee" (or whatever the live `creator_rebate_bps` resolves
 * to). The on-chain program is the source of truth — this hook only
 * projects what the user will see at submit time.
 *
 * `StrikeMarket.creator` shipped with Aria's P5 deploy (20-ix IDL); the
 * defensive `no-creator-field` reason still exists for stale fixtures or
 * pre-P5 cached buffers.
 */
export function useCreatorRebate(
  marketPda: PublicKey | string | null,
  user: PublicKey | null,
): CreatorRebateInfo {
  const { data: market } = useMarketAccount(marketPda);

  return useMemo<CreatorRebateInfo>(() => {
    if (!user) {
      return { applies: false, reason: "no-user", creator: null };
    }
    if (!market) {
      return { applies: false, reason: "no-market", creator: null };
    }
    // Defensive null-guard. The on-chain `creator` field shipped with Aria's
    // P5 deploy (StrikeMarket now carries it). But a market decoded from a
    // stale buffer (pre-P5 cached snapshot, manually-fed test fixture,
    // unsupported program upgrade) could still surface `undefined` — and
    // `.equals()` on undefined throws a runtime TypeError that would crash
    // the entire Trade panel render. Return a clean enum value instead.
    const creator = market.creator ?? null;
    if (!creator) {
      return { applies: false, reason: "no-creator-field", creator: null };
    }

    if (isSettled(market.outcome)) {
      return { applies: false, reason: "settled", creator };
    }
    if (outcomeTag(market.outcome) !== "unsettled") {
      return { applies: false, reason: "settled", creator };
    }
    if (!creator.equals(user)) {
      return { applies: false, reason: "not-creator", creator };
    }
    return { applies: true, reason: "applies", creator };
  }, [market, user?.toBase58() ?? null]); // eslint-disable-line react-hooks/exhaustive-deps
}
