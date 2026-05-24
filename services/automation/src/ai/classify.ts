// AI v2 — news article classifier. Default model: Claude Haiku 4.5
// (claude-haiku-4-5-20251001) per ai-v2-plan §3 "Stack specifics."
//
// Pipeline:
//   1. Caller passes a `NewsArticle` to `classifyArticle()`.
//   2. Wrapper sends headline + body (truncated) to Haiku with a fixed system
//      prompt enforcing the JSON output schema.
//   3. Parses Haiku's response → upserts `news_classifications`.
//
// Output schema (model is constrained to emit exactly this):
//   {
//     "sentiment": "bullish" | "bearish" | "neutral" | "unclear",
//     "primary_ticker": "<MAG7 ticker | null>",
//     "related_tickers": ["<MAG7 ticker>", ...],
//     "confidence": 0..1,
//     "rationale": "<short summary>"
//   }
//
// Stub-friendly: when ANTHROPIC_API_KEY is unset, callAnthropic returns a
// stub response — we DON'T attempt to parse it as JSON; instead we write
// a synthetic "neutral, 0.0 confidence, model=stub" row.

import { callAnthropic } from "./anthropic-client.js";
import { insertNewsClassification, listUnclassifiedArticles } from "./db.js";
import type {
  AnthropicModelId,
  NewsArticle,
  Sentiment,
} from "./types.js";

export const DEFAULT_CLASSIFIER_MODEL: AnthropicModelId = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a financial news classifier for BellMarkets, a Solana-based binary outcome prediction market on MAG7 stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA).

For each news headline + body, produce a JSON object with exactly these keys:

{
  "sentiment": "bullish" | "bearish" | "neutral" | "unclear",
  "primary_ticker": "<single MAG7 ticker string or null>",
  "related_tickers": ["<additional MAG7 tickers mentioned>"],
  "confidence": <number 0..1, your self-reported confidence>,
  "rationale": "<one-sentence explanation>"
}

Rules:
- Sentiment is about price direction implied by the news for the primary ticker, not editorial tone.
- "neutral" = no clear directional implication. "unclear" = the news may be material but you can't tell direction.
- primary_ticker = the ticker MOST affected. null if the news is macro (FOMC, CPI, broad market).
- related_tickers = OTHER MAG7 tickers mentioned, NOT including primary_ticker.
- confidence = your own confidence in this classification (0.0-1.0).
- Output ONLY the JSON object. No prose, no markdown fences.`;

export type ClassifyArticleResult =
  | { ok: true; classificationId: number; sentiment: Sentiment; primaryTicker: string | undefined; confidence: number; stub: boolean }
  | { ok: false; error: string };

/**
 * Classify a single article via Haiku. Persists the classification row
 * (or a stub row if no API key). Idempotent on (article_id, model).
 *
 * Truncates body to 2048 chars to keep input tokens predictable; Haiku
 * doesn't need full long-form for sentiment classification.
 */
export async function classifyArticle(
  article: NewsArticle,
  options: { model?: AnthropicModelId } = {},
): Promise<ClassifyArticleResult> {
  const model = options.model ?? DEFAULT_CLASSIFIER_MODEL;
  const body = (article.body ?? "").slice(0, 2048);

  const userMessage = `HEADLINE: ${article.headline}\n\nBODY: ${body || "(no body)"}\n\nPUBLISHED: ${article.publishedAt.toISOString()}\nSOURCE: ${article.source}\nKNOWN_TICKER: ${article.ticker ?? "(none)"}`;

  const callResult = await callAnthropic({
    kind: "classify-news",
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 256,
    relatedTicker: article.ticker,
  });

  if (!callResult.ok) {
    return { ok: false, error: callResult.error };
  }

  // Stub mode: write a synthetic neutral row + return
  if (callResult.stub) {
    const id = await insertNewsClassification({
      articleId: article.id,
      model: "stub",
      sentiment: "neutral",
      primaryTicker: article.ticker,
      relatedTickers: [],
      confidence: 0,
      classificationText: callResult.outputText,
    });
    return { ok: true, classificationId: id, sentiment: "neutral", primaryTicker: article.ticker, confidence: 0, stub: true };
  }

  const parsed = parseClassificationJson(callResult.outputText);
  if (!parsed) {
    return { ok: false, error: "Failed to parse classifier JSON output" };
  }

  const id = await insertNewsClassification({
    articleId: article.id,
    model,
    sentiment: parsed.sentiment,
    primaryTicker: parsed.primaryTicker,
    relatedTickers: parsed.relatedTickers,
    confidence: parsed.confidence,
    classificationText: callResult.outputText,
  });

  return {
    ok: true,
    classificationId: id,
    sentiment: parsed.sentiment ?? "unclear",
    primaryTicker: parsed.primaryTicker,
    confidence: parsed.confidence,
    stub: false,
  };
}

/**
 * Drive classification for pending articles. Fetches up to `limit` articles
 * not yet classified by `model`, classifies each, returns summary.
 *
 * Intended to be called by a Trigger.dev cron (not wired yet — per
 * ai-v2-plan §3 the cron belongs to phase 0 v1.5 quick-wins).
 */
export async function classifyPendingArticles(
  options: { model?: AnthropicModelId; limit?: number } = {},
): Promise<{ processed: number; succeeded: number; failed: number; stubbed: number }> {
  const model = options.model ?? DEFAULT_CLASSIFIER_MODEL;
  const articles = await listUnclassifiedArticles(model, options.limit ?? 20);
  let succeeded = 0;
  let failed = 0;
  let stubbed = 0;
  for (const article of articles) {
    const result = await classifyArticle(article, { model });
    if (!result.ok) failed++;
    else if (result.stub) stubbed++;
    else succeeded++;
  }
  return { processed: articles.length, succeeded, failed, stubbed };
}

// ---------------------------------------------------------------------------
// JSON parser — tolerant to leading/trailing whitespace + markdown fences
// ---------------------------------------------------------------------------

type ParsedClassification = {
  sentiment?: Sentiment;
  primaryTicker?: string;
  relatedTickers: string[];
  confidence: number;
};

export function parseClassificationJson(raw: string): ParsedClassification | undefined {
  if (!raw) return undefined;
  let text = raw.trim();
  // Strip markdown fences if present (model sometimes ignores "no fences" instruction)
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  const sentimentRaw = typeof o.sentiment === "string" ? o.sentiment.toLowerCase() : undefined;
  const sentiment: Sentiment | undefined =
    sentimentRaw === "bullish" || sentimentRaw === "bearish" || sentimentRaw === "neutral" || sentimentRaw === "unclear"
      ? sentimentRaw
      : undefined;
  const primaryTicker =
    typeof o.primary_ticker === "string" && o.primary_ticker !== "null" ? o.primary_ticker : undefined;
  const relatedTickers = Array.isArray(o.related_tickers)
    ? o.related_tickers.filter((t): t is string => typeof t === "string")
    : [];
  const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0;
  return { sentiment, primaryTicker, relatedTickers, confidence };
}
