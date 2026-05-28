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

      // Diagnostic: visible in browser console — helps the next person
      // debug "matrix empty" without reading the queryFn source.
      // eslint-disable-next-line no-console
      console.log(`[useAllMarkets] fetching ${pdaList.length} StrikeMarket PDAs from registry…`);
      let infos;
      try {
        infos = await connection.getMultipleAccountsInfo(pdaList, "confirmed");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[useAllMarkets] getMultipleAccountsInfo threw:`, e);
        throw e;
      }
      // eslint-disable-next-line no-console
      console.log(`[useAllMarkets] received ${infos.length} responses · null=${infos.filter((i) => !i).length} · present=${infos.filter((i) => i).length}`);

      const decoded: StrikeMarketWithPda[] = [];
      let decodeFailures = 0;
      let fieldGuards = 0;
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        if (!info) continue; // PDA in registry but no account on-chain — skip silently
        try {
          const data = decodeStrikeMarket(info.data as Buffer);
          if (!data?.strikePrice || !data.expiryUnix || !data.yesMint) {
            fieldGuards++;
            continue;
          }
          decoded.push({ pda: pdaList[i]!, data });
        } catch (e) {
          decodeFailures++;
          if (decodeFailures <= 2) {
            // eslint-disable-next-line no-console
            console.warn(`[useAllMarkets] decode failed for ${pdaList[i]!.toBase58().slice(0, 8)}… (size=${info.data.length}):`, (e as Error).message);
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[useAllMarkets] decoded ${decoded.length} markets · decodeFailures=${decodeFailures} · fieldGuards=${fieldGuards}`);
      return decoded;
    },
    // 60s staleTime + 30s background refresh: matrix data changes when
    // markets are settled / created, which is rare during a session.
    // 30s polling catches operator-side seed reruns without spamming
    // getMultipleAccountsInfo. Per-market detail (book + position) is
    // polled separately at 5s via useAccountSubscription.
    staleTime: 60_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
