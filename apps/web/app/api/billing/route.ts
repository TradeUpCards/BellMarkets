/**
 * `/api/billing` — read-side subscription status for the current wallet.
 *
 * Accepts `?wallet=<base58>` query param (the frontend's
 * `useBellProSubscription` hook reads `wallet.publicKey` and supplies it).
 * Returns the current `BellProSubscription` row from the mock store.
 *
 * Auth posture (v0): no auth required to look up by wallet — the wallet
 * pubkey IS the identifier and the response carries no PII. When Bram's
 * session-rate-limit middleware lands, this gets the same protection
 * `/api/auth/session` has.
 *
 * Will eventually accept POST to mint a payment link for upgrade — for
 * now, GET-only.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getSubscription } from "@/lib/billing/store";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!wallet) {
    return NextResponse.json(
      { ok: false, error: "Missing ?wallet query param." },
      { status: 400 },
    );
  }
  // Minimal sanity on the wallet — Solana pubkeys are base58 of 32 bytes
  // → 43-44 chars. Reject anything outside that band.
  if (wallet.length < 32 || wallet.length > 44) {
    return NextResponse.json(
      { ok: false, error: "Invalid wallet pubkey format." },
      { status: 400 },
    );
  }
  const sub = getSubscription(wallet);
  return NextResponse.json({ ok: true, subscription: sub });
}
