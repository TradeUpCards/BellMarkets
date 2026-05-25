/**
 * `/api/briefings/[ticker]` — read-side endpoint for the Bell Pro daily
 * briefing card on the landing page.
 *
 * Data path: services/automation generates the briefings via
 * `pnpm briefings:gen` (Pyth Hermes spot → ATM strike → Sonnet 4.6 → Neon
 * `briefings` table). This route just reads the freshest row per ticker via
 * `getLatestBriefing` from `@bell-markets/automation` and shapes it for the
 * frontend.
 *
 * Auth posture (v0): no auth required to fetch a briefing — the body is
 * deterministic content with no PII. Same posture as `/api/billing` (Bram).
 *
 * Caching: briefings refresh ~daily (cron not yet wired; manual `briefings:gen`
 * runs persist new rows). 60 s s-maxage + 5 min stale-while-revalidate gives
 * the landing page near-instant loads on repeat hits without serving truly
 * stale text the day after a refresh.
 *
 * Bram + Cleo paired-sprint deliverable P2 (2026-05-24).
 */

import { NextResponse, type NextRequest } from "next/server";

// Import via the `/ai` sub-export so we don't drag in discord.js / web-push /
// next-auth / @solana/web3.js etc. through the root barrel — the route only
// needs the lightweight ai/db helpers.
import { getLatestBriefing } from "@bell-markets/automation/ai";

// Neon serverless driver requires the Node runtime (not edge).
export const runtime = "nodejs";

// MAG7 tickers are 1–5 uppercase letters. Reject anything wider to avoid
// turning this into an open query interface.
const TICKER_RE = /^[A-Z]{1,5}$/;

export async function GET(
  _req: NextRequest,
  ctx: { params: { ticker: string } },
) {
  const ticker = (ctx.params.ticker ?? "").toUpperCase();
  if (!TICKER_RE.test(ticker)) {
    return NextResponse.json(
      { ok: false, error: "Invalid ticker (expected 1–5 uppercase letters)." },
      { status: 400 },
    );
  }

  let briefing;
  try {
    briefing = await getLatestBriefing(ticker);
  } catch (err) {
    // DATABASE_URL unset, Neon transient blip, etc. — return 503 so the
    // frontend can fall back to a placeholder card without retrying forever.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[briefings] getLatestBriefing failed for ${ticker}:`, reason);
    return NextResponse.json(
      { ok: false, error: "Briefing store unavailable." },
      { status: 503 },
    );
  }

  if (!briefing) {
    return NextResponse.json(
      { ok: false, error: `No briefing yet for ${ticker}.` },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      ticker: briefing.ticker,
      body: briefing.body,
      generated_at: briefing.generatedAt.toISOString(),
      model: briefing.model,
    },
    {
      headers: {
        // Briefings refresh ~daily; let the CDN hold the response for a minute
        // and serve stale up to 5 min while revalidating in the background.
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
