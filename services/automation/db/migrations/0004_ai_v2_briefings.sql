-- AI v2 phase-0 — daily ticker briefings table.
-- Per .project/.../ai-v2-plan.md §4 phase 0: "Daily MAG7 briefing
-- (shared cache, 7 briefings/day, generated 5 AM ET pre-market)".
--
-- Stores the Sonnet 4.6 output verbatim. Cleo's GET /api/briefings/:ticker
-- reads the most recent row per ticker.
--
-- Schema:
--   - ticker: MAG7 ticker (e.g. "META")
--   - model: which model generated this (Sonnet 4.6 / Opus / stub)
--   - body: the briefing text (~150-400 words)
--   - generated_at: when the cron / operator script ran
--   - prompt_hash: SHA-256 of the prompt for cache-hit analysis
--   - request_id: Anthropic's response.id for traceability
--   - cost_cents: cost of this generation (drives the cost dashboard)
--   - context: JSONB snapshot of the grounded context (spot price + earnings
--     date + ATM strike + momentum) used at generation time — lets us
--     reproduce the briefing later if the underlying corpus drifts.
--
-- UNIQUE (ticker, generated_at) — multiple briefings per day are OK
-- (e.g. one at 5 AM, one mid-session); Cleo's endpoint reads ORDER BY
-- generated_at DESC LIMIT 1 to serve the freshest.
--
-- ADDITIVE over migrations 0001, 0002, 0003. No existing tables altered.

CREATE TABLE IF NOT EXISTS briefings (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  model TEXT NOT NULL,
  body TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prompt_hash TEXT NOT NULL,
  request_id TEXT,
  cost_cents NUMERIC,
  context JSONB,
  UNIQUE (ticker, generated_at)
);
CREATE INDEX IF NOT EXISTS idx_briefings_ticker_latest ON briefings(ticker, generated_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0004_ai_v2_briefings')
  ON CONFLICT DO NOTHING;
