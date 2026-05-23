import type { PublicKey } from "@solana/web3.js";
import type BN from "bn.js";

/** Outcome enum encoding per IDL (`apps/web/src/idl/bell_markets.json`). */
export type OutcomeTag = "unsettled" | "yes" | "no" | "invalid";

/** Anchor decodes the on-chain `Outcome` enum as `{ <camelCaseName>: {} }`. */
export type Outcome =
  | { unsettled: Record<string, never> }
  | { yes: Record<string, never> }
  | { no: Record<string, never> }
  | { invalid: Record<string, never> };

export function outcomeTag(o: Outcome): OutcomeTag {
  if ("unsettled" in o) return "unsettled";
  if ("yes" in o) return "yes";
  if ("no" in o) return "no";
  return "invalid";
}

export function isSettled(o: Outcome): boolean {
  return outcomeTag(o) !== "unsettled";
}

/** Mirror of `programs/bell-markets/src/state.rs::MarketConfig` (post-Anchor decode). */
export interface MarketConfig {
  admin: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
  priceStalenessSecs: BN;
  priceConfidenceBps: number;
  adminOverrideDelaySecs: BN;
  paused: boolean;
  bump: number;
}

/** Mirror of `programs/bell-markets/src/state.rs::StrikeMarket` (post-Anchor decode). */
export interface StrikeMarket {
  config: PublicKey;
  underlyingPythFeed: PublicKey;
  strikePrice: BN;
  expiryUnix: BN;
  yesMint: PublicKey;
  noMint: PublicKey;
  usdcVault: PublicKey;
  phoenixMarket: PublicKey;
  settlePrice: BN;
  settleConfidence: BN;
  settleSlot: BN;
  settledAtUnix: BN;
  outcome: Outcome;
  adminOverrideEligibleAt: BN;
  bump: number;
  yesMintBump: number;
  noMintBump: number;
  vaultBump: number;
}

export interface StrikeMarketWithPda {
  pda: PublicKey;
  data: StrikeMarket;
}
