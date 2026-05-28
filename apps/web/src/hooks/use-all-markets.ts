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
          if (i === 0) {
            // Dump the keys of the first decoded object so we can see EXACTLY
            // what field names the BorshAccountsCoder is returning. Removes
            // the "is it snake_case or camelCase?" guessing for the next
            // person who hits this.
            // eslint-disable-next-line no-console
            console.log(
              `[useAllMarkets] sample decoded keys for ${pdaList[0]!.toBase58().slice(0, 8)}…:`,
              data ? Object.keys(data as object) : "(null)",
            );
          }
          // Accept either casing — Anchor 0.30 BorshAccountsCoder behavior
          // varies by IDL format version; tolerate both rather than crash
          // the matrix on a guess about which one is current.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const d = data as any;
          const strikePrice = d?.strikePrice ?? d?.strike_price;
          const expiryUnix = d?.expiryUnix ?? d?.expiry_unix;
          const yesMint = d?.yesMint ?? d?.yes_mint;
          if (!strikePrice || !expiryUnix || !yesMint) {
            fieldGuards++;
            continue;
          }
          // Normalize to camelCase shape for downstream consumers (matrix,
          // trade-view, etc. — all coded against the camelCase StrikeMarket type).
          const normalized = {
            ...d,
            strikePrice,
            expiryUnix,
            yesMint,
            noMint: d?.noMint ?? d?.no_mint,
            usdcVault: d?.usdcVault ?? d?.usdc_vault,
            phoenixMarket: d?.phoenixMarket ?? d?.phoenix_market,
            underlyingPythFeed: d?.underlyingPythFeed ?? d?.underlying_pyth_feed,
            settlePrice: d?.settlePrice ?? d?.settle_price,
            settleConfidence: d?.settleConfidence ?? d?.settle_confidence,
            settleSlot: d?.settleSlot ?? d?.settle_slot,
            settledAtUnix: d?.settledAtUnix ?? d?.settled_at_unix,
            adminOverrideEligibleAt: d?.adminOverrideEligibleAt ?? d?.admin_override_eligible_at,
            yesMintBump: d?.yesMintBump ?? d?.yes_mint_bump,
            noMintBump: d?.noMintBump ?? d?.no_mint_bump,
            vaultBump: d?.vaultBump ?? d?.vault_bump,
            pairsOutstanding: d?.pairsOutstanding ?? d?.pairs_outstanding,
            orderBook: d?.orderBook ?? d?.order_book,
          };
          decoded.push({ pda: pdaList[i]!, data: normalized });
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
