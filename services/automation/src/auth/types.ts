// DR-014 user + auth shapes. Mirrors db/migrations/0002_dr014_auth_users.sql.

export type Provider = "twitter" | "discord" | "google";

export type User = {
  id: string;
  walletPubkey: string;
  email: string | undefined;
  handle: string | undefined;
  avatarUrl: string | undefined;
  snsName: string | undefined;
  createdAt: Date;
  updatedAt: Date;
};

export type OAuthAccount = {
  id: string;
  userId: string;
  provider: Provider;
  providerUserId: string;
  email: string | undefined;
  username: string | undefined;
  avatarUrl: string | undefined;
  refreshToken: string | undefined;
  accessTokenExpiresAt: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationPrefs = {
  userId: string;
  emailTransactionalEnabled: boolean;
  emailNewsletterEnabled: boolean;
  discordDmEnabled: boolean;
  pushEnabled: boolean;
  telegramEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PushSubscriptionRecord = {
  id: string;
  userId: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  uaString: string | undefined;
  status: "active" | "revoked" | "expired";
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationChannel = "email" | "discord" | "push" | "telegram";

export type NotificationKind =
  | "settle"
  | "leaderboard_won"
  | "newsletter"
  | "milestone_streak"
  | "embedded_wallet_recovery"
  | "test";

/**
 * Standard shape passed into `createOrUpdateUserFromOAuth` — provider's
 * profile data normalized across Twitter/Discord/Google so the DB layer
 * doesn't need provider-specific branches.
 */
export type OAuthProfileInput = {
  provider: Provider;
  providerUserId: string;
  email: string | undefined;
  username: string | undefined;
  avatarUrl: string | undefined;
};
