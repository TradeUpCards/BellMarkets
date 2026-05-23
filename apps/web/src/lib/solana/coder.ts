import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";

import idlJson from "@/idl/bell_markets.json";

import type { MarketConfig, StrikeMarket } from "./types";

const idl = idlJson as Idl;

/**
 * Read-only Anchor account decoder. Wallet-free — used by hooks that browse
 * markets pre-wallet-connection. The full `Program` object is reserved for
 * sending transactions (which needs a wallet anyway).
 */
export const bellMarketsCoder = new BorshAccountsCoder(idl);

export function decodeMarketConfig(data: Buffer): MarketConfig {
  return bellMarketsCoder.decode<MarketConfig>("MarketConfig", data);
}

export function decodeStrikeMarket(data: Buffer): StrikeMarket {
  return bellMarketsCoder.decode<StrikeMarket>("StrikeMarket", data);
}

/**
 * Anchor account discriminator (first 8 bytes of sha256("account:<Name>")).
 * Read straight from the IDL JSON — Anchor 0.30 JS doesn't expose a static
 * for this and pulling in a sha256 polyfill just to recompute is wasteful.
 * Discriminator self-consistency is verified by `scripts/verify-idl.mjs`.
 */
export function accountDiscriminator(name: string): Buffer {
  const accounts = (idlJson as { accounts?: Array<{ name: string; discriminator: number[] }> }).accounts;
  const entry = accounts?.find((a) => a.name === name);
  if (!entry) throw new Error(`No account named "${name}" in IDL`);
  return Buffer.from(entry.discriminator);
}
