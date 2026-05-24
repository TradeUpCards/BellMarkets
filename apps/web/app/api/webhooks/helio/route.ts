/**
 * Helio webhook receiver — subscription purchase / renewal / cancellation
 * events arrive here and update the bell-pro subscription state.
 *
 * Security: HMAC-SHA256 verified against `HELIO_WEBHOOK_SECRET` via
 * `verifyHelioSignature`. Constant-time comparison inside that helper.
 * Unsigned or wrongly-signed requests return 401.
 *
 * Behavior on unknown event shapes: log a warning and return 200 — we
 * never want to break Helio's retry chain on a benign new event type. The
 * subscription store stays untouched.
 *
 * **Plumbing only.** The mock store at `lib/billing/store.ts` is the v0
 * persistence; Bram swaps it for a Neon-backed implementation when his
 * schema lands.
 */

import { NextResponse, type NextRequest } from "next/server";

import { verifyHelioSignature } from "@/lib/billing/helio";
import { upsertSubscription } from "@/lib/billing/store";
import type { HelioWebhookEvent } from "@/lib/billing/types";

export const runtime = "nodejs"; // node:crypto + node:process

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-helio-signature");

  let signatureOk = false;
  try {
    signatureOk = verifyHelioSignature(rawBody, sig);
  } catch (err) {
    // HelioConfigError — env not wired. Surface a 500 not a 401 because
    // the upstream isn't at fault.
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Helio config error.",
      },
      { status: 500 },
    );
  }

  if (!signatureOk) {
    return NextResponse.json(
      { ok: false, error: "Invalid Helio webhook signature." },
      { status: 401 },
    );
  }

  let event: HelioWebhookEvent | null = null;
  try {
    event = JSON.parse(rawBody) as HelioWebhookEvent;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Malformed JSON." },
      { status: 400 },
    );
  }

  if (!event || typeof event !== "object" || !("type" in event)) {
    console.warn("Helio webhook: missing or unknown event type", {
      keys: event ? Object.keys(event as object) : [],
    });
    return NextResponse.json({ ok: true });
  }

  switch (event.type) {
    case "subscription.purchased":
    case "subscription.renewed":
      upsertSubscription({
        walletPubkey: event.walletPubkey,
        status: "active",
        expiresAtUnix: event.expiresAtUnix,
        helioSubscriptionId: event.paymentLinkId,
        planCode:
          event.type === "subscription.purchased" ? event.planCode : "bell_pro_monthly",
      });
      break;
    case "subscription.cancelled":
      upsertSubscription({
        walletPubkey: event.walletPubkey,
        status: "cancelled",
        expiresAtUnix: null,
        helioSubscriptionId: event.paymentLinkId,
        planCode: "bell_pro_monthly",
      });
      break;
    default:
      // Unknown but signed — log and ack so Helio doesn't retry forever.
      console.warn("Helio webhook: unrecognized event type", {
        type: (event as { type?: string }).type,
      });
  }

  return NextResponse.json({ ok: true });
}
