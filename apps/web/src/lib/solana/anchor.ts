"use client";

import { useMemo } from "react";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  useAnchorWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import idlJson from "@/idl/bell_markets.json";
import {
  BELL_MARKETS_PROGRAM_PUBKEY,
  CONFIG_PDA_SEED,
} from "./config";

export { useConnection } from "@solana/wallet-adapter-react";

const idl = idlJson as Idl;
const idlHasRealShape = Boolean(
  (idl as Partial<Idl>).instructions?.length &&
    (idl as { address?: string }).address,
);

/**
 * Returns an Anchor `Program` instance once a wallet is connected. The IDL
 * (`apps/web/src/idl/bell_markets.json`) is shipped Anchor-0.31-emitted, spec
 * v0.1.0, with `address` baked in — the constructor reads program id from
 * there. The guard against an empty/placeholder IDL stays as a defense if a
 * future re-scaffold drops the file back to `{}`.
 */
export function useBellMarketsProgram(): Program<Idl> | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;
    if (!idlHasRealShape) return null;

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    return new Program(idl, provider);
  }, [connection, wallet]);
}

export function deriveMarketConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(CONFIG_PDA_SEED)],
    BELL_MARKETS_PROGRAM_PUBKEY,
  );
}
