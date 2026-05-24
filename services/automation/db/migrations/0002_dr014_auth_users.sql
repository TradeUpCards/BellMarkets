-- DR-014 — user profiles + social linking + notification channels.
--
-- ADDITIVE migration over the DR-010 schema (0001_dr010_initial.sql). Adds
-- four new tables behind the existing distributions / leaderboard_snapshots /
-- settle_events / user_market_holds / user_streaks tables. None of those
-- existing tables are altered.
--
-- DR-014 §1 notes wallet_pubkey is canonical identity; email becomes mandatory
-- only when DR-013 (embedded wallets) ships. At MVP the column is NULLable
-- with app-layer enforcement at the embedded-wallet entry point.
--
-- DR-014 §3 capture-opportunistically: OAuth providers may surface email +
-- avatar — store both. No post-verify required.
--
-- Reference impl: /c/Dev/fffanalytics_t3 — denormalized (handles/IDs all in
-- one users table). This schema is normalized (separate oauth_accounts table)
-- per DR-014 §5; cleaner ON DELETE cascade + future-friendly to additional
-- providers (Telegram, GitHub).
--
-- Applied via Neon MCP against project shiny-pine-17310146 (bell-markets-indexer).

-- ─── users ────────────────────────────────────────────────────────────────
-- Wallet pubkey is canonical. Email optional at v1, mandatory in DR-013.
-- Handle is the user-chosen display name (unique). SNS = Solana Name Service
-- `.sol` domain captured from a public RPC lookup at user-profile-create time.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_pubkey TEXT NOT NULL UNIQUE,
  email TEXT,
  handle TEXT UNIQUE,
  avatar_url TEXT,
  sns_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_pubkey);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle) WHERE handle IS NOT NULL;

-- ─── oauth_accounts ───────────────────────────────────────────────────────
-- One row per (provider, user) link. Provider's `id` from the OAuth profile
-- is `provider_user_id` (NOT a Bell Markets UUID — the external provider's
-- own user identifier so we can de-duplicate "same X account" across wallet
-- pubkey changes).
-- refresh_token stored plaintext for MVP; encryption at rest is Neon's job
-- (TDE on managed Postgres). Production should wrap with libsodium sealedbox
-- or KMS-managed envelope; tracked as a P2 follow-up not blocking demo.
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('twitter', 'discord', 'google')),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  username TEXT,
  avatar_url TEXT,
  refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_accounts(provider);

-- ─── notification_prefs ───────────────────────────────────────────────────
-- Per-user channel toggles. Default OFF for every channel — opt-in only,
-- as DR-014 §4 specifies. Profile-creation defaults can flip individual
-- toggles based on which channels the user just linked.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_transactional_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  email_newsletter_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  discord_dm_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── push_subscriptions ──────────────────────────────────────────────────
-- One row per active browser push subscription (user can have multiple
-- devices). Status enum lets us mark stale endpoints from web-push failure
-- callbacks without immediately deleting (audit + retry semantics).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  ua_string TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_user_active ON push_subscriptions(user_id) WHERE status = 'active';

-- ─── notifications_sent ──────────────────────────────────────────────────
-- Append-only audit log of notifications dispatched. Useful for:
--   - Dedup (skip duplicate sends within X minutes)
--   - Retry logic (failed sends mark retry_count, last_error)
--   - Debug/compliance (when did this user receive X?)
CREATE TABLE IF NOT EXISTS notifications_sent (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'discord', 'push', 'telegram')),
  kind TEXT NOT NULL,    -- e.g. 'settle', 'leaderboard_won', 'newsletter'
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'retrying')),
  last_error TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user_kind ON notifications_sent(user_id, kind, sent_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0002_dr014_auth_users')
  ON CONFLICT DO NOTHING;
