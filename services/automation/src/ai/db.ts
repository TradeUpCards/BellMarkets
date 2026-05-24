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
// briefings — daily MAG7 Sonnet briefings (ai-v2-plan §4 phase 0)
// ---------------------------------------------------------------------------

export type BriefingInput = {
  ticker: string;
  model: string;
  body: string;
  promptHash: string;
  requestId?: string;
  costCents?: number;
  context?: Record<string, unknown>;
};

export type BriefingRecord = {
  id: number;
  ticker: string;
  model: string;
  body: string;
  generatedAt: Date;
  promptHash: string;
  requestId: string | undefined;
  costCents: number | undefined;
  context: Record<string, unknown> | undefined;
};

export async function insertBriefing(input: BriefingInput, deps?: AiDbDeps): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO briefings (ticker, model, body, prompt_hash, request_id, cost_cents, context)
    VALUES (
      ${input.ticker}, ${input.model}, ${input.body}, ${input.promptHash},
      ${input.requestId ?? null}, ${input.costCents ?? null},
      ${input.context ? JSON.stringify(input.context) : null}::jsonb
    )
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new Error("insertBriefing: no rows returned");
  return row.id;
}

/**
 * Read the most recent briefing for a ticker. Cleo's GET /api/briefings/:ticker
 * calls this; returns undefined if no briefing has been generated yet
 * (callers can serve a sensible empty state).
 */
export async function getLatestBriefing(
  ticker: string,
  deps?: AiDbDeps,
): Promise<BriefingRecord | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, ticker, model, body, generated_at, prompt_hash, request_id, cost_cents, context
    FROM briefings
    WHERE ticker = ${ticker}
    ORDER BY generated_at DESC
    LIMIT 1
  `) as Array<RawBriefing>;
  return rows[0] ? rowToBriefing(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// pnl_digests — per-wallet PNL digests
// ---------------------------------------------------------------------------

export type PnlDigestInput = {
  walletPubkey: string;
  periodStart: Date;
  periodEnd: Date;
  model: string;
  body: string;
  stats: Record<string, unknown>;
  promptHash: string;
  requestId?: string;
  costCents?: number;
};

export type PnlDigestRecord = {
  id: number;
  walletPubkey: string;
  periodStart: Date;
  periodEnd: Date;
  model: string;
  body: string;
  stats: Record<string, unknown>;
  promptHash: string;
  requestId: string | undefined;
  costCents: number | undefined;
  generatedAt: Date;
};

export async function insertPnlDigest(input: PnlDigestInput, deps?: AiDbDeps): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO pnl_digests (
      wallet_pubkey, period_start, period_end, model, body, stats,
      prompt_hash, request_id, cost_cents
    )
    VALUES (
      ${input.walletPubkey}, ${input.periodStart.toISOString()}, ${input.periodEnd.toISOString()},
      ${input.model}, ${input.body}, ${JSON.stringify(input.stats)}::jsonb,
      ${input.promptHash}, ${input.requestId ?? null}, ${input.costCents ?? null}
    )
    ON CONFLICT (wallet_pubkey, period_start, period_end) DO UPDATE SET
      model = excluded.model,
      body = excluded.body,
      stats = excluded.stats,
      prompt_hash = excluded.prompt_hash,
      request_id = excluded.request_id,
      cost_cents = excluded.cost_cents,
      generated_at = NOW()
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new Error("insertPnlDigest: no rows returned");
  return row.id;
}

export async function getLatestPnlDigest(
  walletPubkey: string,
  deps?: AiDbDeps,
): Promise<PnlDigestRecord | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, wallet_pubkey, period_start, period_end, model, body, stats,
           prompt_hash, request_id, cost_cents, generated_at
    FROM pnl_digests
    WHERE wallet_pubkey = ${walletPubkey}
    ORDER BY generated_at DESC
    LIMIT 1
  `) as Array<RawPnlDigest>;
  return rows[0] ? rowToPnlDigest(rows[0]) : undefined;
}

type RawPnlDigest = {
  id: number;
  wallet_pubkey: string;
  period_start: string;
  period_end: string;
  model: string;
  body: string;
  stats: Record<string, unknown>;
  prompt_hash: string;
  request_id: string | null;
  cost_cents: string | number | null;
  generated_at: string;
};

function rowToPnlDigest(r: RawPnlDigest): PnlDigestRecord {
  return {
    id: r.id,
    walletPubkey: r.wallet_pubkey,
    periodStart: new Date(r.period_start),
    periodEnd: new Date(r.period_end),
    model: r.model,
    body: r.body,
    stats: r.stats,
    promptHash: r.prompt_hash,
    requestId: r.request_id ?? undefined,
    costCents: r.cost_cents !== null && r.cost_cents !== undefined ? Number(r.cost_cents) : undefined,
    generatedAt: new Date(r.generated_at),
  };
}

// ---------------------------------------------------------------------------
// User-positions query — drives PNL digest stats computation
// ---------------------------------------------------------------------------

export type UserPositionInPeriod = {
  marketPubkey: string;
  ticker: string | undefined;
  strikeMicroUsd: number | undefined; // optional — comes from joined StrikeMarket if indexed
  outcome: string;
  result: string;
  yesHeld: string;
  noHeld: string;
  settledAt: Date;
  settlePrice: string | undefined;
};

/**
 * Per-user position rows in a settle window. Joins user_market_holds with
 * settle_events to scope by observed_at. Used by gen-pnl-digest.
 */
export async function listUserPositionsInPeriod(
  walletPubkey: string,
  periodStart: Date,
  periodEnd: Date,
  deps?: AiDbDeps,
): Promise<UserPositionInPeriod[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT
      umh.market_pubkey,
      se.ticker,
      se.outcome,
      umh.result,
      umh.yes_held,
      umh.no_held,
      se.observed_at AS settled_at,
      se.settle_price
    FROM user_market_holds umh
    JOIN settle_events se ON se.id = umh.settle_event_id
    WHERE umh.user_pubkey = ${walletPubkey}
      AND se.observed_at >= ${periodStart.toISOString()}
      AND se.observed_at <  ${periodEnd.toISOString()}
    ORDER BY se.observed_at DESC
  `) as Array<{
    market_pubkey: string;
    ticker: string | null;
    outcome: string;
    result: string;
    yes_held: string;
    no_held: string;
    settled_at: string;
    settle_price: string | null;
  }>;
  return rows.map((r) => ({
    marketPubkey: r.market_pubkey,
    ticker: r.ticker ?? undefined,
    strikeMicroUsd: undefined,
    outcome: r.outcome,
    result: r.result,
    yesHeld: r.yes_held,
    noHeld: r.no_held,
    settledAt: new Date(r.settled_at),
    settlePrice: r.settle_price ?? undefined,
  }));
}

export async function listLatestBriefings(
  tickers: ReadonlyArray<string>,
  deps?: AiDbDeps,
): Promise<BriefingRecord[]> {
  if (tickers.length === 0) return [];
  const sql = clientOf(deps);
  // Per-ticker latest via DISTINCT ON
  const rows = (await sql`
    SELECT DISTINCT ON (ticker)
      id, ticker, model, body, generated_at, prompt_hash, request_id, cost_cents, context
    FROM briefings
    WHERE ticker = ANY(${tickers as unknown as string[]})
    ORDER BY ticker, generated_at DESC
  `) as Array<RawBriefing>;
  return rows.map(rowToBriefing);
}

type RawBriefing = {
  id: number;
  ticker: string;
  model: string;
  body: string;
  generated_at: string;
  prompt_hash: string;
  request_id: string | null;
  cost_cents: string | number | null;
  context: Record<string, unknown> | null;
};

function rowToBriefing(r: RawBriefing): BriefingRecord {
  return {
    id: r.id,
    ticker: r.ticker,
    model: r.model,
    body: r.body,
    generatedAt: new Date(r.generated_at),
    promptHash: r.prompt_hash,
    requestId: r.request_id ?? undefined,
    costCents: r.cost_cents !== null && r.cost_cents !== undefined ? Number(r.cost_cents) : undefined,
    context: r.context ?? undefined,
  };
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
