import { NextRequest } from "next/server";

export const runtime = "nodejs";

/**
 * Forwards JSON-RPC to a provider URL kept SERVER-SIDE (Helius key never
 * appears in NEXT_PUBLIC_*).
 *
 * Adapted from w3Swap's same-named route. Client points
 * NEXT_PUBLIC_SOLANA_RPC at /api/solana-rpc?network=devnet; the wallet
 * adapter + connection.onAccountChange + all RPC reads/writes flow through
 * this route. The Helius API key stays server-side in Vercel env vars.
 *
 * Query: ?network=mainnet|devnet. If omitted, defaults to devnet (BellMarkets v1).
 *
 * Env (Vercel server-only, NOT NEXT_PUBLIC), first match wins per network:
 *   1. SOLANA_RPC_INTERNAL_URL / SOLANA_RPC_INTERNAL_URL_DEVNET — full
 *      JSON-RPC URLs (e.g., your private Helius/Triton URL)
 *   2. HELIUS_API_KEY / HELIUS_API_KEY_DEVNET — builds the Helius URL
 *      inline: https://devnet.helius-rpc.com/?api-key=<key>
 *   3. Devnet fallback: public api.devnet.solana.com
 *   4. Mainnet: 500 (refuses without explicit config — safety)
 */

function isMainnetNetworkParam(n: string | null): boolean {
  const v = (n || "devnet").toLowerCase();
  return v === "mainnet" || v === "mainnet-beta" || v === "mainnetbeta";
}

function heliusMainnetUrl(): string | null {
  const k = process.env.HELIUS_API_KEY?.trim();
  if (!k) return null;
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}`;
}

function heliusDevnetUrl(): string | null {
  const k =
    process.env.HELIUS_API_KEY_DEVNET?.trim() ||
    process.env.HELIUS_API_KEY?.trim();
  if (!k) return null;
  return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}`;
}

async function forward(request: NextRequest) {
  const network = request.nextUrl.searchParams.get("network");

  const mainnetUrl =
    process.env.SOLANA_RPC_INTERNAL_URL?.trim() || heliusMainnetUrl() || null;
  const devnetUrl =
    process.env.SOLANA_RPC_INTERNAL_URL_DEVNET?.trim() ||
    heliusDevnetUrl() ||
    "https://api.devnet.solana.com";

  const upstream = isMainnetNetworkParam(network) ? mainnetUrl : devnetUrl;

  if (!upstream) {
    return Response.json(
      {
        error:
          "Mainnet JSON-RPC proxy: set SOLANA_RPC_INTERNAL_URL or HELIUS_API_KEY (server env, not NEXT_PUBLIC)",
      },
      { status: 500 },
    );
  }

  const body = request.method === "POST" ? await request.text() : null;
  const res = await fetch(upstream, {
    method: request.method,
    headers: { "Content-Type": "application/json" },
    body,
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
    },
  });
}

export async function POST(request: NextRequest) {
  return forward(request);
}

// Some RPC clients (notably wallet-adapter health checks) GET the endpoint —
// forward those too so the route works as a drop-in Connection URL.
export async function GET(request: NextRequest) {
  return forward(request);
}
