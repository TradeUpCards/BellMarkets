// AI v2 — Sonnet briefing prompt scaffold.
//
// Per ai-v2-plan §4 phase 0: "Daily MAG7 briefing (shared cache, 7 briefings/day,
// generated 5 AM ET pre-market)". This module ships the prompt builder
// + scaffold; the cron that fires it daily is intentionally NOT wired (per
// Tate dispatch: "Don't wire briefing generation cron yet — just the data
// plumbing").
//
// When the cron lands (v1.5 phase 0), it will:
//   1. Fetch last 24h of `news_classifications` per ticker (joined with
//      `news_articles`).
//   2. Build briefing prompt via `buildDailyTickerBriefingPrompt`.
//   3. Call Sonnet via `callAnthropic({ kind: "briefing", model: "claude-sonnet-4-6" })`.
//   4. Result auto-logged to ai_outputs by the wrapper.
//   5. Cache-friendly: same MAG7 corpus prefix means high cache-read hit rate
//      across the 7 ticker briefings.

import type { AnthropicCallInput } from "./anthropic-client.js";
import type { NewsArticle, NewsClassification, Ticker } from "./types.js";

export const DEFAULT_BRIEFING_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Bell Pro briefing — demo path (grounded on spot + ATM + earnings + momentum)
// ---------------------------------------------------------------------------

const BELL_PRO_SYSTEM_PROMPT = `You write the BellMarkets Bell Pro daily ticker briefing — neutral, ground-truthed market intelligence. NOT investment advice.

Strict language rules:
FORBIDDEN: "should", "advise", "recommend", "buy", "sell", "guaranteed", "will rise/fall".
ALLOWED: "factors that may impact", "sensitivities to consider", "historical base rates suggest", "implied probability".

Each briefing is ~150 words. Structure:
- 1-sentence summary of the day's setup for the ticker
- 3 bullets: factors traders may want to weigh
- 1-sentence forward look (this week or month, factors to monitor)
- Final line, verbatim: "Information only. Not financial advice."

Use ONLY the grounded data the user provides. Do NOT invent prices, dates, or earnings results not in the input.`;

export type BellProBriefingContext = {
  ticker: string;
  asOf: Date;
  spotPriceUsd: number;
  atmStrikeUsd: number;
  /** Most recent past earnings event in YYYY-MM-DD format. Undefined if unknown. */
  mostRecentEarningsDate?: string;
  /** Next upcoming earnings event in YYYY-MM-DD format. Undefined if unknown. */
  nextEarningsDate?: string;
  /** Percent change over last 5 trading days. Undefined when not indexed (v1.5). */
  fiveDayMomentumPct?: number;
};

/**
 * Build the Bell Pro briefing prompt. Pure function. Ground-truthed context
 * goes into the user message; system prompt enforces 150-word ceiling +
 * forbidden-word policy + mandatory disclaimer.
 */
export function buildBellProBriefingPrompt(input: BellProBriefingContext): AnthropicCallInput {
  const lines: string[] = [
    `TICKER: ${input.ticker}`,
    `AS_OF: ${input.asOf.toISOString()}`,
    `SPOT_PRICE_USD: ${input.spotPriceUsd.toFixed(2)}`,
    `ATM_STRIKE_USD: ${input.atmStrikeUsd.toFixed(2)}`,
  ];
  if (input.mostRecentEarningsDate) {
    lines.push(`MOST_RECENT_EARNINGS_DATE: ${input.mostRecentEarningsDate}`);
  }
  if (input.nextEarningsDate) {
    lines.push(`NEXT_EARNINGS_DATE: ${input.nextEarningsDate}`);
  }
  if (typeof input.fiveDayMomentumPct === "number") {
    lines.push(`FIVE_DAY_MOMENTUM_PCT: ${input.fiveDayMomentumPct.toFixed(2)}`);
  } else {
    lines.push(`FIVE_DAY_MOMENTUM_PCT: (unavailable; do not invent)`);
  }
  lines.push("");
  lines.push(
    `Write the ~150-word Bell Pro briefing for ${input.ticker} per the rules above. Do not exceed 200 words. Always end with the disclaimer line.`,
  );
  return {
    kind: "briefing",
    model: DEFAULT_BRIEFING_MODEL,
    system: BELL_PRO_SYSTEM_PROMPT,
    messages: [{ role: "user", content: lines.join("\n") }],
    maxTokens: 320, // ~150-200 words at ~1.5 tokens per word
    relatedTicker: input.ticker,
  };
}

const SYSTEM_PROMPT = `You write daily pre-market briefings for BellMarkets, a Solana-based binary outcome prediction market on MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA).

You produce neutral, ground-truthed market intelligence — NOT investment advice. Strict language rules:

FORBIDDEN words: "should", "advise", "recommend", "buy", "sell", "guaranteed", "will rise/fall".
ALLOWED phrasing: "factors that may impact", "sensitivities to consider", "historical base rates suggest", "implied probability is X%".

Each briefing is ~250-400 words:
- 1-2 sentence summary of overnight + AH news
- 3-5 bullet points: factors traders may want to consider
- Macro context (if relevant): FOMC, CPI, earnings calendar
- End with: "This briefing summarizes public news; it is not financial advice. Markets carry risk."

NEVER name BellMarkets strikes, prices, or open interest in the briefing. Stay news-focused.`;

export type DailyBriefingInput = {
  ticker: Ticker;
  /** Pre-market briefing as-of timestamp (typically the local 5 AM ET fire). */
  asOf: Date;
  /** Last-24h news + sentiment classifications, joined. */
  newsItems: Array<{
    article: NewsArticle;
    classification: NewsClassification | undefined;
  }>;
  /** Optional macro events scheduled in next 24h (FOMC, CPI, earnings). */
  upcomingMacro?: Array<{ at: Date; description: string }>;
};

/** Build the structured Sonnet briefing prompt. Pure function — no I/O,
 *  no DB. Used by the (future) cron + by unit tests. */
export function buildDailyTickerBriefingPrompt(input: DailyBriefingInput): AnthropicCallInput {
  const { ticker, asOf, newsItems, upcomingMacro } = input;

  // Sort news by published_at DESC, take top 12 (input-token budget cap)
  const sorted = [...newsItems]
    .sort((a, b) => b.article.publishedAt.getTime() - a.article.publishedAt.getTime())
    .slice(0, 12);

  const newsBlock =
    sorted.length === 0
      ? "(no recent news in the last 24h)"
      : sorted
          .map((n) => {
            const sentiment = n.classification?.sentiment ?? "unclassified";
            const conf = n.classification?.confidence ?? 0;
            return `- [${n.article.publishedAt.toISOString()}] (${sentiment}, conf=${conf.toFixed(2)}) ${n.article.headline}${n.article.body ? `\n  ${n.article.body.slice(0, 280)}` : ""}`;
          })
          .join("\n");

  const macroBlock = upcomingMacro && upcomingMacro.length > 0
    ? upcomingMacro
        .map((m) => `- ${m.at.toISOString()}: ${m.description}`)
        .join("\n")
    : "(no major scheduled macro events in next 24h)";

  const userMessage = `TICKER: ${ticker}
AS_OF: ${asOf.toISOString()}

RECENT NEWS (most recent first):
${newsBlock}

UPCOMING MACRO EVENTS:
${macroBlock}

Write the daily ${ticker} briefing per the rules above.`;

  return {
    kind: "briefing",
    model: DEFAULT_BRIEFING_MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 800,
    relatedTicker: ticker,
  };
}
