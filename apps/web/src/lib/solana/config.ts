import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PublicKey, clusterApiUrl } from "@solana/web3.js";

export const SOLANA_NETWORK: WalletAdapterNetwork = WalletAdapterNetwork.Devnet;

/**
 * RPC endpoint. Prefer NEXT_PUBLIC_SOLANA_RPC (Helius proxy via /api/solana-rpc
 * — keeps Helius key server-side, see apps/web/app/api/solana-rpc/route.ts);
 * fall back to clusterApiUrl(devnet) for local dev. Public Solana endpoints
 * are rate-limited — set NEXT_PUBLIC_SOLANA_RPC before any meaningful testing.
 *
 * Supports relative URLs (e.g. "/api/solana-rpc?network=devnet"):
 *   - Browser: resolved against window.location.origin.
 *   - SSR/SSG (no window): falls back to public devnet URL — the Connection
 *     constructor validates URL syntax at module load but doesn't actually
 *     fetch until client hydration, where the resolved-against-origin URL
 *     takes over.
 */
function resolveRpcEndpoint(): string {
  const envValue = process.env.NEXT_PUBLIC_SOLANA_RPC;
  if (!envValue) return clusterApiUrl(SOLANA_NETWORK);

  if (envValue.startsWith("http://") || envValue.startsWith("https://")) {
    return envValue;
  }

  // Relative URL (proxy route). Browser-only resolution.
  if (typeof window !== "undefined") {
    return new URL(envValue, window.location.origin).toString();
  }

  // SSR/SSG: return a syntactically-valid absolute URL so Connection
  // construction doesn't throw. The browser bundle re-runs this code
  // post-hydration and gets the proper proxy URL.
  return clusterApiUrl(SOLANA_NETWORK);
}

export const SOLANA_RPC_ENDPOINT: string = resolveRpcEndpoint();

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
