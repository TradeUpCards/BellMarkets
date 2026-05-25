// DR-014 auth barrel — apps/web (Cleo) imports `@bell-markets/automation/auth`.
//
//   import { bellMarketsAuthOptions } from "@bell-markets/automation/auth";
//
// Includes:
//   - NextAuth options + helpers (options.ts)
//   - DB layer for users / oauth_accounts / notification_prefs / push_subscriptions (db.ts)
//   - Discord bot DM helper (discord-bot.ts)
//   - Web-push subscription + send helpers (web-push.ts)
//   - Shared types (types.ts)

export * from "./types.js";

export {
  bellMarketsAuthOptions,
  handleSignIn,
  normalizeOAuthProfile,
  verifyWalletSignature,
} from "./options.js";
export {
  RANDOM_USERNAME_ADJECTIVES,
  RANDOM_USERNAME_NOUNS,
  RANDOM_USERNAME_REGEX,
  isRandomUsername,
} from "./random-username.js";
export type {
  BellMarketsAuthUser,
  SignInCookieReader,
  SignInHandlerDeps,
  SignInHandlerInput,
  SignInHandlerResult,
} from "./options.js";

export {
  upsertUserByWallet,
  getUserById,
  getUserByWalletPubkey,
  updateUserHandle,
  linkOAuthAccount,
  getOAuthAccount,
  listOAuthAccountsForUser,
  unlinkOAuthAccount,
  getOrCreateNotificationPrefs,
  patchNotificationPrefs,
  upsertPushSubscription,
  markPushSubscriptionStatus,
  listActivePushSubscriptions,
  logNotificationSent,
} from "./db.js";
export type { AuthDbDeps, NotificationLogInput, NotificationPrefsPatch, PushSubscriptionInput } from "./db.js";

export {
  ensureDiscordBotReady,
  sendDiscordDM,
  formatDiscordTimestamp,
  DiscordBotError,
} from "./discord-bot.js";
export type { DiscordDMResult } from "./discord-bot.js";

export {
  subscribeToPushFromBrowser,
  unsubscribeFromPush,
  sendPushToUser,
  broadcastPush,
  WebPushError,
} from "./web-push.js";
export type { PushPayload, PushSendResult } from "./web-push.js";
