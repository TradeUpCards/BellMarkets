// AI v2 phase-0/1 types. Mirrors db/migrations/0003_ai_v2_news_ingestion.sql.

// Reuse the canonical Ticker type from services/automation/src/types.ts;
// don't redeclare it here (would conflict with index.ts barrel re-export).
import type { Ticker } from "../types.js";
export type { Ticker };

export type Sentiment = "bullish" | "bearish" | "neutral" | "unclear";

export type NewsSource = "benzinga" | "ap" | "rss-marketwatch" | "rss-seekingalpha" | "manual" | string;

export type NewsArticleInput = {
  source: NewsSource;
  externalId?: string;
  ticker?: Ticker | string;
  headline: string;
  body?: string;
  url?: string;
  publishedAt: Date;
};

export type NewsArticle = NewsArticleInput & {
  id: number;
  observedAt: Date;
};

export type NewsClassification = {
  id: number;
  articleId: number;
  model: string;
  sentiment: Sentiment | undefined;
  primaryTicker: string | undefined;
  relatedTickers: string[];
  confidence: number | undefined;
  classificationText: string | undefined;
  classifiedAt: Date;
};

export type AnthropicModelId =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-4-6"
  | "claude-opus-4-7"
  | string;

export type AiOutputKind =
  | "briefing"
  | "pnl-digest"
  | "classify-news"
  | "chat"
  | "earnings-deep-dive"
  | string;

export type AiOutputLogInput = {
  kind: AiOutputKind;
  model: AnthropicModelId;
  promptHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costCents?: number;
  outputText?: string;
  userId?: string;
  relatedTicker?: Ticker | string;
  requestId?: string;
};
