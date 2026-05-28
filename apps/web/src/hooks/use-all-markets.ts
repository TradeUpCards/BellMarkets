"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  accountDiscriminator,
  decodeStrikeMarket,
} from "@/lib/solana/coder";
import { BELL_MARKETS_PROGRAM_PUBKEY } from "@/lib/solana/config";
import type { StrikeMarketWithPda } from "@/lib/solana/types";
import { queryKeys } from "@/lib/queries/keys";

/**
 * Enumerate every StrikeMarket account owned by the BellMarkets program.
 *
 * No subscription here intentionally: new strikes are created ~once/day by
 * Bram's morning job (admin-only). The page that uses this hook can
 * `invalidate(queryKeys.markets.list())` when it has a reason to believe a
 * new market was created (e.g., user navigated to Markets and we want a
 * fresh snapshot). The per-market detail hook (`useMarketAccount`) handles
 * tick-level updates via subscription.
 *
 * `staleTime: 60s` provides a soft cache for back-to-back navigations
 * without becoming a polling loop (no `refetchInterval`).
 */
export function useAllMarkets() {
  const { connection } = useConnection();

  return useQuery<StrikeMarketWithPda[]>({
    queryKey: queryKeys.markets.list(),
    queryFn: async () => {
      const discriminator = accountDiscriminator("StrikeMarket");
      // bs58 encoding is the cross-version-safe default for memcmp.bytes.
      // The base64 `encoding:` field was added in a later web3.js — using
      // it on older clients silently matches nothing, which manifests as
      // a stuck "Loading live markets" matrix.
      const accounts = await connection.getProgramAccounts(
        BELL_MARKETS_PROGRAM_PUBKEY,
        {
          commitment: "confirmed",
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: bs58.encode(discriminator),
              },
            },
          ],
        },
      );

      // DR-020 deploy_index=8: StrikeMarket gained `order_book: Pubkey`,
      // bumping LEN from 333 → 341 bytes. The 7 legacy META strikes from
      // deploy_index=6 still exist on chain at the old layout and the borsh
      // decoder either throws or produces a partial object with undefined
      // fields. Filter them out so consumers (trade-view, admin, markets-table)
      // can rely on `m.data.strikePrice` etc. being defined.
      const decoded: StrikeMarketWithPda[] = [];
      for (const { pubkey, account } of accounts) {
        try {
          const data = decodeStrikeMarket(account.data as Buffer);
          // Defensive: even if borsh succeeds, drop entries where load-bearing
          // fields are missing (legacy-schema accounts where partial decode
          // produces undefined BN values).
          if (!data?.strikePrice || !data.expiryUnix || !data.yesMint) {
            continue;
          }
          decoded.push({ pda: new PublicKey(pubkey), data });
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
