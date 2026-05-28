"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { decodeStrikeMarket } from "@/lib/solana/coder";
import { DEMO_STRIKE_MARKETS } from "@/lib/demo-strikes";
import type { StrikeMarketWithPda } from "@/lib/solana/types";
import { queryKeys } from "@/lib/queries/keys";

/**
 * Enumerate every live StrikeMarket the demo cares about.
 *
 * ## Why `getMultipleAccountsInfo` instead of `getProgramAccounts`
 *
 * `getProgramAccounts` is restricted on Helius's standard tier — unindexed
 * program scans either time out or return 403 / "Method not found". The
 * call we want ("give me every StrikeMarket account") is the canonical
 * expensive call Helius locks down.
 *
 * The demo doesn't need an unbounded scan: every strike that should
 * render is already pinned in `lib/demo-strikes.ts` (Bram's seeded grid).
 * We fetch those by-PDA with `getMultipleAccountsInfo` — one cheap call,
 * works on every Helius tier, no indexer required.
 *
 * Adding a new on-chain market = append to `DEMO_STRIKE_MARKETS`. Removing
 * one = remove from the registry. The page reflects the registry.
 *
 * `staleTime: 60s` provides a soft cache for back-to-back navigations
 * without becoming a polling loop. Per-market detail updates flow
 * through the per-market subscription hooks (`useMarketAccount`,
 * `useOrderBook`).
 */
export function useAllMarkets() {
  const { connection } = useConnection();

  return useQuery<StrikeMarketWithPda[]>({
    queryKey: queryKeys.markets.list(),
    queryFn: async () => {
      const pdaList = DEMO_STRIKE_MARKETS.map((m) => new PublicKey(m.marketPda));
      if (pdaList.length === 0) return [];

      const infos = await connection.getMultipleAccountsInfo(pdaList, "confirmed");

      const decoded: StrikeMarketWithPda[] = [];
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        if (!info) continue; // PDA in registry but no account on-chain — skip silently
        try {
          const data = decodeStrikeMarket(info.data as Buffer);
          // Defensive: same legacy-schema guard as the prior `getProgramAccounts`
          // path — drop entries where the load-bearing fields didn't decode
          // (deploy_index ≤ 6 StrikeMarket was 333 B without `order_book`).
          if (!data?.strikePrice || !data.expiryUnix || !data.yesMint) {
            continue;
          }
          decoded.push({ pda: pdaList[i]!, data });
        } catch {
          // Legacy-schema or malformed; skip silently. Re-emerges as
          // `liveMarket=null` in trade-view → "No on-chain StrikeMarket"
          // disable banner.
        }
      }
      return decoded;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
