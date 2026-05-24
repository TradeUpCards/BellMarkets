/**
 * Avatar resolver chain per DR-014:
 *
 *   1. explicit upload  (`profile.uploadedAvatarUrl`)
 *   2. most-recent linked social-account avatar (latest `SocialLink.avatarUrl`)
 *   3. SNS metadata (`.sol` name image, if any)
 *   4. generated identicon (deterministic from wallet pubkey)
 *
 * Returns a tagged result so the UI can render differently (e.g. show the
 * provider mark for social avatars; show "default" badge on identicon).
 *
 * ENS / `.eth` resolution is intentionally out of scope per DR-014.
 *
 * The identicon backend is left abstract — the resolver returns a stable
 * `seed` string and the UI plugs in Boring Avatars / DiceBear / equivalent.
 * This keeps the resolver pure (no rendering deps).
 */

import type { Profile, SocialLink } from "@/types/profile";

export type AvatarKind = "upload" | "social" | "sns" | "identicon";

export interface ResolvedAvatar {
  kind: AvatarKind;
  /** URL when `kind` is upload | social | sns. `null` when `kind === "identicon"`. */
  url: string | null;
  /** Stable hash seed for the identicon backend (always set; useful as a fallback id). */
  seed: string;
  /** Optional provider hint for "social" kind so UI can render a small badge. */
  provider?: SocialLink["provider"];
}

export interface ResolveAvatarParams {
  walletPubkey: string;
  profile: Pick<Profile, "uploadedAvatarUrl" | "socials"> | null | undefined;
  /** Optional `.sol` name image URL — resolved off-chain by the caller (e.g. Bonfida API). */
  snsImageUrl?: string | null;
}

export function resolveAvatar(params: ResolveAvatarParams): ResolvedAvatar {
  const { walletPubkey, profile, snsImageUrl } = params;
  const seed = walletPubkey;

  if (profile?.uploadedAvatarUrl) {
    return { kind: "upload", url: profile.uploadedAvatarUrl, seed };
  }

  const mostRecentSocial = pickMostRecentSocialAvatar(profile?.socials);
  if (mostRecentSocial) {
    return {
      kind: "social",
      url: mostRecentSocial.avatarUrl,
      seed,
      provider: mostRecentSocial.provider,
    };
  }

  if (snsImageUrl) {
    return { kind: "sns", url: snsImageUrl, seed };
  }

  return { kind: "identicon", url: null, seed };
}

function pickMostRecentSocialAvatar(
  socials: readonly SocialLink[] | undefined,
): SocialLink | undefined {
  if (!socials || socials.length === 0) return undefined;
  return [...socials]
    .filter((s) => s.avatarUrl)
    .sort((a, b) => b.linkedAtUnix - a.linkedAtUnix)[0];
}
