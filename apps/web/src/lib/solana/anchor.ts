"use client";

import { useMemo } from "react";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  useAnchorWallet,
  useConnection,
} from "@solana/wallet-adapter-react";

import idlJson from "@/idl/bell_markets.json";
import { BELL_MARKETS_PROGRAM_ID } from "./config";

export { useConnection } from "@solana/wallet-adapter-react";

/**
 * Returns an Anchor `Program` instance once an IDL has been copied into
 * `apps/web/src/idl/bell_markets.json` AND a wallet is connected.
 *
 * Aria writes the IDL after her first successful `anchor build`. Until then
 * this hook returns `null` and feature code is expected to render a "not yet
 * available" state rather than crashing. Never assume the program is non-null
 * inside trade/portfolio components — always guard.
 */
export function useBellMarketsProgram(): Program<Idl> | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;
    if (!BELL_MARKETS_PROGRAM_ID) return null;

    const idl = idlJson as Partial<Idl>;
    if (!idl.instructions || !idl.address) {
      // IDL placeholder still in place — Aria hasn't dropped a real build yet.
      return null;
    }

    const provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    return new Program(idl as Idl, provider);
  }, [connection, wallet]);
}
