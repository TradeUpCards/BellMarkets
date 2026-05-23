import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PublicKey, clusterApiUrl } from "@solana/web3.js";

export const SOLANA_NETWORK: WalletAdapterNetwork = WalletAdapterNetwork.Devnet;

/**
 * RPC endpoint. Prefer NEXT_PUBLIC_SOLANA_RPC (Helius/QuickNode) for production;
 * fall back to clusterApiUrl(devnet) for local dev. Public Solana endpoints
 * are rate-limited — set NEXT_PUBLIC_SOLANA_RPC before any meaningful testing.
 */
export const SOLANA_RPC_ENDPOINT: string =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? clusterApiUrl(SOLANA_NETWORK);

/**
 * Canonical devnet deployment of the BellMarkets program (Aria, 2026-05-21).
 * Env var overrides for future redeploys without a rebuild.
 */
const BELL_MARKETS_DEVNET_PROGRAM_ID =
  "599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV";

export const BELL_MARKETS_PROGRAM_ID: string =
  process.env.NEXT_PUBLIC_BELL_MARKETS_PROGRAM_ID ??
  BELL_MARKETS_DEVNET_PROGRAM_ID;

export const BELL_MARKETS_PROGRAM_PUBKEY = new PublicKey(
  BELL_MARKETS_PROGRAM_ID,
);

/** Seed for the MarketConfig singleton PDA: PDA(["config"], program). */
export const CONFIG_PDA_SEED = "config";
