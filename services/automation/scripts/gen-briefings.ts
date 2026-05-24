// Generate Bell Pro daily briefings for all 7 MAG7 tickers.
//
// Usage:
//   pnpm --filter @bell-markets/automation briefings:gen           — all 7
//   pnpm --filter @bell-markets/automation briefings:gen META      — single ticker
//
// Per Tate dispatch 2026-05-24 ("Generate the Bell Pro briefings for demo"):
//   - Sonnet 4.6, ~150 words each
//   - Grounded context: spot price + ATM strike + earnings dates + 5-day momentum
//   - Disclaimer required in every briefing (enforced by system prompt)
//   - Persist to `briefings` table for Cleo's GET /api/briefings/:ticker
//
// Stub-friendly: when ANTHROPIC_API_KEY is unset, callAnthropic returns a
// deterministic stub response and we persist with model='stub' so cost
// dashboards filter it cleanly. Cleo's endpoint still serves something.
//
// Env required (live mode):
//   - ANTHROPIC_API_KEY              — generate at console.anthropic.com
//   - DATABASE_URL                   — Neon connection string (in .env.local)
//   - PYTH_HTTP_BASE_URL             — https://hermes.pyth.network
//   - PHOENIX_MARKET_<TICKER>        — optional (not used in this script)
// Pyth feed IDs are hardcoded in src/config.ts PYTH_HERMES_FEED_IDS.

import {
  buildBellProBriefingPrompt,
  callAnthropic,
  insertBriefing,
  type BellProBriefingContext,
} from "../src/ai/index.js";
import { PythClient } from "../src/clients/pyth.js";
import { computeStrikeGrid, TICKER_DEFAULTS } from "../src/ticker-config.js";
import { EARNINGS_DATES_2026 } from "../src/earnings-calendar.js";
import { MAG7, type Ticker } from "../src/types.js";
import { PYTH_HERMES_FEED_IDS, loadConfig } from "../src/config.js";
import { createHash } from "node:crypto";

type GenResult = {
  ticker: Ticker;
  status: "generated" | "stubbed" | "errored" | "skipped";
  briefingId?: number;
  model?: string;
  spotPriceUsd?: number;
  atmStrikeUsd?: number;
  costCents?: number;
  reason?: string;
};

function pickEarningsDates(ticker: Ticker, today: Date): { most: string | undefined; next: string | undefined } {
  const todayIso = today.toISOString().slice(0, 10);
  const dates = [...(EARNINGS_DATES_2026[ticker] ?? [])].sort();
  let most: string | undefined;
  let next: string | undefined;
  for (const d of dates) {
    if (d <= todayIso) most = d;
    else if (!next) {
      next = d;
      break;
    }
  }
  return { most, next };
}

function pickAtmStrike(spotUsd: number, ticker: Ticker): number {
  const tickSize = TICKER_DEFAULTS[ticker].strikeTickSizeUsd;
  const grid = computeStrikeGrid(spotUsd, tickSize);
  // Closest strike to spot
  let best = grid[0]!;
  let bestDist = Math.abs(best - spotUsd);
  for (const s of grid) {
    const d = Math.abs(s - spotUsd);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

async function generateForTicker(
  ticker: Ticker,
  pyth: PythClient,
  asOf: Date,
): Promise<GenResult> {
  const feedId = PYTH_HERMES_FEED_IDS[ticker];
  if (!feedId) return { ticker, status: "skipped", reason: "no Pyth Hermes feed id" };

  let spot: number;
  try {
    const priceRead = await pyth.getPreviousClose({ ticker, feedId });
    spot = priceRead.price;
  } catch (err) {
    return { ticker, status: "errored", reason: `Pyth read failed: ${(err as Error).message}` };
  }

  const atm = pickAtmStrike(spot, ticker);
  const { most, next } = pickEarningsDates(ticker, asOf);

  const context: BellProBriefingContext = {
    ticker,
    asOf,
    spotPriceUsd: spot,
    atmStrikeUsd: atm,
    mostRecentEarningsDate: most,
    nextEarningsDate: next,
    // 5-day momentum is not yet indexed (would need historical Pyth queries);
    // documented as v1.5 follow-up in the handoff.
    fiveDayMomentumPct: undefined,
  };

  const prompt = buildBellProBriefingPrompt(context);
  const result = await callAnthropic(prompt);

  if (!result.ok) {
    return { ticker, status: "errored", reason: result.error };
  }

  const promptHash = createHash("sha256")
    .update(JSON.stringify(prompt))
    .digest("hex");

  const id = await insertBriefing({
    ticker,
    model: result.stub ? "stub" : prompt.model,
    body: result.outputText,
    promptHash,
    requestId: result.requestId,
    costCents: result.costCents,
    context: {
      spotPriceUsd: spot,
      atmStrikeUsd: atm,
      mostRecentEarningsDate: most ?? null,
      nextEarningsDate: next ?? null,
      fiveDayMomentumPct: null,
      asOf: asOf.toISOString(),
      modelRequested: prompt.model,
    },
  });

  return {
    ticker,
    status: result.stub ? "stubbed" : "generated",
    briefingId: id,
    model: result.stub ? "stub" : prompt.model,
    spotPriceUsd: spot,
    atmStrikeUsd: atm,
    costCents: result.costCents,
  };
}

async function main() {
  const filterArg = process.argv[2];
  const tickers: Ticker[] = filterArg
    ? MAG7.includes(filterArg as Ticker)
      ? [filterArg as Ticker]
      : (() => {
          console.error(JSON.stringify({ event: "gen-briefings.fatal", error: `unknown ticker "${filterArg}"; valid: ${MAG7.join(",")}` }));
          process.exit(2);
        })()
    : [...MAG7];

  const cfg = loadConfig();
  if (!cfg.pythHttpBaseUrl) {
    console.error(JSON.stringify({ event: "gen-briefings.fatal", error: "PYTH_HTTP_BASE_URL unset in .env" }));
    process.exit(1);
  }
  const pyth = new PythClient({ baseUrl: cfg.pythHttpBaseUrl });
  const asOf = new Date();

  const isLiveMode = !!process.env.ANTHROPIC_API_KEY;
  console.error(
    JSON.stringify({
      event: "gen-briefings.start",
      mode: isLiveMode ? "live" : "stub",
      tickers,
      asOf: asOf.toISOString(),
      note: isLiveMode ? "Calling Anthropic API (Sonnet 4.6) — incurs cost" : "ANTHROPIC_API_KEY unset; running in STUB mode (zero cost)",
    }),
  );

  const results: GenResult[] = [];
  for (const ticker of tickers) {
    const result = await generateForTicker(ticker, pyth, asOf);
    results.push(result);
    console.error(
      JSON.stringify({
        event: "gen-briefings.ticker-complete",
        ticker,
        status: result.status,
        briefingId: result.briefingId,
        model: result.model,
        spotPriceUsd: result.spotPriceUsd,
        atmStrikeUsd: result.atmStrikeUsd,
        costCents: result.costCents,
        reason: result.reason,
      }),
    );
  }

  const summary = {
    event: "gen-briefings.summary",
    generated: results.filter((r) => r.status === "generated").length,
    stubbed: results.filter((r) => r.status === "stubbed").length,
    errored: results.filter((r) => r.status === "errored").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    totalCostCents: results.reduce((s, r) => s + (r.costCents ?? 0), 0),
  };
  console.log(JSON.stringify(summary, null, 2));

  const anyError = results.some((r) => r.status === "errored");
  process.exit(anyError ? 2 : 0);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      event: "gen-briefings.fatal",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  process.exit(1);
});
