// NextAuth v4 options adapted from /c/Dev/fffanalytics_t3/src/app/api/auth/
// [...nextauth]/options.ts for DR-014.
//
// Pattern (fanalytics-validated):
//   1. User signs an arbitrary "Link <provider> account" message with their
//      Solana wallet. Frontend stores `signedData` + `publicKey` in cookies.
//   2. User clicks "Sign in with Twitter/Discord/Google" → OAuth redirect.
//   3. On OAuth callback, NextAuth signIn() fires our callback:
//      - verifySignedMessage(signedData, publicKey, provider) → wallet pubkey
//      - createOrUpdateUserFromOAuth(profile, walletPubkey)   → users + oauth_accounts upsert
//      - returns true to complete sign-in
//   4. JWT carries { userId, walletPubkey, username }; session.user exposes
//      them for client + API-route consumption.
//
// FRONTEND OWNERSHIP: Cleo wires `apps/web/src/app/api/auth/[...nextauth]/
// route.ts` to consume the `bellMarketsAuthOptions` exported from here.
// The `pages.signIn` / `pages.error` routes are in Cleo's app shell.
//
// SECURITY:
//   - The wallet-signature verification rejects auth attempts where cookies
//     are missing OR where the signature is forged.
//   - refresh_token is stored in oauth_accounts in plaintext; Neon's
//     at-rest encryption covers it for MVP. V2: wrap with libsodium sealedbox.
//   - NEXTAUTH_SECRET MUST be set in apps/web/.env.local for JWT signing.

import type { Account, NextAuthOptions, Profile, User as NextAuthUser } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";

import { linkOAuthAccount, upsertUserByWallet } from "./db.js";
import type { OAuthProfileInput, Provider, User } from "./types.js";

// ---------------------------------------------------------------------------
// Provider config — dynamically loaded so missing creds don't crash import
// ---------------------------------------------------------------------------

/** Subset of NextAuth's `User` we extend with our app fields. */
export type BellMarketsAuthUser = NextAuthUser & {
  id: string;
  walletPubkey?: string;
  username?: string;
};

type ExtendedProfile = Profile & {
  id?: string;
  username?: string;
  email?: string | null;
  image_url?: string | null;
  global_name?: string | null;
  profile_image_url?: string | null;
  picture?: string | null; // Google
};

function buildProviders(): OAuthConfig<ExtendedProfile>[] {
  const providers: OAuthConfig<ExtendedProfile>[] = [];

  // Twitter (X) v2 — identity + email
  if (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const TwitterProvider = require("next-auth/providers/twitter").default;
      providers.push(
        TwitterProvider({
          clientId: process.env.TWITTER_CLIENT_ID,
          clientSecret: process.env.TWITTER_CLIENT_SECRET,
          version: "2.0",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async profile(profile: any) {
            return {
              id: profile.data?.id ?? profile.id,
              name: profile.data?.name ?? profile.name,
              image: profile.data?.profile_image_url ?? profile.profile_image_url,
              username: profile.data?.username ?? profile.username,
              email: profile.data?.email ?? profile.email,
            };
          },
        }),
      );
    } catch (err) {
      console.warn("[auth] Twitter provider unavailable:", (err as Error).message);
    }
  }

  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const DiscordProvider = require("next-auth/providers/discord").default;
      providers.push(
        DiscordProvider({
          clientId: process.env.DISCORD_CLIENT_ID,
          clientSecret: process.env.DISCORD_CLIENT_SECRET,
          // `identify` for ID/username/avatar, `email` for email capture
          authorization: { params: { scope: "identify email" } },
        }),
      );
    } catch (err) {
      console.warn("[auth] Discord provider unavailable:", (err as Error).message);
    }
  }

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const GoogleProvider = require("next-auth/providers/google").default;
      providers.push(
        GoogleProvider({
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          // Email scope ships with Google by default; explicit for documentation
          authorization: { params: { scope: "openid email profile" } },
        }),
      );
    } catch (err) {
      console.warn("[auth] Google provider unavailable:", (err as Error).message);
    }
  }

  return providers;
}

// ---------------------------------------------------------------------------
// Wallet signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a Solana ed25519 signature over the canonical message
 * "Link <provider> account". Returns the base58 wallet pubkey on success.
 * Defers @solana/web3.js + bs58 + tweetnacl imports to keep the auth module
 * import-time cheap.
 */
export async function verifyWalletSignature(
  signedDataBase58: string,
  publicKeyBase58: string,
  provider: Provider,
): Promise<string> {
  if (!signedDataBase58 || !publicKeyBase58) {
    throw new Error("verifyWalletSignature: signedData and publicKey are required");
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bs58 = await import("bs58").then((m) => m.default ?? m);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nacl = await import("tweetnacl").then((m) => m.default ?? m);
  const web3 = await import("@solana/web3.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signatureBytes: Uint8Array = (bs58 as any).decode(signedDataBase58);
  const message = new TextEncoder().encode(`Link ${provider} account`);
  const publicKey = new web3.PublicKey(publicKeyBase58);
  const valid = nacl.sign.detached.verify(message, signatureBytes, publicKey.toBytes());
  if (!valid) {
    throw new Error("verifyWalletSignature: invalid signature");
  }
  return publicKey.toBase58();
}

// ---------------------------------------------------------------------------
// Provider profile → normalized OAuthProfileInput
// ---------------------------------------------------------------------------

/**
 * Normalize provider-specific profile shapes into our common
 * `OAuthProfileInput`. Used inside the signIn callback before the DB write.
 * Tolerant to missing fields — captures whatever the provider returned.
 */
export function normalizeOAuthProfile(
  provider: Provider,
  user: BellMarketsAuthUser,
  profile: ExtendedProfile | undefined,
): OAuthProfileInput {
  return {
    provider,
    providerUserId: String(user.id ?? profile?.id ?? ""),
    email: user.email ?? profile?.email ?? undefined,
    username:
      user.username ??
      profile?.username ??
      profile?.global_name ??
      user.name ??
      undefined,
    avatarUrl:
      user.image ??
      profile?.profile_image_url ??
      profile?.image_url ??
      profile?.picture ??
      undefined,
  };
}

// ---------------------------------------------------------------------------
// Cookie helper — abstracted so unit tests don't need next/headers
// ---------------------------------------------------------------------------

export type SignInCookieReader = {
  signedData: string | undefined;
  publicKey: string | undefined;
};

/**
 * Default cookie reader using next/headers — only loaded inside the signIn
 * callback at request time. Tests inject a stub via authOptionsFactory.
 */
async function defaultCookieReader(): Promise<SignInCookieReader> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cookies } = await import("next/headers");
  // Some Next versions return a promise-shaped store; both shapes have .get()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store: any = await Promise.resolve(cookies());
  return {
    signedData: store?.get?.("signedData")?.value,
    publicKey: store?.get?.("publicKey")?.value,
  };
}

// ---------------------------------------------------------------------------
// signIn handler — wallet-signature gate + user/oauth upsert
// ---------------------------------------------------------------------------

export type SignInHandlerDeps = {
  cookieReader?: () => Promise<SignInCookieReader>;
  verifySignature?: typeof verifyWalletSignature;
  upsertUser?: typeof upsertUserByWallet;
  linkAccount?: typeof linkOAuthAccount;
};

export type SignInHandlerInput = {
  user: BellMarketsAuthUser;
  account: Account | null;
  profile?: ExtendedProfile;
};

export type SignInHandlerResult = {
  ok: boolean;
  walletPubkey?: string;
  userId?: string;
  reason?: string;
};

/**
 * Pure-ish signIn handler — extracted from the NextAuth callback so it can
 * be unit-tested without spinning NextAuth itself. The callback in
 * `bellMarketsAuthOptions` is a thin shell over this.
 */
export async function handleSignIn(
  input: SignInHandlerInput,
  deps: SignInHandlerDeps = {},
): Promise<SignInHandlerResult> {
  const { account, profile, user } = input;
  if (!account) {
    return { ok: false, reason: "no account on signIn payload" };
  }

  const provider = account.provider as Provider;
  if (provider !== "twitter" && provider !== "discord" && provider !== "google") {
    return { ok: false, reason: `unsupported provider: ${provider}` };
  }

  const cookieReader = deps.cookieReader ?? defaultCookieReader;
  const verifySig = deps.verifySignature ?? verifyWalletSignature;
  const upsertUser = deps.upsertUser ?? upsertUserByWallet;
  const linkAccount = deps.linkAccount ?? linkOAuthAccount;

  const { signedData, publicKey } = await cookieReader();
  if (!signedData || !publicKey) {
    return { ok: false, reason: "missing signedData/publicKey cookies" };
  }

  let walletPubkey: string;
  try {
    walletPubkey = await verifySig(signedData, publicKey, provider);
  } catch (err) {
    return { ok: false, reason: `signature verification failed: ${(err as Error).message}` };
  }

  const normalized = normalizeOAuthProfile(provider, user, profile);
  if (!normalized.providerUserId) {
    return { ok: false, reason: "provider returned no user id" };
  }

  let dbUser: User;
  try {
    dbUser = await upsertUser(walletPubkey, {
      email: normalized.email,
      avatarUrl: normalized.avatarUrl,
      handle: undefined, // handle is user-chosen; OAuth username is on oauth_accounts
      snsName: undefined,
    });
    await linkAccount(
      dbUser.id,
      normalized,
      account.refresh_token ?? undefined,
      account.expires_at ? new Date(account.expires_at * 1000) : undefined,
    );
  } catch (err) {
    return { ok: false, reason: `db write failed: ${(err as Error).message}` };
  }

  // Stash the DB id + walletPubkey on the NextAuth user so the jwt callback
  // can pick them up.
  user.id = dbUser.id;
  user.walletPubkey = walletPubkey;
  user.username = normalized.username;

  return { ok: true, walletPubkey, userId: dbUser.id };
}

// ---------------------------------------------------------------------------
// bellMarketsAuthOptions — what apps/web imports
// ---------------------------------------------------------------------------

/**
 * NextAuth v4 options for BellMarkets. Cleo imports + re-exports:
 *
 *   // apps/web/src/app/api/auth/[...nextauth]/route.ts
 *   import { bellMarketsAuthOptions } from "@bell-markets/automation/auth";
 *   import NextAuth from "next-auth";
 *   const handler = NextAuth(bellMarketsAuthOptions);
 *   export { handler as GET, handler as POST };
 *
 * Per fanalytics: JWT session strategy + custom signIn callback that writes
 * to Neon. No NextAuth adapter (the adapter would force a schema we don't
 * want).
 */
export const bellMarketsAuthOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: buildProviders(),
  callbacks: {
    async signIn({ user, account, profile }) {
      const result = await handleSignIn({
        user: user as BellMarketsAuthUser,
        account,
        profile: profile as ExtendedProfile | undefined,
      });
      if (!result.ok) {
        console.error("[auth] signIn rejected:", result.reason);
      }
      return result.ok;
    },
    async jwt({ token, user }) {
      if (user) {
        const extended = user as BellMarketsAuthUser;
        token.userId = extended.id;
        token.walletPubkey = extended.walletPubkey;
        token.username = extended.username;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const sessUser = session.user as BellMarketsAuthUser;
        sessUser.id = token.userId as string;
        sessUser.walletPubkey = token.walletPubkey as string | undefined;
        sessUser.username = token.username as string | undefined;
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      // Same auth_success param fanalytics uses to drive client-side toasts.
      if (url.startsWith(baseUrl) && url.includes("/api/auth/callback/")) {
        const provider = url.split("/").pop();
        const urlObj = new URL(url);
        const from = urlObj.searchParams.get("from") || "/";
        return `${baseUrl}${from}?auth_success=true&provider=${provider}`;
      }
      if (url.startsWith(baseUrl)) return url;
      return baseUrl;
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
  debug: process.env.NODE_ENV === "development",
};
