-- AI v2 phase-0 — per-wallet PNL digest table.
-- Per .project/.../ai-v2-plan.md §2 Category B: "PNL digest (daily after
-- settle, per-user)". Sonnet 4.6 narrates 1-3 sentences per significant
-- position; aggregate stats stay deterministic (SQL).
--
-- Pattern:
--   1. Trigger.dev cron (DEFERRED — v1.5) fires after 4 PM ET settle.
--   2. For each user with at least one settle this period:
--      - Compute deterministic stats from user_market_holds (won_amount,
--        lost_amount, net_pnl, win_count, loss_count)
--      - Call Sonnet with prompt that embeds the stats + position table
--      - Persist (wallet_pubkey, period_start, period_end, body,
--        stats JSONB) here
--   3. Cleo's GET /api/pnl-digest/:wallet reads the most recent row.
--
-- For v1 demo: operator script `gen-pnl-digest <wallet>` runs the same
-- pipeline for one wallet manually.

CREATE TABLE IF NOT EXISTS pnl_digests (
  id BIGSERIAL PRIMARY KEY,
  wallet_pubkey TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  body TEXT NOT NULL,
  /** Deterministic stats embedded for reproducibility. JSON shape:
   *  { won_amount, lost_amount, net_pnl, win_count, loss_count,
   *    invalid_count, abstained_count, total_markets, positions: [...] } */
  stats JSONB NOT NULL,
  prompt_hash TEXT NOT NULL,
  request_id TEXT,
  cost_cents NUMERIC,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_pubkey, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_pnl_digests_wallet_recent
  ON pnl_digests(wallet_pubkey, generated_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0005_ai_v2_pnl_digests')
  ON CONFLICT DO NOTHING;
