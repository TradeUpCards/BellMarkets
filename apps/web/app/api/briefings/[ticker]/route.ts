import { NextResponse } from "next/server";

// Deep-import to avoid the root barrel's transitive discord.js / web-push pulls.
import { getLatestBriefing } from "@bell-markets/automation/src/ai/db.js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICKER_PATTERN = /^[A-Z]{1,5}$/;

export async function GET(
  _req: Request,
  { params }: { params: { ticker: string } },
) {
  const raw = params.ticker;
  const ticker = typeof raw === "string" ? raw.toUpperCase() : "";

  if (!TICKER_PATTERN.test(ticker)) {
    return NextResponse.json(
      { error: "invalid ticker" },
      { status: 400 },
    );
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "briefings unavailable: DATABASE_URL not configured" },
      { status: 503 },
    );
  }

  try {
    const briefing = await getLatestBriefing(ticker);
    if (!briefing) {
      return NextResponse.json({ briefing: null }, { status: 404 });
    }
    return NextResponse.json({
      briefing: {
        ticker: briefing.ticker,
        model: briefing.model,
        body: briefing.body,
        generatedAt: briefing.generatedAt.toISOString(),
        costCents: briefing.costCents ?? null,
      },
    });
  } catch (err) {
    console.error(
      `[api/briefings] ${ticker} read failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { error: "briefing read failed" },
      { status: 500 },
    );
  }
}
