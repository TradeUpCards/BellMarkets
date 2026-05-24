// DR-014 — Web Push notification helpers, adapted from /c/Dev/fffanalytics_t3/
// src/actions/pushNotificationActions.ts.
//
// Design:
//   - VAPID keys configured via env (NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY)
//     + the contact email (VAPID_CONTACT_EMAIL — defaults to a placeholder so
//     missing config still surfaces a clear error rather than crashing import).
//   - Subscription persistence delegates to auth/db.ts (upsertPushSubscription,
//     markPushSubscriptionStatus, listActivePushSubscriptions).
//   - Send-time errors that indicate a permanently-dead endpoint
//     (web-push 404/410) auto-mark the row as 'revoked'.
//
// Frontend ownership: Cleo's apps/web subscribes via the browser Push API +
// POSTs the resulting PushSubscription JSON to this service's
// `/api/push/subscribe` endpoint (which calls `subscribeToPushFromBrowser`).
// On settle/leaderboard milestone, the cron calls `sendPushToUser` here.

import type { PushSubscription as WebPushSubscription, RequestOptions } from "web-push";
import {
  listActivePushSubscriptions,
  markPushSubscriptionStatus,
  upsertPushSubscription,
  logNotificationSent,
} from "./db.js";
import type {
  NotificationKind,
  PushSubscriptionRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Lazy VAPID setup (deferred until first call so unit-tests don't need keys)
// ---------------------------------------------------------------------------

let webpushModule: typeof import("web-push") | undefined;
let vapidConfigured = false;

async function getWebPush(): Promise<typeof import("web-push")> {
  if (webpushModule) return webpushModule;
  webpushModule = (await import("web-push")) as typeof import("web-push");
  return webpushModule;
}

export class WebPushError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "WebPushError";
  }
}

async function ensureVapidConfigured(): Promise<void> {
  if (vapidConfigured) return;
  const wp = await getWebPush();
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL ?? "mailto:noreply@bellmarkets.invalid";
  if (!publicKey || !privateKey) {
    throw new WebPushError(
      "VAPID keys missing. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in .env (generate via `npx web-push generate-vapid-keys`).",
    );
  }
  wp.setVapidDetails(contact, publicKey, privateKey);
  vapidConfigured = true;
}

/** Reset VAPID setup state — exported for tests; not for runtime use. */
export function _resetVapidForTesting(): void {
  vapidConfigured = false;
}

// ---------------------------------------------------------------------------
// Subscription endpoint — called from Cleo's HTTP route
// ---------------------------------------------------------------------------

/**
 * Subscribe a user to push notifications. Accepts the raw browser
 * PushSubscription shape (as returned by `pushManager.subscribe()`) +
 * persists to push_subscriptions. Idempotent on (user, endpoint).
 *
 * Cleo's frontend route:
 *   POST /api/push/subscribe
 *     body: { subscription: PushSubscriptionJSON, ua: string }
 *     (Authorization: session.user.id from NextAuth)
 *   → calls subscribeToPushFromBrowser(userId, body)
 */
export async function subscribeToPushFromBrowser(
  userId: string,
  body: {
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };
    ua?: string;
  },
): Promise<PushSubscriptionRecord> {
  const { subscription, ua } = body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new WebPushError("subscribeToPushFromBrowser: subscription must include endpoint + keys.p256dh + keys.auth");
  }
  return upsertPushSubscription(userId, {
    endpoint: subscription.endpoint,
    p256dhKey: subscription.keys.p256dh,
    authKey: subscription.keys.auth,
    uaString: ua,
  });
}

/** Mark a subscription as revoked (user clicked "unsubscribe" or browser blocked). */
export async function unsubscribeFromPush(endpoint: string): Promise<void> {
  await markPushSubscriptionStatus(endpoint, "revoked");
}

// ---------------------------------------------------------------------------
// Send-time helpers
// ---------------------------------------------------------------------------

export type PushPayload = {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  /** URL to open when notification is clicked. */
  data?: { url?: string; [k: string]: unknown };
};

export type PushSendResult = {
  recipientCount: number;
  successCount: number;
  failureCount: number;
  expiredEndpoints: string[];
};

/**
 * Send a push notification to all active subscriptions for a user.
 * Logs each send into `notifications_sent`. On web-push 404/410, marks the
 * subscription as `expired` so future sends skip it.
 */
export async function sendPushToUser(
  userId: string,
  kind: NotificationKind,
  payload: PushPayload,
): Promise<PushSendResult> {
  const subs = await listActivePushSubscriptions(userId);
  return sendPushToSubscriptions(userId, kind, payload, subs);
}

/**
 * Broadcast to every active subscription in the DB (e.g. newsletter).
 * Use sparingly — for per-user sends prefer sendPushToUser.
 */
export async function broadcastPush(
  kind: NotificationKind,
  payload: PushPayload,
): Promise<PushSendResult> {
  const subs = await listActivePushSubscriptions(undefined);
  // For broadcasts we don't have a per-user audit row; log against each user.
  return sendPushToSubscriptionsByUser(kind, payload, subs);
}

async function sendPushToSubscriptions(
  userId: string,
  kind: NotificationKind,
  payload: PushPayload,
  subs: PushSubscriptionRecord[],
): Promise<PushSendResult> {
  if (subs.length === 0) {
    return { recipientCount: 0, successCount: 0, failureCount: 0, expiredEndpoints: [] };
  }
  await ensureVapidConfigured();
  const wp = await getWebPush();
  const expiredEndpoints: string[] = [];
  let successCount = 0;
  let failureCount = 0;
  for (const sub of subs) {
    const ok = await trySend(wp, sub, payload);
    if (ok.expired) expiredEndpoints.push(sub.endpoint);
    if (ok.success) successCount++;
    else failureCount++;
    await logNotificationSent({
      userId,
      channel: "push",
      kind,
      payload: { endpointHashed: hashEndpoint(sub.endpoint), title: payload.title },
      status: ok.success ? "sent" : "failed",
      lastError: ok.error,
    });
  }
  for (const endpoint of expiredEndpoints) {
    await markPushSubscriptionStatus(endpoint, "expired");
  }
  return {
    recipientCount: subs.length,
    successCount,
    failureCount,
    expiredEndpoints,
  };
}

async function sendPushToSubscriptionsByUser(
  kind: NotificationKind,
  payload: PushPayload,
  subs: PushSubscriptionRecord[],
): Promise<PushSendResult> {
  if (subs.length === 0) {
    return { recipientCount: 0, successCount: 0, failureCount: 0, expiredEndpoints: [] };
  }
  await ensureVapidConfigured();
  const wp = await getWebPush();
  const expiredEndpoints: string[] = [];
  let successCount = 0;
  let failureCount = 0;
  for (const sub of subs) {
    const ok = await trySend(wp, sub, payload);
    if (ok.expired) expiredEndpoints.push(sub.endpoint);
    if (ok.success) successCount++;
    else failureCount++;
    await logNotificationSent({
      userId: sub.userId,
      channel: "push",
      kind,
      payload: { endpointHashed: hashEndpoint(sub.endpoint), title: payload.title, broadcast: true },
      status: ok.success ? "sent" : "failed",
      lastError: ok.error,
    });
  }
  for (const endpoint of expiredEndpoints) {
    await markPushSubscriptionStatus(endpoint, "expired");
  }
  return {
    recipientCount: subs.length,
    successCount,
    failureCount,
    expiredEndpoints,
  };
}

async function trySend(
  wp: typeof import("web-push"),
  sub: PushSubscriptionRecord,
  payload: PushPayload,
): Promise<{ success: boolean; expired: boolean; error?: string }> {
  const webSub: WebPushSubscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
  };
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon ?? "/favicon.ico",
    badge: payload.badge ?? "/favicon.ico",
    data: payload.data ?? {},
  });
  const opts: RequestOptions = { TTL: 60 * 60 * 24 };
  try {
    await wp.sendNotification(webSub, body, opts);
    return { success: true, expired: false };
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    const expired = e.statusCode === 404 || e.statusCode === 410;
    return {
      success: false,
      expired,
      error: `web-push${e.statusCode ? ` ${e.statusCode}` : ""}: ${e.message ?? String(err)}`,
    };
  }
}

/**
 * Hashed-endpoint logging — endpoints contain a per-user secret URL (Chrome's
 * FCM endpoint includes the registration token); never log the raw value to
 * `notifications_sent.payload`. Hash to give us idempotency without exposing.
 */
function hashEndpoint(endpoint: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}
