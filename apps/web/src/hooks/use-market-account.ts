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
    (data: Buffer): StrikeMarket => {
      // Same snake_case → camelCase normalization as useAllMarkets.
      // Anchor 0.30 BorshAccountsCoder + our IDL returns `yes_mint` /
      // `no_mint` / `pairs_outstanding` etc.; pre-fix usePosition couldn't
      // find the YES/NO mints (data.yesMint was undefined) so the user's
      // balances never loaded after a buy.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = decodeStrikeMarket(data) as any;
      return {
        ...d,
        strikePrice: d.strikePrice ?? d.strike_price,
        expiryUnix: d.expiryUnix ?? d.expiry_unix,
        yesMint: d.yesMint ?? d.yes_mint,
        noMint: d.noMint ?? d.no_mint,
        usdcVault: d.usdcVault ?? d.usdc_vault,
        phoenixMarket: d.phoenixMarket ?? d.phoenix_market,
        underlyingPythFeed:
          d.underlyingPythFeed ?? d.underlying_pyth_feed,
        settlePrice: d.settlePrice ?? d.settle_price,
        settleConfidence: d.settleConfidence ?? d.settle_confidence,
        settleSlot: d.settleSlot ?? d.settle_slot,
        settledAtUnix: d.settledAtUnix ?? d.settled_at_unix,
        adminOverrideEligibleAt:
          d.adminOverrideEligibleAt ?? d.admin_override_eligible_at,
        yesMintBump: d.yesMintBump ?? d.yes_mint_bump,
        noMintBump: d.noMintBump ?? d.no_mint_bump,
        vaultBump: d.vaultBump ?? d.vault_bump,
        pairsOutstanding: d.pairsOutstanding ?? d.pairs_outstanding,
        orderBook: d.orderBook ?? d.order_book,
      };
    },
    [],
  );

  return useAccountSubscriptionOrNull<StrikeMarket>(
    pubkey,
    decode,
    queryKeys.markets.detail(pubkey),
  );
}
