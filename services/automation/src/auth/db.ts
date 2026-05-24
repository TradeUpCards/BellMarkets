// DR-014 user-auth database layer. Sits on top of the existing
// db/client.ts Neon HTTP connection so we don't add a second pool.
//
// Functions return raw types from auth/types.ts (no JSON shape exposure).
// All SQL is parameterized — no string interpolation of user input.
//
// Test injection: each fn accepts an optional `{ sql }` deps bag to override
// the Neon client. Tests pass a stub SQL impl.

import { getSqlClient } from "../db/client.js";
import type { SqlClient } from "../db/client.js";
import type {
  NotificationChannel,
  NotificationKind,
  NotificationPrefs,
  OAuthAccount,
  OAuthProfileInput,
  Provider,
  PushSubscriptionRecord,
  User,
} from "./types.js";

export type AuthDbDeps = { sql?: SqlClient };

function clientOf(deps?: AuthDbDeps): SqlClient {
  return deps?.sql ?? getSqlClient();
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/**
 * Idempotent upsert keyed on `wallet_pubkey`. Optionally seeds email + handle
 * + avatar from a fresh OAuth profile when the user is being created. Returns
 * the row that's now in the table.
 */
export async function upsertUserByWallet(
  walletPubkey: string,
  seed: Pick<User, "email" | "handle" | "avatarUrl" | "snsName"> = {
    email: undefined,
    handle: undefined,
    avatarUrl: undefined,
    snsName: undefined,
  },
  deps?: AuthDbDeps,
): Promise<User> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO users (wallet_pubkey, email, handle, avatar_url, sns_name)
    VALUES (${walletPubkey}, ${seed.email ?? null}, ${seed.handle ?? null}, ${seed.avatarUrl ?? null}, ${seed.snsName ?? null})
    ON CONFLICT (wallet_pubkey) DO UPDATE SET
      email = COALESCE(users.email, excluded.email),
      avatar_url = COALESCE(users.avatar_url, excluded.avatar_url),
      sns_name = COALESCE(users.sns_name, excluded.sns_name),
      updated_at = NOW()
    RETURNING id, wallet_pubkey, email, handle, avatar_url, sns_name, created_at, updated_at
  `) as Array<RawUser>;
  const row = rows[0];
  if (!row) throw new Error("upsertUserByWallet: insert returned no rows");
  return rowToUser(row);
}

export async function getUserById(id: string, deps?: AuthDbDeps): Promise<User | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, wallet_pubkey, email, handle, avatar_url, sns_name, created_at, updated_at
    FROM users
    WHERE id = ${id}
  `) as Array<RawUser>;
  return rows[0] ? rowToUser(rows[0]) : undefined;
}

export async function getUserByWalletPubkey(
  walletPubkey: string,
  deps?: AuthDbDeps,
): Promise<User | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, wallet_pubkey, email, handle, avatar_url, sns_name, created_at, updated_at
    FROM users
    WHERE wallet_pubkey = ${walletPubkey}
  `) as Array<RawUser>;
  return rows[0] ? rowToUser(rows[0]) : undefined;
}

/**
 * Optimistic concurrency: callers should re-read after update if they care
 * about freshness. Empty patch is a no-op (returns the row unchanged).
 */
export async function updateUserHandle(
  userId: string,
  handle: string,
  deps?: AuthDbDeps,
): Promise<User | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    UPDATE users SET handle = ${handle}, updated_at = NOW() WHERE id = ${userId}
    RETURNING id, wallet_pubkey, email, handle, avatar_url, sns_name, created_at, updated_at
  `) as Array<RawUser>;
  return rows[0] ? rowToUser(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// oauth_accounts
// ---------------------------------------------------------------------------

/**
 * Link an OAuth account to a user. Idempotent on (provider, provider_user_id).
 * Updates the row in place if it exists (refreshing email, username, avatar,
 * refresh_token from the latest OAuth response).
 */
export async function linkOAuthAccount(
  userId: string,
  profile: OAuthProfileInput,
  refreshToken?: string,
  accessTokenExpiresAt?: Date,
  deps?: AuthDbDeps,
): Promise<OAuthAccount> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO oauth_accounts (
      user_id, provider, provider_user_id, email, username, avatar_url,
      refresh_token, access_token_expires_at
    )
    VALUES (
      ${userId}, ${profile.provider}, ${profile.providerUserId},
      ${profile.email ?? null}, ${profile.username ?? null}, ${profile.avatarUrl ?? null},
      ${refreshToken ?? null}, ${accessTokenExpiresAt?.toISOString() ?? null}
    )
    ON CONFLICT (provider, provider_user_id) DO UPDATE SET
      user_id = excluded.user_id,
      email = COALESCE(excluded.email, oauth_accounts.email),
      username = COALESCE(excluded.username, oauth_accounts.username),
      avatar_url = COALESCE(excluded.avatar_url, oauth_accounts.avatar_url),
      refresh_token = COALESCE(excluded.refresh_token, oauth_accounts.refresh_token),
      access_token_expires_at = COALESCE(excluded.access_token_expires_at, oauth_accounts.access_token_expires_at),
      updated_at = NOW()
    RETURNING id, user_id, provider, provider_user_id, email, username, avatar_url,
              refresh_token, access_token_expires_at, created_at, updated_at
  `) as Array<RawOAuthAccount>;
  const row = rows[0];
  if (!row) throw new Error("linkOAuthAccount: insert returned no rows");
  return rowToOAuthAccount(row);
}

export async function getOAuthAccount(
  provider: Provider,
  providerUserId: string,
  deps?: AuthDbDeps,
): Promise<OAuthAccount | undefined> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, user_id, provider, provider_user_id, email, username, avatar_url,
           refresh_token, access_token_expires_at, created_at, updated_at
    FROM oauth_accounts
    WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
  `) as Array<RawOAuthAccount>;
  return rows[0] ? rowToOAuthAccount(rows[0]) : undefined;
}

export async function listOAuthAccountsForUser(
  userId: string,
  deps?: AuthDbDeps,
): Promise<OAuthAccount[]> {
  const sql = clientOf(deps);
  const rows = (await sql`
    SELECT id, user_id, provider, provider_user_id, email, username, avatar_url,
           refresh_token, access_token_expires_at, created_at, updated_at
    FROM oauth_accounts
    WHERE user_id = ${userId}
  `) as Array<RawOAuthAccount>;
  return rows.map(rowToOAuthAccount);
}

export async function unlinkOAuthAccount(
  userId: string,
  provider: Provider,
  deps?: AuthDbDeps,
): Promise<void> {
  const sql = clientOf(deps);
  await sql`DELETE FROM oauth_accounts WHERE user_id = ${userId} AND provider = ${provider}`;
}

// ---------------------------------------------------------------------------
// notification_prefs
// ---------------------------------------------------------------------------

/**
 * Read prefs for a user, creating a default row if missing. All channels
 * default OFF per DR-014 §4 (opt-in only).
 */
export async function getOrCreateNotificationPrefs(
  userId: string,
  deps?: AuthDbDeps,
): Promise<NotificationPrefs> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO notification_prefs (user_id)
    VALUES (${userId})
    ON CONFLICT (user_id) DO UPDATE SET updated_at = notification_prefs.updated_at
    RETURNING user_id, email_transactional_enabled, email_newsletter_enabled,
              discord_dm_enabled, push_enabled, telegram_enabled,
              created_at, updated_at
  `) as Array<RawNotificationPrefs>;
  const row = rows[0];
  if (!row) throw new Error("getOrCreateNotificationPrefs: returned no rows");
  return rowToNotificationPrefs(row);
}

export type NotificationPrefsPatch = Partial<
  Pick<
    NotificationPrefs,
    | "emailTransactionalEnabled"
    | "emailNewsletterEnabled"
    | "discordDmEnabled"
    | "pushEnabled"
    | "telegramEnabled"
  >
>;

/**
 * Patch notification prefs. Only listed fields are updated. Caller MUST have
 * already created the row (via getOrCreateNotificationPrefs) — patch never
 * inserts. Returns the row post-update.
 */
export async function patchNotificationPrefs(
  userId: string,
  patch: NotificationPrefsPatch,
  deps?: AuthDbDeps,
): Promise<NotificationPrefs | undefined> {
  const sql = clientOf(deps);
  // Coalesce undefined values to the existing column value via COALESCE.
  const rows = (await sql`
    UPDATE notification_prefs SET
      email_transactional_enabled = COALESCE(${patch.emailTransactionalEnabled ?? null}, email_transactional_enabled),
      email_newsletter_enabled = COALESCE(${patch.emailNewsletterEnabled ?? null}, email_newsletter_enabled),
      discord_dm_enabled = COALESCE(${patch.discordDmEnabled ?? null}, discord_dm_enabled),
      push_enabled = COALESCE(${patch.pushEnabled ?? null}, push_enabled),
      telegram_enabled = COALESCE(${patch.telegramEnabled ?? null}, telegram_enabled),
      updated_at = NOW()
    WHERE user_id = ${userId}
    RETURNING user_id, email_transactional_enabled, email_newsletter_enabled,
              discord_dm_enabled, push_enabled, telegram_enabled, created_at, updated_at
  `) as Array<RawNotificationPrefs>;
  return rows[0] ? rowToNotificationPrefs(rows[0]) : undefined;
}

// ---------------------------------------------------------------------------
// push_subscriptions
// ---------------------------------------------------------------------------

export type PushSubscriptionInput = {
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  uaString?: string;
};

/**
 * Upsert a push subscription. Idempotent on (user_id, endpoint). Re-activates
 * a previously revoked endpoint if the user re-subscribes from the same
 * browser.
 */
export async function upsertPushSubscription(
  userId: string,
  input: PushSubscriptionInput,
  deps?: AuthDbDeps,
): Promise<PushSubscriptionRecord> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, ua_string, status)
    VALUES (${userId}, ${input.endpoint}, ${input.p256dhKey}, ${input.authKey}, ${input.uaString ?? null}, 'active')
    ON CONFLICT (user_id, endpoint) DO UPDATE SET
      p256dh_key = excluded.p256dh_key,
      auth_key = excluded.auth_key,
      ua_string = COALESCE(excluded.ua_string, push_subscriptions.ua_string),
      status = 'active',
      updated_at = NOW()
    RETURNING id, user_id, endpoint, p256dh_key, auth_key, ua_string, status, created_at, updated_at
  `) as Array<RawPushSubscription>;
  const row = rows[0];
  if (!row) throw new Error("upsertPushSubscription: returned no rows");
  return rowToPushSubscription(row);
}

export async function markPushSubscriptionStatus(
  endpoint: string,
  status: "revoked" | "expired",
  deps?: AuthDbDeps,
): Promise<void> {
  const sql = clientOf(deps);
  await sql`
    UPDATE push_subscriptions SET status = ${status}, updated_at = NOW()
    WHERE endpoint = ${endpoint}
  `;
}

export async function listActivePushSubscriptions(
  userId: string | undefined,
  deps?: AuthDbDeps,
): Promise<PushSubscriptionRecord[]> {
  const sql = clientOf(deps);
  // Branch in SQL — neon's template literal accepts undefined via null
  if (userId === undefined) {
    const rows = (await sql`
      SELECT id, user_id, endpoint, p256dh_key, auth_key, ua_string, status, created_at, updated_at
      FROM push_subscriptions
      WHERE status = 'active'
    `) as Array<RawPushSubscription>;
    return rows.map(rowToPushSubscription);
  }
  const rows = (await sql`
    SELECT id, user_id, endpoint, p256dh_key, auth_key, ua_string, status, created_at, updated_at
    FROM push_subscriptions
    WHERE user_id = ${userId} AND status = 'active'
  `) as Array<RawPushSubscription>;
  return rows.map(rowToPushSubscription);
}

// ---------------------------------------------------------------------------
// notifications_sent — audit log
// ---------------------------------------------------------------------------

export type NotificationLogInput = {
  userId: string;
  channel: NotificationChannel;
  kind: NotificationKind | string;
  payload?: Record<string, unknown>;
  status?: "sent" | "failed" | "retrying";
  lastError?: string;
};

export async function logNotificationSent(
  input: NotificationLogInput,
  deps?: AuthDbDeps,
): Promise<number> {
  const sql = clientOf(deps);
  const rows = (await sql`
    INSERT INTO notifications_sent (user_id, channel, kind, payload, status, last_error)
    VALUES (
      ${input.userId}, ${input.channel}, ${input.kind},
      ${input.payload ? JSON.stringify(input.payload) : null}::jsonb,
      ${input.status ?? "sent"},
      ${input.lastError ?? null}
    )
    RETURNING id
  `) as Array<{ id: number }>;
  const row = rows[0];
  if (!row) throw new Error("logNotificationSent: returned no rows");
  return row.id;
}

// ---------------------------------------------------------------------------
// Row mappers (DB snake_case → TS camelCase)
// ---------------------------------------------------------------------------

type RawUser = {
  id: string;
  wallet_pubkey: string;
  email: string | null;
  handle: string | null;
  avatar_url: string | null;
  sns_name: string | null;
  created_at: string;
  updated_at: string;
};

function rowToUser(r: RawUser): User {
  return {
    id: r.id,
    walletPubkey: r.wallet_pubkey,
    email: r.email ?? undefined,
    handle: r.handle ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    snsName: r.sns_name ?? undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

type RawOAuthAccount = {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  email: string | null;
  username: string | null;
  avatar_url: string | null;
  refresh_token: string | null;
  access_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

function rowToOAuthAccount(r: RawOAuthAccount): OAuthAccount {
  return {
    id: r.id,
    userId: r.user_id,
    provider: r.provider as Provider,
    providerUserId: r.provider_user_id,
    email: r.email ?? undefined,
    username: r.username ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    refreshToken: r.refresh_token ?? undefined,
    accessTokenExpiresAt: r.access_token_expires_at ? new Date(r.access_token_expires_at) : undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

type RawNotificationPrefs = {
  user_id: string;
  email_transactional_enabled: boolean;
  email_newsletter_enabled: boolean;
  discord_dm_enabled: boolean;
  push_enabled: boolean;
  telegram_enabled: boolean;
  created_at: string;
  updated_at: string;
};

function rowToNotificationPrefs(r: RawNotificationPrefs): NotificationPrefs {
  return {
    userId: r.user_id,
    emailTransactionalEnabled: r.email_transactional_enabled,
    emailNewsletterEnabled: r.email_newsletter_enabled,
    discordDmEnabled: r.discord_dm_enabled,
    pushEnabled: r.push_enabled,
    telegramEnabled: r.telegram_enabled,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

type RawPushSubscription = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  ua_string: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

function rowToPushSubscription(r: RawPushSubscription): PushSubscriptionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dhKey: r.p256dh_key,
    authKey: r.auth_key,
    uaString: r.ua_string ?? undefined,
    status: r.status as PushSubscriptionRecord["status"],
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}
