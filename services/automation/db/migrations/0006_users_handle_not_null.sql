-- DR-014 follow-up — make users.handle NOT NULL (auto-username flow, fanalytics
-- pattern coordinated with Cleo per cleo-handoff.md "For Bram — RAISE: fanalytics
-- auto-username flow").
--
-- Cleo's frontend assigns an auto-gen handle (adjective × noun × 0-999) at
-- wallet-connect time, so every user has a handle before they ever do OAuth.
-- Bram's handleSignIn checks isRandomUsername() on the existing handle and
-- overwrites it with the OAuth display name on first OAuth link. This
-- migration enforces the NOT NULL contract that the auto-username flow assumes.
--
-- Backfill strategy:
--   For any existing rows where handle IS NULL, generate a deterministic
--   handle matching the fanalytics regex (Adj × Noun × 0-999). The pattern
--   matches isRandomUsername(), so a future OAuth sign-in will naturally
--   overwrite the backfilled value with the user's chosen display name.
--
-- Uniqueness risk:
--   The regex space is 10 × 10 × 1000 = 100,000 distinct strings. Each
--   wallet's hash buckets are derived independently. With < 100 backfilled
--   users (devnet reality), collision probability is < 0.05. If a UNIQUE
--   violation triggers, the migration fails visibly — operator can either
--   rerun with a different hash salt or hand-patch the colliding rows.
--
-- Applied via Neon MCP against project shiny-pine-17310146 (bell-markets-indexer).

-- ─── Step 1: backfill NULL handles with fanalytics-pattern auto-gen ──────
-- Hash buckets are seeded with different per-field salts so adj/noun/num
-- aren't correlated. abs() handles PostgreSQL hashtext's signed-int return.
UPDATE users
SET handle = (
    (ARRAY['Brave','Clever','Dazzling','Eager','Fierce','Gentle','Happy','Jolly','Kind','Lively'])
      [1 + (abs(hashtext(wallet_pubkey || ':adj'))::int % 10)]
  ||
    (ARRAY['Fox','Wolf','Bear','Eagle','Owl','Lion','Tiger','Panda','Koala','Dolphin'])
      [1 + (abs(hashtext(wallet_pubkey || ':noun'))::int % 10)]
  ||
    (abs(hashtext(wallet_pubkey || ':num'))::int % 1000)::text
  ),
    updated_at = NOW()
WHERE handle IS NULL;

-- ─── Step 2: enforce NOT NULL ────────────────────────────────────────────
ALTER TABLE users ALTER COLUMN handle SET NOT NULL;

-- ─── Step 3: drop the partial WHERE clause on the handle index ───────────
-- Pre-migration: index had `WHERE handle IS NOT NULL` because handle was
-- nullable. Post-migration handle is always non-null, so the WHERE clause
-- excludes nothing — drop + recreate as a plain index for clarity.
DROP INDEX IF EXISTS idx_users_handle;
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
