-- AI v2 phase-0/1 prep — news ingestion + AI output audit log.
-- Per .project/bell-markets/coordination/ai-v2-plan.md §3.
--
-- DATA PLUMBING ONLY. No cron wiring yet. The intended use:
--   1. Helius-style webhook receiver (or scheduled poller) inserts raw
--      news articles into `news_articles`.
--   2. Haiku classifier (services/automation/src/ai/classify.ts) reads
--      pending articles, classifies sentiment + primary ticker, writes
--      `news_classifications` row.
--   3. Sonnet briefing cron (deferred — not in this migration's scope)
--      will eventually consume both tables + write to `ai_outputs`.
--   4. Anthropic-API-call audit (every call goes into `ai_outputs` with
--      token counts + model + cost-estimate cents) — cost observability
--      from day 1 per ai-v2-plan §3 "Cost projection."
--
-- ADDITIVE over DR-010 + DR-014 schemas. No existing tables altered.

CREATE TABLE IF NOT EXISTS news_articles (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,                  -- 'benzinga' | 'ap' | 'rss-marketwatch' | etc.
  external_id TEXT,                      -- provider's article ID (for dedupe)
  ticker TEXT,                           -- nullable; macro news has no single ticker
  headline TEXT NOT NULL,
  body TEXT,
  url TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_news_ticker_pub ON news_articles(ticker, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_source_pub ON news_articles(source, published_at DESC);

CREATE TABLE IF NOT EXISTS news_classifications (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES news_articles(id) ON DELETE CASCADE,
  model TEXT NOT NULL,                   -- e.g. 'claude-haiku-4-5-20251001'
  sentiment TEXT CHECK (sentiment IN ('bullish', 'bearish', 'neutral', 'unclear')),
  primary_ticker TEXT,
  related_tickers TEXT[],                -- additional MAG7 the article references
  confidence NUMERIC,                    -- 0..1, model's self-reported confidence
  classification_text TEXT,              -- raw model output for audit
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (article_id, model)             -- one classification per (article, model)
);
CREATE INDEX IF NOT EXISTS idx_classifications_ticker ON news_classifications(primary_ticker);

-- Append-only audit log of every Anthropic API call. Drives the cost
-- dashboard + lets us reproduce/replay any AI output. Stores the actual
-- response text (which may include PII if a user prompt leaks one — but
-- prompt-side scrubbing happens before the call by design, see
-- ai-v2-plan §5).
CREATE TABLE IF NOT EXISTS ai_outputs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                    -- 'briefing' | 'pnl-digest' | 'classify-news' | 'chat' | etc.
  model TEXT NOT NULL,                   -- model id used
  prompt_hash TEXT NOT NULL,             -- sha256 of (system + user + tool defs); for cache hit-rate analysis
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  cache_read_tokens INT NOT NULL DEFAULT 0,
  cache_creation_tokens INT NOT NULL DEFAULT 0,
  cost_cents NUMERIC,                    -- pre-batch-discount cost estimate (cents)
  output_text TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,   -- nullable: shared-cache outputs have no user
  related_ticker TEXT,
  request_id TEXT,                       -- Anthropic's response.id for traceability
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_outputs_kind_created ON ai_outputs(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_outputs_user ON ai_outputs(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_outputs_request ON ai_outputs(request_id) WHERE request_id IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('0003_ai_v2_news_ingestion')
  ON CONFLICT DO NOTHING;
