/**
 * Bell Pro subscription primitives (DR-014 + AI v2 plan §6).
 *
 * Bell Pro is 9 USDC/mo via Helio. The frontend caches the read-side via
 * `useBellProSubscription`; the source of truth is Bram's Neon row updated
 * by the Helio webhook receiver at `/api/webhooks/helio`.
 *
 * Status semantics:
 *   - `active`    — paid through `expiresAtUnix`, all gated features unlock
 *   - `lapsed`    — payment failed / not renewed; features lock; UI surfaces
 *                   "renew" CTA (renewal payment-link generated on demand)
 *   - `cancelled` — explicit user cancel via Helio dashboard; same UX as lapsed
 *   - `none`      — never subscribed; shown the upgrade CTA on relevant surfaces
 */

export type BellProStatus = "active" | "lapsed" | "cancelled" | "none";

export interface BellProSubscription {
  walletPubkey: string;
  status: BellProStatus;
  /** Unix seconds — null when status is "none". */
  expiresAtUnix: number | null;
  /** Helio payment-link or subscription id. Useful for the renewal CTA. */
  helioSubscriptionId: string | null;
  /** Plan code (`bell_pro_monthly` v1). Reserved for future tiers. */
  planCode: "bell_pro_monthly" | null;
  /** Last webhook touch in unix seconds (informational, drives "stale" badge). */
  lastEventAtUnix: number | null;
}

export interface CreatePaymentLinkParams {
  /** Wallet that will be marked active on a successful payment. */
  walletPubkey: string;
  /** Email opportunistically captured at OAuth time, used by Helio's receipt. */
  email?: string;
  /** Where the user lands after a successful payment. */
  returnUrl: string;
}

export interface CreatePaymentLinkResult {
  /** Hosted hel.io page the UI redirects the user to. */
  paymentUrl: string;
  /** Helio's identifier for the link — persist so webhooks can reconcile. */
  paymentLinkId: string;
}

/**
 * Helio webhook event payloads. Helio's documented shape (as of 2026-05) —
 * subject to confirmation when we wire the live integration. The plumbing
 * doesn't depend on field-exact match; the route handler treats unknown
 * payloads as no-ops and logs a warning.
 */
export type HelioWebhookEvent =
  | {
      type: "subscription.purchased";
      walletPubkey: string;
      paymentLinkId: string;
      expiresAtUnix: number;
      planCode: "bell_pro_monthly";
    }
  | {
      type: "subscription.renewed";
      walletPubkey: string;
      paymentLinkId: string;
      expiresAtUnix: number;
    }
  | {
      type: "subscription.cancelled";
      walletPubkey: string;
      paymentLinkId: string;
    };

export const BELL_PRO_MONTHLY_USDC = 9;
