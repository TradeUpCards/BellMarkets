/**
 * NextAuth v4 configuration for BellMarkets (DR-014).
 *
 * Provider strategy:
 *  - Discord (OAuth2; `identify email` scope).
 *  - Google (OIDC; `openid email profile` scope).
 *  - Twitter / X (OAuth 2.0 free tier; identity-only).
 *
 * Each provider is loaded only when its env credentials are present so the
 * dev experience stays clean when only one provider is wired (Tate's advice:
 * verify Discord first — fewest gotchas).
 *
 * Session strategy: JWT (matches the fffanalytics_t3 reference; avoids the
 * Neon-session-row lookup until DR-014's account-link table lands).
 *
 * Wallet-link flow (per fffanalytics_t3 reference):
 *   1. Client signs `Link <provider> account` via wallet-adapter `signMessage`.
 *   2. Client sets cookies `signedData` (base58 sig) + `publicKey` (base58 pubkey).
 *   3. Client calls `signIn('discord' | 'google' | 'twitter')`.
 *   4. OAuth callback hits `signIn` callback below — we read cookies, verify
 *      the signature against `Link <provider> account`, then upsert a row in
 *      Neon mapping `(wallet_pubkey, provider, provider_id)`.
 *
 * The Neon upsert is stubbed (`createUserOrUpdateSocial`) until Bram's schema
 * lands; the stub logs a no-op so the OAuth round-trip itself works
 * end-to-end. **No PII (email, handle) is written to logs in production** —
 * the stub is debug-level only.
 */

import type { NextAuthOptions, User } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import DiscordProvider from "next-auth/providers/discord";
import GoogleProvider from "next-auth/providers/google";
import TwitterProvider from "next-auth/providers/twitter";

import { cookies } from "next/headers";

import { createUserOrUpdateSocial } from "./social-actions";
import { verifyWalletSignature } from "./verify-wallet-signature";

interface ExtendedProfile {
  id?: string;
  username?: string;
  email?: string | null;
  image_url?: string | null;
  global_name?: string | null;
  profile_image_url?: string | null;
  name?: string | null;
}

interface ExtendedUser extends User {
  username?: string;
}

function getProviders(): OAuthConfig<unknown>[] {
  const providers: OAuthConfig<unknown>[] = [];

  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    providers.push(
      DiscordProvider({
        clientId: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        authorization: { params: { scope: "identify email" } },
      }) as OAuthConfig<unknown>,
    );
  }

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        authorization: {
          params: { scope: "openid email profile" },
        },
      }) as OAuthConfig<unknown>,
    );
  }

  if (process.env.TWITTER_CLIENT_ID && process.env.TWITTER_CLIENT_SECRET) {
    providers.push(
      TwitterProvider({
        clientId: process.env.TWITTER_CLIENT_ID,
        clientSecret: process.env.TWITTER_CLIENT_SECRET,
        version: "2.0",
        async profile(rawProfile: unknown) {
          const p = rawProfile as {
            data?: {
              id?: string;
              name?: string;
              profile_image_url?: string;
              username?: string;
            };
          };
          return {
            id: p.data?.id ?? "",
            name: p.data?.name ?? null,
            image: p.data?.profile_image_url ?? null,
            username: p.data?.username,
          } as User;
        },
      }) as unknown as OAuthConfig<unknown>,
    );
  }

  return providers;
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  providers: getProviders(),
  callbacks: {
    async signIn({ user, account, profile }) {
      if (!account?.provider) return false;
      // For now, OAuth flow proceeds even without a linked wallet — the
      // wallet-linkage cookie pattern is only enforced once we have a way
      // to render a "link your wallet" step. This is the DR-014-staged
      // behavior; Bram's schema landing will harden this to "link required."
      try {
        const cookieStore = cookies();
        const signedData = cookieStore.get("signedData")?.value;
        const publicKey = cookieStore.get("publicKey")?.value;

        let walletAddress: string | null = null;
        if (signedData && publicKey) {
          walletAddress = verifyWalletSignature(
            signedData,
            publicKey,
            account.provider,
          );
        }

        const extendedProfile = (profile ?? {}) as ExtendedProfile;
        const extendedUser = user as ExtendedUser;

        await createUserOrUpdateSocial(
          {
            provider: account.provider,
            providerId: extendedUser.id,
            username:
              extendedUser.username ?? extendedUser.name ?? extendedProfile.username,
            displayName:
              extendedProfile.global_name ?? extendedUser.name ?? null,
            email: extendedProfile.email ?? extendedUser.email ?? null,
            avatarUrl:
              extendedProfile.profile_image_url ??
              extendedProfile.image_url ??
              extendedUser.image ??
              null,
          },
          walletAddress,
        );

        return true;
      } catch (err) {
        // Don't leak PII into the error log. Just enough to triage.
        console.error("NextAuth signIn callback failed", {
          provider: account.provider,
          err: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
    async redirect({ url, baseUrl }) {
      // Preserve any callback-specified `from` query param so the user lands
      // back where they initiated the sign-in (matches fffanalytics_t3).
      if (url.startsWith(baseUrl) && url.includes("/api/auth/callback/")) {
        try {
          const provider = url.split("/").pop();
          const urlObj = new URL(url);
          const from = urlObj.searchParams.get("from") ?? "/";
          return `${baseUrl}${from}?auth_success=true&provider=${provider}`;
        } catch {
          return baseUrl;
        }
      }
      if (url.startsWith(baseUrl)) return url;
      return baseUrl;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.username = (user as ExtendedUser).username;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as ExtendedUser).id = token.id as string;
        (session.user as ExtendedUser).username = token.username as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
  debug: process.env.NODE_ENV === "development",
};
