/**
 * Username generator — direct port of fanalytics' `src/utils/usernameGenerator.ts`
 * (see `/c/Dev/fffanalytics_t3` for the reference).
 *
 * Pattern: `${Adjective}${Noun}${0-999}` → "BraveEagle983".
 *
 * The fixed dictionaries are intentionally small (10 × 10 × 1000 = 100K
 * possible handles) and the same as fanalytics so the random-detection
 * regex works against the EXACT same word set. When this is replaced
 * later, the regex still catches all historical auto-gen handles.
 *
 * `isRandomUsername(handle)` returns true iff the handle matches the
 * auto-gen pattern AND every component is in the dictionary. The OAuth
 * link flow uses this to decide whether to overwrite the handle with
 * the provider's `display_name` — auto-gen = safe to clobber;
 * user-chosen = preserve.
 */

export const ADJECTIVES = [
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

export const NOUNS = [
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
 * Returns a random `BraveEagle983`-style handle. 10 × 10 × 1000 = 100,000
 * possible combinations; UNIQUE constraint on `users.handle` collisions are
 * possible but rare. Callers should retry on `unique_violation`.
 */
export function generateUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  const num = Math.floor(Math.random() * 1000);
  return `${adj}${noun}${num}`;
}

const RANDOM_USERNAME_RE = /^([A-Z][a-z]+)([A-Z][a-z]+)(\d+)$/;

/**
 * Detect whether a handle was produced by `generateUsername`. Used by the
 * OAuth-link upsert flow: if the existing handle is still auto-gen, the
 * provider's `display_name` overwrites it; otherwise the user-chosen handle
 * is preserved.
 *
 * Matches the fanalytics implementation exactly — see
 * `/c/Dev/fffanalytics_t3/src/actions/userActions.ts::isRandomUsername`.
 */
export function isRandomUsername(handle: string | null | undefined): boolean {
  if (!handle) return false;
  const parts = handle.match(RANDOM_USERNAME_RE);
  if (!parts) return false;
  const [, adjective, noun, number] = parts;
  if (!adjective || !noun || !number) return false;
  return (
    (ADJECTIVES as readonly string[]).includes(adjective) &&
    (NOUNS as readonly string[]).includes(noun) &&
    parseInt(number, 10) < 1000
  );
}

/**
 * Generates the virtual email used when a wallet connects with no real
 * email yet. The OAuth-link upsert overwrites with the real email when
 * available (per `users.email` COALESCE + `email !== '@virtual.' check
 * mirrored from fanalytics).
 */
export function virtualEmail(walletPubkey: string): string {
  return `${walletPubkey}@virtual.bell.markets`;
}

const VIRTUAL_EMAIL_SUFFIX = "@virtual.bell.markets";
const FANALYTICS_VIRTUAL_SUFFIX = "@virtual.com";

/** True iff the email looks like one we auto-generated (BM or fanalytics). */
export function isVirtualEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (
    email.endsWith(VIRTUAL_EMAIL_SUFFIX) ||
    email.endsWith(FANALYTICS_VIRTUAL_SUFFIX)
  );
}
