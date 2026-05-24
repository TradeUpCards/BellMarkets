"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

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
      const accounts = await connection.getProgramAccounts(
        BELL_MARKETS_PROGRAM_PUBKEY,
        {
          commitment: "confirmed",
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: discriminator.toString("base64"),
                encoding: "base64",
              },
            },
          ],
        },
      );

      return accounts.map(({ pubkey, account }) => ({
        pda: new PublicKey(pubkey),
        data: decodeStrikeMarket(account.data as Buffer),
      }));
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
