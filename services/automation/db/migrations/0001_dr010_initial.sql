-- DR-010 win-streak indexer — initial schema.
--
-- Applied once via Neon MCP (or any psql client) against the bell-markets-indexer
-- Neon project. The `schema_migrations` table tracks which migrations have
-- been applied; subsequent migrations append rows on apply.
--
-- This schema is the off-chain mirror of public on-chain settle events.
-- It is NOT a source of truth — anyone can rebuild it by replaying public
-- `settle_market` txs from Solana history. Storing here only for query speed
-- + Merkle leaderboard construction (DR-010 Option B trust model).

-- Append-only log of observed settle_market events. The `tx_sig` UNIQUE
-- constraint guarantees idempotency under Helius webhook retries.
CREATE TABLE IF NOT EXISTS settle_events (
  id BIGSERIAL PRIMARY KEY,
  market_pubkey TEXT NOT NULL,
  ticker TEXT,
  expiry_unix BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no', 'invalid', 'unsettled')),
  settle_price NUMERIC,
  settle_slot BIGINT,
  tx_sig TEXT NOT NULL UNIQUE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settle_events_market ON settle_events(market_pubkey);
CREATE INDEX IF NOT EXISTS idx_settle_events_expiry ON settle_events(expiry_unix);

-- Per-user position at settle time. One row per (settle_event, user) pair.
-- "result" denormalizes the win/loss based on user's held side vs outcome.
CREATE TABLE IF NOT EXISTS user_market_holds (
  id BIGSERIAL PRIMARY KEY,
  settle_event_id BIGINT NOT NULL REFERENCES settle_events(id) ON DELETE CASCADE,
  user_pubkey TEXT NOT NULL,
  market_pubkey TEXT NOT NULL,
  yes_held NUMERIC NOT NULL DEFAULT 0,
  no_held NUMERIC NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('won', 'lost', 'abstained', 'invalid')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (settle_event_id, user_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_user_holds_user ON user_market_holds(user_pubkey);
CREATE INDEX IF NOT EXISTS idx_user_holds_result ON user_market_holds(result);

-- Running per-user streak state. Updated after every observed settle event.
-- DR-010 streak semantics:
--   win = user_won on ANY market in this settle session → current_streak++
--   loss = user_lost on ANY market in this settle session → current_streak = 0
--   abstain = no position → current_streak unchanged
CREATE TABLE IF NOT EXISTS user_streaks (
  user_pubkey TEXT PRIMARY KEY,
  current_streak INT NOT NULL DEFAULT 0,
  longest_streak INT NOT NULL DEFAULT 0,
  total_markets_won INT NOT NULL DEFAULT 0,
  total_markets_traded INT NOT NULL DEFAULT 0,
  last_result TEXT,
  last_settle_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_streaks_current
  ON user_streaks(current_streak DESC, total_markets_traded DESC);

-- One row per closed leaderboard period (weekly Fri / monthly last-Fri).
-- merkle_root + arweave_tx_id + committed_tx_sig populate once the
-- distribute_*_rewards cron finishes its commit + Arweave upload steps.
-- full_leaderboard_json holds every user with current_streak > 0 at period
-- end, ranked.
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id BIGSERIAL PRIMARY KEY,
  period_kind TEXT NOT NULL CHECK (period_kind IN ('weekly', 'monthly')),
  period_id INT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  merkle_root TEXT,
  arweave_tx_id TEXT,
  committed_tx_sig TEXT,
  participants_count INT NOT NULL DEFAULT 0,
  full_leaderboard_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_kind, period_id)
);

-- One row per position 1..10 per snapshot. user_pubkey is NULL for "rollover"
-- positions (when fewer than 10 unique participants existed).
CREATE TABLE IF NOT EXISTS distributions (
  id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES leaderboard_snapshots(id) ON DELETE CASCADE,
  position INT NOT NULL CHECK (position >= 1 AND position <= 10),
  user_pubkey TEXT,
  amount_usdc NUMERIC NOT NULL,
  tx_sig TEXT,
  merkle_proof JSONB,
  distributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_id, position)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations(version) VALUES ('0001_dr010_initial')
  ON CONFLICT DO NOTHING;
