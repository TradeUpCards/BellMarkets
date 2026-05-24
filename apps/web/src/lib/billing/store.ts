/**
 * Mock subscription state — temporary stand-in for Bram's Neon-backed table.
 *
 * Webhook handler upserts here; `/api/billing` route reads from here. Once
 * Bram's schema lands, replace both backing functions with Neon queries.
 *
 * **In-memory, process-local.** Serverless dev-only — DO NOT promote to
 * production. Logged once at module load so a stray prod path lights up
 * the deploy console.
 */

import type { BellProStatus, BellProSubscription } from "./types";

const store = new Map<string, BellProSubscription>();

if (process.env.NODE_ENV === "production") {
  // eslint-disable-next-line no-console
  console.warn(
    "[DR-014 mock] In-memory bell-pro subscription store is active in production. " +
      "Wire Neon backend before promoting.",
  );
}

export function getSubscription(walletPubkey: string): BellProSubscription {
  return (
    store.get(walletPubkey) ?? {
      walletPubkey,
      status: "none",
      expiresAtUnix: null,
      helioSubscriptionId: null,
      planCode: null,
      lastEventAtUnix: null,
    }
  );
}

export function upsertSubscription(input: {
  walletPubkey: string;
  status: BellProStatus;
  expiresAtUnix: number | null;
  helioSubscriptionId: string | null;
  planCode: "bell_pro_monthly" | null;
}): BellProSubscription {
  const next: BellProSubscription = {
    walletPubkey: input.walletPubkey,
    status: input.status,
    expiresAtUnix: input.expiresAtUnix,
    helioSubscriptionId: input.helioSubscriptionId,
    planCode: input.planCode,
    lastEventAtUnix: Math.floor(Date.now() / 1000),
  };
  store.set(input.walletPubkey, next);
  return next;
}

/** Test-only — reset between test cases. Never imported by the route handlers. */
export function _resetSubscriptionStoreForTests(): void {
  store.clear();
}
