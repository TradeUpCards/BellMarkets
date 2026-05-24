# DR-014 Test Plan — User Profiles + Social Linking + Notification Channels

**Spec status:** Drew Day-5 (2026-05-23). Tests are NOT YET written — Bram's NextAuth + Neon schema isn't landed. This is a checklist Bram + Drew can pull from once that scaffolding exists.

**Path note:** Placed at `tests/contracts/` per Tate's dispatch P3 even though semantically DR-014 isn't Anchor-contract code (it's NextAuth + Neon + Discord.js + nodemailer + web-push). Drew owns the SPEC; Bram owns the eventual test IMPLEMENTATION once his code lands. May relocate to `tests/automation/` after Bram's first commit if that's the natural home.

**Source DR:** `constitution/decisions.md` DR-014. Reference impl Cory cited: `fffanalytics_t3` repo (NextAuth v4 + Neon Postgres + Discord.js v14 + nodemailer + web-push patterns).

---

## Scope of this spec

What this document covers:
- OAuth happy + failure paths (Twitter / Discord / Google)
- Push subscription register + revoke
- Notification preference toggles + persistence
- Discord DM delivery success + fallback
- Email transactional delivery

What this document does NOT cover (out of DR-014 scope):
- Embedded-wallet email mandatory enforcement — that's DR-013, separate test plan
- Share-card generator (`@vercel/og` PNG output) — separate visual/snapshot test
- `$BELL` token integration — deferred per AI v2 plan §6
- Multi-metric leaderboard (DR-015) — separate test plan
- ENS resolution — nice-to-have, not load-bearing

---

## Test infrastructure assumptions

When Bram lands the NextAuth + Neon stack, the assumed test surface:

| Layer | Tool | Where tests live |
|---|---|---|
| Unit (auth callbacks, push helpers) | vitest (matches Bram's existing service pattern) | `services/automation/__tests__/` OR `apps/web/__tests__/` depending on Cleo+Bram split |
| Integration (NextAuth callback + Neon write) | vitest + Neon branch DB OR in-process pg-mem | `tests/automation/auth.test.ts` (or wherever Bram lands his auth code) |
| Browser-side push (Service Worker registration) | Playwright OR @testing-library/react with mocked PushManager | `tests/frontend/notification-ui.test.ts` |
| Discord DM delivery (Discord.js bot interactions) | discord-bot mocked at the `client.users.fetch(...).send(...)` boundary; live integration smoke against a test Discord guild on demand only | `tests/automation/discord-dm.test.ts` |
| Email delivery (nodemailer SMTP) | nodemailer's `createTransport({ jsonTransport: true })` for unit, real Ethereal SMTP smoke on demand | `tests/automation/email.test.ts` |

**Required test deps Bram should add when he lands the package:**
- `next-auth` (Bram production dep already)
- `@auth/prisma-adapter` OR `@auth/drizzle-adapter` (whichever Bram chooses)
- `pg` + Neon connection helper (production dep)
- `vitest` (already at 76 tests in services/automation)
- `discord.js` (production dep)
- `nodemailer` (production dep)
- `web-push` (production dep)

---

## Test checklist (~50 cases total)

### 1. OAuth — Twitter (X) provider

**Happy paths:**
- [ ] **T-1.1** Fresh user clicks "Sign in with Twitter" → NextAuth redirects to X OAuth consent → user authorizes → callback creates `users` row in Neon with provider=twitter, email populated if returned, twitter_handle populated. Profile row exists immediately.
- [ ] **T-1.2** Returning user (twitter_id already in `accounts` table) → callback skips user creation, refreshes session, redirects to where they came from.
- [ ] **T-1.3** User who originally signed in via wallet links Twitter as second method → `accounts` table gets second row with twitter_id, user's primary email NOT overwritten unless explicitly opted in via Profile UI.

**Failure modes:**
- [ ] **T-1.4** User revokes Twitter access mid-OAuth (clicks "Cancel" on X consent screen) → callback returns error, user redirected to /signin?error=AccessDenied; no Neon writes.
- [ ] **T-1.5** Twitter token revoked AFTER initial sign-in (user removed app from X's connected apps) → next session refresh fails with 401 from Twitter API → server gracefully drops the twitter link (or marks `accounts.twitter_id` revoked); user sees "Twitter disconnected, reconnect to re-enable [X feature]" prompt.
- [ ] **T-1.6** Twitter API rate-limited (429 from X) during the OAuth callback → NextAuth surfaces a retriable error; UI shows "Twitter is busy, try again in a minute" not a stack trace.
- [ ] **T-1.7** Twitter account already linked to ANOTHER user's profile in Neon (`accounts.twitter_id` unique constraint violation) → reject the new link with a clear "this Twitter account is already linked to a different BellMarkets profile" message; no orphaned partial-state in `accounts`.
- [ ] **T-1.8** Twitter returns no email field (some users have private emails) → `users.email` stays null; profile is still created; share-cards still work via twitter_handle.

### 2. OAuth — Discord provider

Same pattern as Twitter; test cases mirror T-1.* with discord-specific assertions:
- [ ] **T-2.1** Happy path: fresh Discord sign-in creates profile + populates discord_id + discord_username + discord_avatar_url
- [ ] **T-2.2** Returning Discord user → session refresh, no new user row
- [ ] **T-2.3** Linking Discord as second method on a wallet-primary user
- [ ] **T-2.4** User cancels Discord OAuth → AccessDenied error path
- [ ] **T-2.5** Discord token revoked → graceful link-drop + reconnect prompt
- [ ] **T-2.6** Discord API rate-limited → retriable error UI
- [ ] **T-2.7** Discord account already linked elsewhere → unique-violation reject
- [ ] **T-2.8** **Discord-specific:** user is NOT a member of BellMarkets official Discord guild → store discord_id but mark `notification_prefs.discord_dm_enabled = false` with a "join the BellMarkets Discord to receive DMs" CTA. Discord DMs only work if user shares a server with the bot.

### 3. OAuth — Google provider

Same pattern as Twitter/Discord:
- [ ] **T-3.1** Happy path: fresh Google sign-in creates profile + populates google_id + google_email (always present for Google) + google_avatar_url
- [ ] **T-3.2** Returning Google user
- [ ] **T-3.3** Linking Google as second method
- [ ] **T-3.4** User cancels Google OAuth
- [ ] **T-3.5** Google token revoked
- [ ] **T-3.6** Google API rate-limited (very rare; Google's OAuth has generous quotas)
- [ ] **T-3.7** Google account already linked elsewhere

### 4. Profile creation gate

Per DR-014: "Profile creation is gated behind reward-claim (high-intent moment). Don't surface email-capture during pre-trade browsing."

- [ ] **T-4.1** Anonymous wallet visits markets page → NO profile-creation prompt. NextAuth session has wallet-pubkey only; no `users` row in Neon.
- [ ] **T-4.2** Wallet places a winning trade + settles + clicks "Redeem" → reward-claim flow surfaces "Add email to get a receipt + leaderboard notifications" prompt. Profile creation now offered.
- [ ] **T-4.3** User declines the email-add prompt → trade redeem still succeeds; user still has wallet-only identity; no degraded UX.
- [ ] **T-4.4** User accepts → OAuth flow runs as above + Neon `users` row created with wallet_pubkey + (twitter|discord|google)_id + opt-in newsletter flag.

### 5. Push subscription lifecycle

`web-push` API — Cleo's frontend service worker subscribes; Bram's backend stores the subscription + sends pushes.

**Registration:**
- [ ] **T-5.1** User clicks "Enable browser notifications" in profile UI → browser prompts for Permission → user grants → service worker calls `pushManager.subscribe()` with VAPID public key → frontend POSTs subscription JSON to `/api/push/subscribe` → Neon `push_subscriptions` row inserted (user_id, endpoint, p256dh, auth keys).
- [ ] **T-5.2** Same subscription re-POSTed (idempotency on endpoint) → upsert; no duplicate rows.
- [ ] **T-5.3** User on browser that doesn't support web-push (Safari before iOS 16.4) → UI shows "browser notifications unsupported; enable email or Discord DM instead". No subscribe attempt.
- [ ] **T-5.4** User denies permission → UI gracefully accepts; no Neon write; "you can enable notifications later in settings".

**Delivery:**
- [ ] **T-5.5** Settlement event for user with active push subscription → server-side push call delivers "Your AAPL $200 position settled YES. +$50 USDC." → service worker shows browser notification.
- [ ] **T-5.6** Push delivery returns 410 Gone (subscription expired/revoked browser-side) → server deletes that `push_subscriptions` row. Re-sub required by user.
- [ ] **T-5.7** Push delivery returns 5xx (FCM/APNS transient) → backoff + retry within a 5-min window; if still failing, mark subscription as flaky in Neon + alert.
- [ ] **T-5.8** Push notification respects `notification_prefs.settle_push_enabled` — if user disabled push for settlements, no push fires even though subscription exists.

**Revocation:**
- [ ] **T-5.9** User clicks "Disable browser notifications" in profile → frontend service worker calls `subscription.unsubscribe()` + POSTs `/api/push/unsubscribe` → Neon row deleted.
- [ ] **T-5.10** User uninstalls service worker (clears site data) → next server push gets 410; subscription deleted on next attempt. **Cleanup eventual, not synchronous.**

### 6. Notification preferences

Per DR-014: granular opt-in per channel. Neon table `notification_prefs` per user with boolean columns per (channel, event-type) combination.

**Persistence:**
- [ ] **T-6.1** User toggles `email_settle_notifications = true` → POST persists to Neon → next session GET returns the new value → notification firing checks the value at send time, not session-cache time.
- [ ] **T-6.2** Toggle survives page reload + browser restart (Neon-backed, not localStorage).
- [ ] **T-6.3** Toggle survives Bram's automation service restart (preference IS the Neon row).

**Per-channel toggles:**
- [ ] **T-6.4** `email_settle_notifications` toggle independent of `email_newsletter` toggle — turning off newsletter doesn't suppress transactional settles.
- [ ] **T-6.5** `discord_dm_settle_notifications` only available if user has linked Discord AND is in the BellMarkets guild.
- [ ] **T-6.6** `push_settle_notifications` only available if user has active push subscription.
- [ ] **T-6.7** All-off state: user can disable ALL notifications. Settlements still happen on chain; user just doesn't get notified. No error, no nag.

**Defaults:**
- [ ] **T-6.8** New profile defaults: email_settle = true (high-value events), email_newsletter = false (opt-in only, per CAN-SPAM compliance), push_settle = true if push subscription exists, discord_dm = true if linked-and-in-guild.

### 7. Discord DM delivery

Discord.js v14 bot pattern from `fffanalytics_t3`. Bot must share a guild with the user to DM them.

**Happy path:**
- [ ] **T-7.1** User has Discord linked + is in BellMarkets guild + settle event fires → bot fetches user via `client.users.fetch(discord_id)` → `.send("Your AAPL position settled Yes. +$50 USDC.")` → message delivered → log success in Neon `notification_deliveries`.
- [ ] **T-7.2** Message includes a deep link to the user's BellMarkets profile + the specific market.

**Failure modes:**
- [ ] **T-7.3** User has Discord linked but NOT in guild → `.send()` throws `DiscordAPIError: Cannot send messages to this user` → fallback to email if email is linked + email_settle enabled; else log "no deliverable channel" + queue for retry.
- [ ] **T-7.4** User has DMs disabled in their Discord privacy settings → same error path as T-7.3; fallback to email.
- [ ] **T-7.5** Bot rate-limited by Discord (50 DMs/sec is the rough limit) → respect retry-after header from discord.js error; queue + redeliver.
- [ ] **T-7.6** Bot token revoked / bot kicked from guild → all DMs fail with auth error; alert ops; pause Discord DM delivery globally until reconfigured.

### 8. Email transactional delivery

nodemailer + SMTP (Bram chooses provider — Resend, SendGrid, AWS SES per DR-014 §"Stack").

**Happy path:**
- [ ] **T-8.1** Settle event fires for user with `email_settle_notifications = true` AND email linked → nodemailer composes message from template → sends via SMTP → delivery accepted (250 SMTP response) → log in Neon `notification_deliveries`.
- [ ] **T-8.2** Template includes: human-readable market name, settle price, outcome, payout amount, redeem CTA link, BellMarkets footer with unsubscribe link (CAN-SPAM compliance).
- [ ] **T-8.3** Plain-text fallback alongside HTML (rare but spec compliance).

**Failure modes:**
- [ ] **T-8.4** SMTP returns 4xx (greylisted / temporary) → backoff + retry up to N times; if all fail, mark `notification_deliveries.status = failed_retriable` + log.
- [ ] **T-8.5** SMTP returns 5xx (permanent — invalid recipient) → mark delivery failed_permanent; flag user's email as invalid in Neon; next attempt skips.
- [ ] **T-8.6** Bounce webhook from email provider (separate from SMTP response) → SES/Resend POSTs bounce notification → Neon row gets bounce flag; future sends to that address skipped.
- [ ] **T-8.7** User clicks unsubscribe link → updates `notification_prefs.email_settle_notifications = false`; subsequent sends suppressed.
- [ ] **T-8.8** Newsletter send (separate cron, not triggered by chain event) honors `email_newsletter` opt-in.

**Throttling:**
- [ ] **T-8.9** Don't send >1 email per user per 5-minute window for the same event type. Prevents settle-storm spam if many of the user's markets settle simultaneously. Batch into a single "5 of your markets just settled" email instead.

### 9. Schema integrity

Tests against the Neon schema itself.

- [ ] **T-9.1** `users.wallet_pubkey` is a UNIQUE constraint — second profile-create with same wallet rejects.
- [ ] **T-9.2** `accounts.{provider, provider_account_id}` is a unique composite — same twitter_id can't link to two users.
- [ ] **T-9.3** Cascade: deleting a `users` row deletes all child rows in `accounts`, `notification_prefs`, `push_subscriptions`, `sessions` (no orphan referential rows).
- [ ] **T-9.4** Migration replayability: `npm run db:migrate` from empty DB produces same schema as current state. No "init only" SQL.
- [ ] **T-9.5** PII column-level encryption (or row-level access control via Neon's permissions) — even DB admins shouldn't see raw email/handle without an explicit grant. **NICE-TO-HAVE — defer if Neon doesn't support natively.**

### 10. Privacy + compliance

Per DR-014 §"Privacy: Hard NOs around PII unchanged. Email + social handles are PII; stored in Neon, never logged to handoffs / commit messages / public chat."

- [ ] **T-10.1** Server logs do NOT print user emails or full discord usernames. Log lines with user context use truncated pubkey (e.g., `7b17F2wo...`) + a UUID-style hash of email, never the raw email.
- [ ] **T-10.2** Error messages to users don't leak other users' info ("this Twitter account is already linked to a different profile" is OK; "this Twitter account is linked to alice@example.com" is NOT).
- [ ] **T-10.3** User-facing "delete my account" flow exists + actually deletes Neon rows (cascade per T-9.3). NOT just a soft-delete flag.
- [ ] **T-10.4** Profile export (GDPR right-to-data-portability) returns ALL of user's data — `users`, linked `accounts`, `notification_prefs`, `push_subscriptions`, `notification_deliveries` history.

---

## Cross-DR test integration

DR-014 composes with:
- **DR-010 (leaderboard)** — settle-event notifications include the user's current weekly+monthly streak rank. Test: T-7.1, T-8.1, T-5.5 all include rank data in their templates.
- **DR-013 (embedded wallets)** — embedded-wallet users have mandatory email. Test (in DR-013's separate plan, not here): embedded-wallet creation REQUIRES profile creation; can't skip the email gate.
- **DR-015 (multi-metric leaderboard)** — notification can target leaderboard winners by metric. Test: a single user can receive separate emails for "you won the profit leaderboard" + "you won the streak leaderboard" without dedup-as-same-event.

---

## What this plan does NOT test (intentionally)

- **OAuth provider's own correctness.** We assume Twitter/Discord/Google sign-in works as documented. Their own QA covers their service.
- **NextAuth's own correctness.** Battle-tested library; testing it is duplicating their CI.
- **SMTP RFC compliance.** nodemailer handles this; we test our use of it, not nodemailer itself.
- **Browser push protocol correctness.** Same — we test our subscription mgmt + delivery wrapping, not the underlying PushManager.
- **Adversarial Discord bot rate-limit gaming.** Out of scope at MVP scale; in-scope at Pro/scale tier.

---

## Drew's role in DR-014

Once Bram's NextAuth + Neon scaffold lands:
- Drew reviews `services/automation/__tests__/` (or wherever) for coverage of the ~50 cases above
- Drew writes the cross-DR-010 + cross-DR-013 integration tests (the seams)
- Drew adds DR-014 stuff to the one-command-demo.sh if the demo wants to show notification delivery (probably scoped out for MVP; profile-creation is a v1.5 deliverable)
- Drew flags any test passing for the wrong reason via Sonnet audit dispatch (per Drew's standing operating discipline since Day-3)

This spec is the input artifact for that work. Bram + Drew coordinate when his scaffold first commits.
