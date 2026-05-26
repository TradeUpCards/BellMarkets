/**
 * `/api/spot/[ticker]` — live spot-price proxy for the MAG7 tickers, backed
 * by Pyth Hermes.
 *
 * Why a proxy (not client-direct):
 *   - Single source of truth for the feed-id mapping (don't ship the table
 *     to every client bundle).
 *   - Server-side CDN cache (Vercel/Next): one upstream Hermes fetch serves
 *     N concurrent browsers within the cache window. ~3s s-maxage matches
 *     Pyth's "human-tape" cadence (Hermes itself publishes every ~400ms but
 *     a 3s freshness is plenty for a trade-page tick + saves Hermes calls).
 *   - Easy to swap data source later (Pyth on-chain WS, Switchboard, Polygon)
 *     without touching trade-view.tsx.
 *   - Bram-side observability hook if we want to log spread / pause /
 *     anomaly in one place.
 *
 * Auth posture: no auth required (public market data). Same as `/api/billing`
 * + `/api/briefings/[ticker]`.
 *
 * Response shape:
 *   200 { ok: true, ticker, priceUsd, expo, publishTime, publishTimeIso, feedId, source }
 *   400 { ok: false, error: "Invalid ticker (expected 1-5 uppercase letters)." }
 *   404 { ok: false, error: "No Pyth feed mapping for <TICKER>." }     ← non-MAG7
 *   503 { ok: false, error: "Spot feed unavailable." }                  ← Hermes unreachable
 *
 * Tip for Cleo: poll this endpoint with TanStack Query's `refetchInterval:
 * 5000`. Three-second s-maxage means up to ~5 round trips/min × clients in the
 * same edge region collapse to 1 upstream Hermes call.
 *
 * Day-7 part 5 follow-up — Option B from `/check Cleo coordination` thread.
 */

import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

// MAG7 → Pyth Hermes feed IDs. Canonical source:
// `services/automation/src/config.ts:96` (PYTH_HERMES_FEED_IDS). Re-listed
// here so the route has no cross-package import (the @bell-markets/automation
// root barrel drags in discord.js / @solana/web3.js / ai SDK we don't need
// for a stateless HTTP proxy). If a feed ID ever changes upstream, update
// BOTH places — the smoke test verifies a 200 against AAPL on each deploy.
const PYTH_HERMES_FEED_IDS: Record<string, string> = {
  AAPL: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  MSFT: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
  GOOGL: "0xe65ff435be42630439c96396653a342829e877e2aafaeaf1a10d0ee5fd2cf3f2",
  AMZN: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
  NVDA: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
  META: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
  TSLA: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
};

// Pyth Hermes v2 endpoints live at the network root (no /api prefix);
// services/automation/.env's PYTH_HTTP_BASE_URL legacy default included /api
// — strip if present so both shapes resolve to the canonical base.
const HERMES_BASE = (process.env.PYTH_HTTP_BASE_URL || "https://hermes.pyth.network").replace(
  /\/api\/?$/,
  "",
);

const TICKER_RE = /^[A-Z]{1,5}$/;

/** Pyth's price object: stringified integers (price + conf) + signed expo. */
type PythPrice = {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
};

type PythHermesResponse = {
  parsed?: Array<{
    id: string;
    price: PythPrice;
    ema_price: PythPrice;
  }>;
  // Older shape — Hermes v1 returned [{price, conf, expo, publish_time}] flat.
  // We don't depend on it but parse defensively.
  [k: string]: unknown;
};

export async function GET(
  _req: NextRequest,
  ctx: { params: { ticker: string } },
) {
  const ticker = (ctx.params.ticker ?? "").toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    return NextResponse.json(
      { ok: false, error: "Invalid ticker (expected 1-5 uppercase letters)." },
      { status: 400 },
    );
  }

  const feedId = PYTH_HERMES_FEED_IDS[ticker];
  if (!feedId) {
    return NextResponse.json(
      { ok: false, error: `No Pyth feed mapping for ${ticker}.` },
      { status: 404 },
    );
  }

  const url = `${HERMES_BASE}/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`;

  let payload: PythHermesResponse;
  try {
    const res = await fetch(url, {
      // Next.js fetch cache: 3s gives a tight tape + cuts upstream Hermes
      // calls. Combined with the response-side Cache-Control below for the
      // CDN layer.
      next: { revalidate: 3 },
    });
    if (!res.ok) {
      console.error(`[spot] Hermes HTTP ${res.status} for ${ticker} (${feedId})`);
      return NextResponse.json(
        { ok: false, error: "Spot feed unavailable." },
        { status: 503 },
      );
    }
    payload = (await res.json()) as PythHermesResponse;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[spot] Hermes fetch failed for ${ticker}:`, reason);
    return NextResponse.json(
      { ok: false, error: "Spot feed unavailable." },
      { status: 503 },
    );
  }

  const parsed = Array.isArray(payload.parsed) ? payload.parsed : [];
  const entry = parsed[0];
  const priceObj = entry?.price;
  if (!entry || !priceObj || typeof priceObj.price !== "string") {
    console.error(`[spot] Hermes returned no parsed price for ${ticker}`);
    return NextResponse.json(
      { ok: false, error: "Spot feed unavailable." },
      { status: 503 },
    );
  }

  // Pyth integer + expo → human USD. expo is signed (typically -8 for US
  // equities); multiply price * 10^expo. BigInt → number is safe here:
  // MAG7 prices are O($1000) max → max integer is ~$1000 × 1e8 = 1e11, well
  // within Number's safe integer range (~9.007e15).
  const intPrice = Number(priceObj.price);
  const expo = priceObj.expo;
  const priceUsd = intPrice * Math.pow(10, expo);

  return NextResponse.json(
    {
      ok: true,
      ticker,
      priceUsd,
      expo,
      publishTime: priceObj.publish_time,
      publishTimeIso: new Date(priceObj.publish_time * 1000).toISOString(),
      feedId,
      source: "pyth-hermes",
    },
    {
      headers: {
        // CDN: 3s fresh + 10s stale-while-revalidate. A burst of N clients
        // hitting the same edge in the 3-second window costs 1 upstream
        // Hermes call. Stale window absorbs Hermes blips.
        "Cache-Control": "public, s-maxage=3, stale-while-revalidate=10",
      },
    },
  );
}
