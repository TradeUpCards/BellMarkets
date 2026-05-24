"use client";

/**
 * Custom NextAuth sign-in page. Bram's `bellMarketsAuthOptions` sets
 * `pages.signIn: "/auth/signin"`, so this is where the OAuth landing happens.
 *
 * Wallet-link gate: per Bram's `handleSignIn`, the OAuth callback requires
 * `signedData` + `publicKey` cookies set by the wallet's `signMessage` call
 * before the provider redirect. This page surfaces a one-step link-wallet
 * button that signs the canonical "Link <provider> account" message and
 * stashes the cookies; then the OAuth redirect can succeed.
 */

import { Suspense, useEffect, useState } from "react";
import { signIn, getProviders, type ClientSafeProvider } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";

type Provider = ClientSafeProvider;

function SignInInner() {
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") ?? "/";
  const errorParam = params.get("error");

  const [providers, setProviders] = useState<Record<string, Provider> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(errorParam);

  const wallet = useWallet();

  useEffect(() => {
    getProviders().then((p) => setProviders(p));
  }, []);

  async function linkAndSignIn(providerId: string) {
    setErr(null);
    setBusy(providerId);
    try {
      if (!wallet.publicKey || !wallet.signMessage) {
        throw new Error("Connect a Solana wallet first.");
      }
      const message = new TextEncoder().encode(`Link ${providerId} account`);
      const sig = await wallet.signMessage(message);
      const signedData = bs58.encode(sig);
      const publicKey = wallet.publicKey.toBase58();

      // Stash the cookies that Bram's handleSignIn reads. SameSite=Lax is
      // required so the OAuth callback (cross-site redirect from Discord /
      // Google / Twitter) can still read them. NOT HttpOnly because we want
      // the cookie set from JS; secure handled by the OAuth flow itself.
      const maxAge = 60 * 10; // 10 min — short window for the OAuth round-trip
      document.cookie = `signedData=${encodeURIComponent(signedData)}; path=/; max-age=${maxAge}; samesite=lax`;
      document.cookie = `publicKey=${encodeURIComponent(publicKey)}; path=/; max-age=${maxAge}; samesite=lax`;

      await signIn(providerId, { callbackUrl });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const providerList = providers ? Object.values(providers) : [];

  return (
    <main style={{ maxWidth: 480, margin: "80px auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Sign in to Bell.Markets
      </h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 24 }}>
        Sign a message with your Solana wallet, then link a social account.
      </p>

      {!wallet.publicKey && (
        <p
          style={{
            fontSize: 13,
            padding: 12,
            border: "1px solid rgba(245,158,11,0.4)",
            background: "rgba(245,158,11,0.06)",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          Connect a wallet via the header before linking an OAuth account.
        </p>
      )}

      {err && (
        <p
          style={{
            fontSize: 13,
            padding: 12,
            border: "1px solid rgba(239,68,68,0.4)",
            background: "rgba(239,68,68,0.06)",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {err}
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {providerList.length === 0 && (
          <p style={{ fontSize: 13, opacity: 0.6 }}>
            No OAuth providers are configured on this deployment. Set
            DISCORD_CLIENT_ID / GOOGLE_CLIENT_ID / TWITTER_CLIENT_ID env
            vars to enable provider buttons.
          </p>
        )}
        {providerList.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!wallet.publicKey || busy !== null}
            onClick={() => linkAndSignIn(p.id)}
            style={{
              padding: "10px 14px",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              background: "rgba(255,255,255,0.04)",
              color: "inherit",
              cursor: wallet.publicKey ? "pointer" : "not-allowed",
              fontSize: 14,
              textAlign: "left",
            }}
          >
            {busy === p.id ? `Signing in with ${p.name}…` : `Continue with ${p.name}`}
          </button>
        ))}
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInInner />
    </Suspense>
  );
}
