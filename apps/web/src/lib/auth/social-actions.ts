/**
 * Server-side upsert of an OAuth-linked social account against the user
 * record (DR-014). Bram's Neon schema lands the `users` + `social_accounts`
 * tables — until those exist, this is a structured no-op so the OAuth
 * round-trip works end-to-end without touching the DB.
 *
 * **No PII (email, handle) is logged at info-level.** Debug-only.
 *
 * Once Bram's schema lands:
 *   - Look up `users.id` by `wallet_pubkey`. If missing AND walletAddress is
 *     present, INSERT a new user (wallet is canonical identity).
 *   - UPSERT `social_accounts (provider, provider_id) → user_id`, capturing
 *     the latest avatar/handle/email opportunistically.
 *
 * No throws on best-effort fields — provider_id is the only hard requirement.
 */

export interface SocialAccountInput {
  provider: string;
  providerId: string;
  username?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

export async function createUserOrUpdateSocial(
  social: SocialAccountInput,
  walletAddress: string | null,
): Promise<void> {
  if (process.env.NODE_ENV === "development") {
    // Debug-only: prints provider + truncated wallet, NEVER email / handle / id.
    const walletTrunc = walletAddress
      ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
      : "(unlinked)";
    console.debug(
      `[DR-014 stub] createUserOrUpdateSocial: provider=${social.provider} wallet=${walletTrunc}`,
    );
  }
  // No-op until Bram's schema lands. The signature is intentionally async so
  // the real implementation can be a Neon transaction without changing the
  // call site.
  return Promise.resolve();
}
