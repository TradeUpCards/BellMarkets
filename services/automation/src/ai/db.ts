// AI v2 Neon queries — news_articles / news_classifications / ai_outputs.
// Same dep-injection pattern as services/automation/src/db/queries.ts +
// services/automation/src/auth/db.ts.

import { getSqlClient } from "../db/client.js";
import type { SqlClient } from "../db/client.js";
import type {
  AiOutputLogInput,
  NewsArticle,
  NewsArticleInput,
  NewsClassification,
  Sentiment,
} from "./types.js";

export type AiDbDeps = { sql?: SqlClient };

function clientOf(deps?: AiDbDeps): SqlClient {
  return deps?.sql ?? getSqlClient();
}

// ---------------------------------------------------------------------------
// news_articles
// ---------------------------------------------------------------------------

export async function insertNewsArticle(
  input: NewsArticleInput,
  deps?: AiDbDeps,
): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO news_articles (source, external_id, ticker, headline, body, url, published_at)
    VALUES (
      ${input.source}, ${input.externalId ?? null}, ${input.ticker ?? null},
      ${input.headline}, ${input.body ?? null}, ${input.url ?? null},
      ${input.publishedAt.toISOString()}
    )
    ON CONFLICT (source, external_id) DO UPDATE SET
      headline = EXCLUDED.headline,
      body = EXCLUDED.body,
      ticker = COALESCE(EXCLUDED.ticker, news_articles.ticker)
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new Error("insertNewsArticle: no rows returned");
  return row.id;
}

/** Articles pending classification by a given model. */
export async function listUnclassifiedArticles(
  model: string,
  limit = 100,
  deps?: AiDbDeps,
): Promise<NewsArticle[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT na.id, na.source, na.external_id, na.ticker, na.headline,
           na.body, na.url, na.published_at, na.observed_at
    FROM news_articles na
    LEFT JOIN news_classifications nc
      ON nc.article_id = na.id AND nc.model = ${model}
    WHERE nc.id IS NULL
    ORDER BY na.published_at DESC
    LIMIT ${limit}
  `) as Array<RawNewsArticle>;
  return rows.map(rowToNewsArticle);
}

// ---------------------------------------------------------------------------
// news_classifications
// ---------------------------------------------------------------------------

export type ClassificationInput = {
  articleId: number;
  model: string;
  sentiment?: Sentiment;
  primaryTicker?: string;
  relatedTickers?: string[];
  confidence?: number;
  classificationText?: string;
};

export async function insertNewsClassification(
  input: ClassificationInput,
  deps?: AiDbDeps,
): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO news_classifications (
      article_id, model, sentiment, primary_ticker,
      related_tickers, confidence, classification_text
    )
    VALUES (
      ${input.articleId}, ${input.model}, ${input.sentiment ?? null},
      ${input.primaryTicker ?? null}, ${input.relatedTickers ?? null},
      ${input.confidence ?? null}, ${input.classificationText ?? null}
    )
    ON CONFLICT (article_id, model) DO UPDATE SET
      sentiment = EXCLUDED.sentiment,
      primary_ticker = EXCLUDED.primary_ticker,
      related_tickers = EXCLUDED.related_tickers,
      confidence = EXCLUDED.confidence,
      classification_text = EXCLUDED.classification_text,
      classified_at = NOW()
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new Error("insertNewsClassification: no rows returned");
  return row.id;
}

// ---------------------------------------------------------------------------
// ai_outputs (audit log of every Anthropic call)
// ---------------------------------------------------------------------------

export async function logAiOutput(input: AiOutputLogInput, deps?: AiDbDeps): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO ai_outputs (
      kind, model, prompt_hash, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, cost_cents, output_text,
      user_id, related_ticker, request_id
    )
    VALUES (
      ${input.kind}, ${input.model}, ${input.promptHash},
      ${input.inputTokens}, ${input.outputTokens},
      ${input.cacheReadTokens ?? 0}, ${input.cacheCreationTokens ?? 0},
      ${input.costCents ?? null}, ${input.outputText ?? null},
      ${input.userId ?? null}, ${input.relatedTicker ?? null},
      ${input.requestId ?? null}
    )
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new Error("logAiOutput: no rows returned");
  return row.id;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

type RawNewsArticle = {
  id: number;
  source: string;
  external_id: string | null;
  ticker: string | null;
  headline: string;
  body: string | null;
  url: string | null;
  published_at: string;
  observed_at: string;
};

function rowToNewsArticle(r: RawNewsArticle): NewsArticle {
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id ?? undefined,
    ticker: r.ticker ?? undefined,
    headline: r.headline,
    body: r.body ?? undefined,
    url: r.url ?? undefined,
    publishedAt: new Date(r.published_at),
    observedAt: new Date(r.observed_at),
  };
}

// Re-export NewsClassification mapper for symmetry / future use.
// (Not currently called by any production path, but listed for clarity.)
export type _NewsClassificationRow = {
  id: number;
  article_id: number;
  model: string;
  sentiment: Sentiment | null;
  primary_ticker: string | null;
  related_tickers: string[] | null;
  confidence: number | null;
  classification_text: string | null;
  classified_at: string;
};

export function rowToNewsClassification(r: _NewsClassificationRow): NewsClassification {
  return {
    id: r.id,
    articleId: r.article_id,
    model: r.model,
    sentiment: r.sentiment ?? undefined,
    primaryTicker: r.primary_ticker ?? undefined,
    relatedTickers: r.related_tickers ?? [],
    confidence: r.confidence ?? undefined,
    classificationText: r.classification_text ?? undefined,
    classifiedAt: new Date(r.classified_at),
  };
}
