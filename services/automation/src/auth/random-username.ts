// DR-014 auto-username flow detection (fanalytics pattern; coordinated with
// Cleo per cleo-handoff.md "For Bram — RAISE: fanalytics auto-username flow").
//
// Cleo's frontend generates a random username via the fanalytics
// generator (adjective × noun × 0-999) at wallet-connect time, so users have
// a handle before they ever do OAuth. When the user later signs in with
// Discord/Google/Twitter, `handleSignIn` checks `isRandomUsername(existingHandle)` —
// if still auto-gen, it overwrites with the OAuth display name (per fanalytics
// `createUserOrUpdateSocial` logic). If the user has already chosen their own
// handle in settings, the regex no longer matches → handle preserved.
//
// **The dictionary here MUST stay byte-identical to Cleo's
// `apps/web/src/lib/username-generator.ts`.** Drift between them means a
// fanalytics-style auto-gen Cleo emits won't be detected by Bram → OAuth
// override never fires for that user → bad UX. The dictionary is short + frozen
// per fanalytics; we're not adding words without a coordinated patch.

/** Adjectives — matches Cleo's apps/web/src/lib/username-generator.ts. */
export const RANDOM_USERNAME_ADJECTIVES = [
  "Brave",
  "Clever",
  "Dazzling",
  "Eager",
  "Fierce",
  "Gentle",
  "Happy",
  "Jolly",
  "Kind",
  "Lively",
] as const;

/** Nouns — matches Cleo's apps/web/src/lib/username-generator.ts. */
export const RANDOM_USERNAME_NOUNS = [
  "Fox",
  "Wolf",
  "Bear",
  "Eagle",
  "Owl",
  "Lion",
  "Tiger",
  "Panda",
  "Koala",
  "Dolphin",
] as const;

/**
 * Compiled regex: `^<Adj><Noun>0-999$`. Case-sensitive — fanalytics
 * generates PascalCase. The number is 1-3 digits, no leading zeros (matches
 * `Math.floor(Math.random() * 1000).toString()`).
 *
 * Note: trailing-anchored `$` rejects things like "BraveFox42_v2" — those are
 * user-customized handles, not auto-gen.
 */
export const RANDOM_USERNAME_REGEX: RegExp = (() => {
  const adj = RANDOM_USERNAME_ADJECTIVES.join("|");
  const noun = RANDOM_USERNAME_NOUNS.join("|");
  // `(?:0|[1-9]\d{0,2})` matches "0", "5", "42", "999" but NOT "007".
  // Math.random() doesn't produce zero-padded numbers; this anchors that.
  return new RegExp(`^(?:${adj})(?:${noun})(?:0|[1-9]\\d{0,2})$`);
})();

/**
 * Returns true iff `handle` matches the auto-gen pattern. Used in
 * `handleSignIn` to decide whether an OAuth display name should overwrite
 * the existing handle.
 *
 * Nullish input → false (no auto-gen handle exists to override).
 */
export function isRandomUsername(handle: string | null | undefined): boolean {
  if (!handle) return false;
  return RANDOM_USERNAME_REGEX.test(handle);
}
