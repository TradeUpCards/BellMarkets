import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { clusterApiUrl } from "@solana/web3.js";

export const SOLANA_NETWORK: WalletAdapterNetwork = WalletAdapterNetwork.Devnet;

/**
 * RPC endpoint. Prefer NEXT_PUBLIC_SOLANA_RPC (Helius/QuickNode) for production;
 * fall back to clusterApiUrl(devnet) for local dev. Public Solana endpoints
 * are rate-limited — set NEXT_PUBLIC_SOLANA_RPC before any meaningful testing.
 */
export const SOLANA_RPC_ENDPOINT: string =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? clusterApiUrl(SOLANA_NETWORK);

export const BELL_MARKETS_PROGRAM_ID: string =
  process.env.NEXT_PUBLIC_BELL_MARKETS_PROGRAM_ID ?? "";
