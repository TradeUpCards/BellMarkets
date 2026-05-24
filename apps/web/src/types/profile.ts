/**
 * User-profile types per DR-014.
 *
 * Wallet pubkey is the canonical identity. Email + social links are
 * opportunistically captured (via OAuth) and never required for trading —
 * they unlock the marketing-loop surfaces only (newsletter, push, share-cards).
 *
 * All fields ride through `/api/profile`. The frontend NEVER stores PII
 * (email, handle) in localStorage or in TanStack's cache beyond the
 * lifetime of the active query.
 */

import type { PublicKey } from "@solana/web3.js";

export type SocialProvider = "discord" | "google" | "twitter";

export interface SocialLink {
  provider: SocialProvider;
  providerId: string;
  username: string | null;
  /** Raw avatar URL from the provider (Discord CDN, Google content URL, etc.). */
  avatarUrl: string | null;
  /** Unix seconds — last time the OAuth account refreshed our copy. */
  linkedAtUnix: number;
}

export interface NotificationPrefs {
  email: {
    transactional: boolean;
    newsletter: boolean;
  };
  discord: {
    /** Settlement / win-trade DMs via shared-server bot pattern (DR-014). */
    settlements: boolean;
    newsletter: boolean;
  };
  browserPush: {
    settlements: boolean;
    newsStreaks: boolean;
  };
  telegram?: {
    /** v2.0 surface — kept optional so the v1.5 frontend can render without it. */
    settlements: boolean;
  };
}

export interface Profile {
  walletPubkey: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
  /** Uploaded avatar URL — wins over all other sources per DR-014 resolver chain. */
  uploadedAvatarUrl: string | null;
  socials: SocialLink[];
  notificationPrefs: NotificationPrefs;
  /** Unix seconds — never decays; informational. */
  createdAtUnix: number;
  updatedAtUnix: number;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  email: { transactional: true, newsletter: false },
  discord: { settlements: false, newsletter: false },
  browserPush: { settlements: false, newsStreaks: false },
};

/** Pure projection of a wallet pubkey for cache-key parity. */
export function walletKey(pubkey: PublicKey | string | null | undefined): string | null {
  if (!pubkey) return null;
  return typeof pubkey === "string" ? pubkey : pubkey.toBase58();
}
