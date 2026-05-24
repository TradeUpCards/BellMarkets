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
// ET wall-clock + market-session helpers (shared by Bell Pro briefing + PNL digest)
// ---------------------------------------------------------------------------

/**
 * Format a Date as ET wall-clock: "Sunday, May 24, 2026 at 9:22 AM ET".
 * Locale en-US with America/New_York timezone. Used in prompts so the model
 * NEVER sees raw UTC + invents "mid-session" when it's actually weekend close.
 */
export function formatEtWallClock(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}

/** ET-only date in "YYYY-MM-DD" format (sortable). */
export function formatEtDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export type MarketSession =
  | "pre-market" //   4:00 AM - 9:30 AM ET trading day
  | "regular" //      9:30 AM - 4:00 PM ET (or - 1:00 PM half-days)
  | "after-hours" //  4:00 PM - 8:00 PM ET (or 1:00 PM - 8:00 PM half-days)
  | "closed-overnight" // 8:00 PM ET - 4:00 AM ET trading days
  | "closed-weekend" //   Sat / Sun
  | "closed-holiday"; //  US equity full holiday

/**
 * Classify the market session for a given instant. Pure function — depends
 * only on the ET wall-clock components, the DR-007 calendar (`isTradingDay`,
 * `isHalfDay`), and a half-day vs regular close cutoff.
 *
 * Returned as a stable string so the prompt can branch deterministically.
 */
export function classifyMarketSession(
  date: Date,
  calendar: {
    isTradingDay(d: Date): boolean;
    isHalfDay(d: Date): boolean;
  },
): MarketSession {
  // ET weekday + clock parts
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
  const isWeekend = weekday === "Sat" || weekday === "Sun";

  if (isWeekend) return "closed-weekend";
  if (!calendar.isTradingDay(date)) return "closed-holiday";

  // Hours / minutes in ET
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
  const minutesFromMidnight = hh * 60 + mm;

  const HALF_DAY_CLOSE = 13 * 60; //  1:00 PM ET
  const REGULAR_CLOSE = 16 * 60; //  4:00 PM ET
  const PRE_MARKET_OPEN = 4 * 60; //  4:00 AM ET
  const REGULAR_OPEN = 9 * 60 + 30; // 9:30 AM ET
  const AH_END = 20 * 60; //         8:00 PM ET

  const isHalf = calendar.isHalfDay(date);
  const close = isHalf ? HALF_DAY_CLOSE : REGULAR_CLOSE;

  if (minutesFromMidnight < PRE_MARKET_OPEN) return "closed-overnight";
  if (minutesFromMidnight < REGULAR_OPEN) return "pre-market";
  if (minutesFromMidnight < close) return "regular";
  if (minutesFromMidnight < AH_END) return "after-hours";
  return "closed-overnight";
}

// ---------------------------------------------------------------------------
// Bell Pro briefing — demo path (grounded on spot + ATM + earnings + momentum)
// ---------------------------------------------------------------------------

const BELL_PRO_SYSTEM_PROMPT = `You write the BellMarkets Bell Pro daily ticker briefing — neutral, ground-truthed market intelligence. NOT investment advice.

Strict language rules:
FORBIDDEN: "should", "advise", "recommend", "buy", "sell", "guaranteed", "will rise/fall".
ALLOWED: "factors that may impact", "sensitivities to consider", "historical base rates suggest", "implied probability".

Time + session handling — STRICT:
- The user provides AS_OF in Eastern Time (ET) + a MARKET_SESSION classification + optionally NEXT_SESSION_OPEN_ET.
- Quote dates VERBATIM from the input. Do NOT compute or normalize dates. If AS_OF says "Sunday, May 24, 2026" then it is Sunday May 24 — never write "Sunday May 25" or any other variation.
- Do NOT compute what day-of-week any date is — use only the day-of-week the input provides. If you reference NEXT_SESSION_OPEN_ET, copy the date string from the input; do not infer "Tuesday is May 27" or similar.
- Do NOT mention holidays unless the input explicitly names one — never assume.
- Do NOT use UTC times anywhere. All times in the briefing must be ET.
- Do NOT invent session state ("mid-session", "intraday", "open") — use MARKET_SESSION verbatim or paraphrase consistently with it.
- If MARKET_SESSION is "closed-weekend" / "closed-holiday" / "closed-overnight": frame the briefing as a SETUP for the next trading session, not as live commentary on a moving market.
- If MARKET_SESSION is "pre-market" / "regular" / "after-hours": you may reference the current trading session.

Each briefing is ~150 words. Structure:
- 1-sentence summary anchored to MARKET_SESSION (e.g., "Sunday close → Monday open setup" if weekend; "mid-session at $X" only if MARKET_SESSION is 'regular').
- 3 bullets: factors traders may want to weigh
- 1-sentence forward look (this week or month, factors to monitor)
- Final line, verbatim: "Information only. Not financial advice."

Use ONLY the grounded data the user provides. Do NOT invent prices, dates, sessions, or earnings results not in the input.`;

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
  /** Pre-classified market session — caller computes via classifyMarketSession(). */
  marketSession: MarketSession;
  /** When the next trading session opens (YYYY-MM-DD ET). Anchors closed-session briefings. */
  nextSessionEtDate?: string;
};

// ---------------------------------------------------------------------------
// Per-wallet PNL digest (Category B "highest LTV" per ai-v2-plan §2)
// ---------------------------------------------------------------------------

const PNL_DIGEST_SYSTEM_PROMPT = `You write the BellMarkets PNL digest — a personalized summary of a user's settled trades for a period (typically one trading day).

You are summarizing FACTS the user already paid for. NOT investment advice. NOT a recommendation.

Strict language rules:
FORBIDDEN: "should", "advise", "recommend", "buy", "sell", "would have", "if you had", "next time you should".
ALLOWED: "you won X markets and lost Y", "your net PnL was $Z", "factors that contributed".

Time handling — STRICT:
- All dates in your output must be ET-formatted (e.g., "settled Thu May 21" or "for the week of May 17–24, 2026"), never UTC ISO timestamps.
- The user provides PERIOD as ET dates + each position carries an ET-formatted SETTLED_ET field — use those values verbatim.

Structure (~200 words):
- 1-sentence headline ("You went 4-3 on a $7 net PnL day across META and NVDA.")
- Per-position bullets (2-4 of the most material trades, one bullet each, naming the ticker + outcome + dollar amount + ET settled date)
- 1-sentence behavioral observation (NO advice — just the pattern: "Your win rate was higher on AAPL than on NVDA this period.")
- Final line, verbatim: "Information only. Not financial advice."

Use ONLY the data provided. Do NOT invent positions, prices, or trades not in the input.`;

export type PnlDigestPosition = {
  ticker: string;
  strikeUsd: number;
  outcome: "yes" | "no" | "invalid" | "unsettled";
  /** 'won' | 'lost' | 'invalid' | 'abstained'. */
  result: string;
  /** Amount the user held on the winning side at settle (USDC base units). */
  amountUsdc: number;
  settledAt: Date;
};

export type PnlDigestStats = {
  wonAmountUsdc: number;
  lostAmountUsdc: number;
  netPnlUsdc: number;
  winCount: number;
  lossCount: number;
  invalidCount: number;
  abstainedCount: number;
  totalMarkets: number;
};

export type PnlDigestContext = {
  walletPubkey: string;
  periodStart: Date;
  periodEnd: Date;
  stats: PnlDigestStats;
  positions: ReadonlyArray<PnlDigestPosition>;
};

/**
 * Build the per-wallet PNL digest prompt. Pure function. Embeds the
 * deterministic stats + positions table; Sonnet narrates over the
 * top-N most material positions.
 */
export function buildPnlDigestPrompt(input: PnlDigestContext): AnthropicCallInput {
  const { walletPubkey, periodStart, periodEnd, stats, positions } = input;

  // Truncate wallet for readability (Sonnet doesn't need the full base58)
  const walletShort = walletPubkey.length > 12
    ? `${walletPubkey.slice(0, 4)}...${walletPubkey.slice(-4)}`
    : walletPubkey;

  // Sort by absolute amount desc, take top 8 — enough material for the
  // bullets without bloating input tokens.
  const top = [...positions]
    .sort((a, b) => Math.abs(b.amountUsdc) - Math.abs(a.amountUsdc))
    .slice(0, 8);

  const positionsBlock = top
    .map(
      (p) =>
        `- ${p.ticker} @ $${p.strikeUsd.toFixed(2)} strike, outcome=${p.outcome}, result=${p.result}, amount=$${p.amountUsdc.toFixed(2)} USDC, SETTLED_ET=${formatEtWallClock(p.settledAt)}`,
    )
    .join("\n");

  const userMessage = `WALLET: ${walletShort}
PERIOD_ET: ${formatEtDate(periodStart)} → ${formatEtDate(periodEnd)} (Eastern Time)

DETERMINISTIC STATS:
  won_amount_usdc:   ${stats.wonAmountUsdc.toFixed(2)}
  lost_amount_usdc:  ${stats.lostAmountUsdc.toFixed(2)}
  net_pnl_usdc:      ${stats.netPnlUsdc.toFixed(2)}
  win_count:         ${stats.winCount}
  loss_count:        ${stats.lossCount}
  invalid_count:     ${stats.invalidCount}
  abstained_count:   ${stats.abstainedCount}
  total_markets:     ${stats.totalMarkets}

TOP POSITIONS:
${positionsBlock || "(no positions in this period)"}

Write the ~200-word PNL digest per the rules above. Always close with the disclaimer.`;

  return {
    kind: "pnl-digest",
    model: DEFAULT_BRIEFING_MODEL,
    system: PNL_DIGEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 400,
  };
}

/**
 * Build the Bell Pro briefing prompt. Pure function. Ground-truthed context
 * goes into the user message; system prompt enforces 150-word ceiling +
 * forbidden-word policy + mandatory disclaimer.
 */
export function buildBellProBriefingPrompt(input: BellProBriefingContext): AnthropicCallInput {
  const lines: string[] = [
    `TICKER: ${input.ticker}`,
    `AS_OF: ${formatEtWallClock(input.asOf)}`,
    `MARKET_SESSION: ${input.marketSession}`,
    `SPOT_PRICE_USD: ${input.spotPriceUsd.toFixed(2)}`,
    `ATM_STRIKE_USD: ${input.atmStrikeUsd.toFixed(2)}`,
  ];
  if (input.nextSessionEtDate) {
    // Enrich with day-of-week so Sonnet doesn't need to compute it.
    // Parse the YYYY-MM-DD as a fixed ET noon to avoid TZ-edge ambiguity.
    const [y, m, d] = input.nextSessionEtDate.split("-").map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      const nextDate = new Date(Date.UTC(y!, m! - 1, d!, 16, 0, 0)); // noon ET
      const dow = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(nextDate);
      lines.push(`NEXT_SESSION_OPEN_ET: ${dow} at 9:30 AM ET (date string: ${input.nextSessionEtDate})`);
    } else {
      lines.push(`NEXT_SESSION_OPEN_ET: ${input.nextSessionEtDate} 9:30 AM ET`);
    }
  }
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
    `Write the ~150-word Bell Pro briefing for ${input.ticker} per the rules above. ` +
      `All times in your output must be ET. Frame the briefing consistently with MARKET_SESSION (do not say "mid-session" if the session is closed-weekend or closed-overnight). ` +
      `Do not exceed 200 words. Always end with the disclaimer line.`,
  );
  return {
    kind: "briefing",
    model: DEFAULT_BRIEFING_MODEL,
    system: BELL_PRO_SYSTEM_PROMPT,
    messages: [{ role: "user", content: lines.join("\n") }],
    maxTokens: 320,
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
