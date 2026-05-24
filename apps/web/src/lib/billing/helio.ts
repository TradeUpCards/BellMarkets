/**
 * Helio integration helpers (DR-014 / AI v2 §6).
 *
 * - `createPaymentLink` calls Helio's REST API to mint a hosted payment page
 *   the user is redirected to for Bell Pro purchase / renewal.
 * - `verifyHelioSignature` validates incoming webhook payloads (HMAC-SHA256
 *   against `HELIO_WEBHOOK_SECRET`). Constant-time comparison via
 *   `crypto.timingSafeEqual` — prevents timing-leak attacks against the
 *   webhook secret.
 *
 * We deliberately don't import an `@heliofi/*` SDK yet:
 *   - The Helio JS SDK is light and the surface we need (one POST + one
 *     HMAC verify) is two small fetch calls.
 *   - Avoiding the SDK keeps our `apps/web` bundle slim and dodges any peer-
 *     dep churn with the Solana wallet-adapter / Anchor stack.
 *
 * `HELIO_API_KEY` + `HELIO_API_BASE_URL` + `HELIO_PAYMENT_LINK_ID` +
 * `HELIO_WEBHOOK_SECRET` env vars are expected at the server side. The
 * client never sees these — payment-link creation runs through the
 * `/api/billing` route which Bram will harden against unauthenticated
 * misuse once his session-rate-limit middleware lands.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CreatePaymentLinkParams,
  CreatePaymentLinkResult,
} from "./types";

const DEFAULT_HELIO_BASE = "https://api.hel.io";

export class HelioConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelioConfigError";
  }
}

export class HelioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "HelioApiError";
  }
}

interface HelioEnv {
  apiKey: string;
  apiBaseUrl: string;
  paymentLinkId: string;
  webhookSecret: string;
}

function readEnv(): HelioEnv {
  const apiKey = process.env.HELIO_API_KEY;
  const paymentLinkId = process.env.HELIO_PAYMENT_LINK_ID;
  const webhookSecret = process.env.HELIO_WEBHOOK_SECRET;
  const apiBaseUrl = process.env.HELIO_API_BASE_URL ?? DEFAULT_HELIO_BASE;
  if (!apiKey) throw new HelioConfigError("HELIO_API_KEY is unset.");
  if (!paymentLinkId)
    throw new HelioConfigError("HELIO_PAYMENT_LINK_ID is unset.");
  if (!webhookSecret) throw new HelioConfigError("HELIO_WEBHOOK_SECRET is unset.");
  return { apiKey, apiBaseUrl, paymentLinkId, webhookSecret };
}

/**
 * Create a hosted Helio payment session for Bell Pro. Returns the URL the
 * user is redirected to.
 *
 * **Plumbing note:** this is the canonical contract; the underlying Helio
 * endpoint + payload shape may need adjustment when we wire against the
 * live sandbox. The `fetchImpl` injection point lets tests stub without
 * hitting the network and gives us a clean upgrade path.
 */
export async function createPaymentLink(
  params: CreatePaymentLinkParams,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CreatePaymentLinkResult> {
  const env = readEnv();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const url = `${env.apiBaseUrl.replace(/\/$/, "")}/v1/paylink/${env.paymentLinkId}/sessions`;

  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      customerWallet: params.walletPubkey,
      email: params.email ?? null,
      returnUrl: params.returnUrl,
      metadata: {
        // Round-trips back on the webhook so we can reconcile by wallet
        // even if Helio's primary id is opaque.
        walletPubkey: params.walletPubkey,
      },
    }),
  });

  if (!resp.ok) {
    throw new HelioApiError(
      `Helio paylink create failed: ${resp.status} ${resp.statusText}`,
      resp.status,
    );
  }

  const body = (await resp.json()) as {
    paymentUrl?: string;
    sessionId?: string;
  };
  if (!body.paymentUrl || !body.sessionId) {
    throw new HelioApiError(
      "Helio paylink response missing paymentUrl or sessionId.",
      resp.status,
    );
  }
  return { paymentUrl: body.paymentUrl, paymentLinkId: body.sessionId };
}

/**
 * Verify the `X-Helio-Signature` HMAC on an incoming webhook payload.
 * Returns `true` on match, `false` otherwise. **Throws** if the secret
 * isn't configured — that's a deploy-config bug, not a per-request signal.
 */
export function verifyHelioSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) return false;
  const env = readEnv();
  const expected = createHmac("sha256", env.webhookSecret)
    .update(rawBody)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const givenBuf = safeHexBuf(signatureHeader);
  if (!givenBuf) return false;
  if (givenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(expectedBuf, givenBuf);
}

function safeHexBuf(hex: string): Buffer | null {
  // Strip optional "sha256=" prefix some webhook providers use.
  const cleaned = hex.startsWith("sha256=") ? hex.slice(7) : hex;
  if (!/^[0-9a-f]+$/i.test(cleaned)) return null;
  try {
    return Buffer.from(cleaned, "hex");
  } catch {
    return null;
  }
}
