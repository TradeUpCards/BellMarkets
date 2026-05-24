"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { signIn } from "next-auth/react";
import bs58 from "bs58";

import { linkMessage } from "@/lib/auth/verify-wallet-signature";

export type LinkProvider = "discord" | "google" | "twitter";

export interface LinkSignInState {
  signingIn: boolean;
  error: string | null;
}

/**
 * Drive the DR-014 "link a social to my wallet" flow:
 *
 *   1. User has a wallet connected (wallet-adapter `publicKey` non-null).
 *   2. Wallet signs `Link <provider> account` via `signMessage`.
 *   3. We drop `signedData` + `publicKey` cookies (so the NextAuth `signIn`
 *      callback can verify the wallet ownership on the server side).
 *   4. `signIn(provider, { callbackUrl })` launches the OAuth flow.
 *
 * If the wallet doesn't support `signMessage` (Ledger via wallet-adapter,
 * for instance), the flow still proceeds — the server callback just sees
 * an "unlinked" OAuth identity. That's acceptable during DR-014 staging;
 * once Bram's schema enforces wallet-linkage, this falls back to an error.
 */
export function useLinkSignIn() {
  const wallet = useWallet();
  const [state, setState] = useState<LinkSignInState>({
    signingIn: false,
    error: null,
  });

  const start = useCallback(
    async (provider: LinkProvider, callbackUrl: string = "/") => {
      setState({ signingIn: true, error: null });
      try {
        if (wallet.publicKey && wallet.signMessage) {
          const msg = new TextEncoder().encode(linkMessage(provider));
          const signature = await wallet.signMessage(msg);
          // Same-origin, JS-readable cookies — NextAuth's signIn callback
          // reads them via next/headers `cookies()`. `SameSite=Lax` keeps
          // them on the redirect chain through the OAuth provider.
          setLinkCookies(
            bs58.encode(signature),
            wallet.publicKey.toBase58(),
          );
        }
        await signIn(provider, { callbackUrl });
      } catch (err) {
        setState({
          signingIn: false,
          error: err instanceof Error ? err.message : "Sign-in failed.",
        });
      }
    },
    [wallet.publicKey, wallet.signMessage],
  );

  return { ...state, start, walletConnected: !!wallet.publicKey };
}

const LINK_COOKIE_TTL_SECONDS = 5 * 60; // 5 minutes — round-trip well over.

function setLinkCookies(signedDataB58: string, pubkeyB58: string) {
  if (typeof document === "undefined") return;
  const maxAge = `Max-Age=${LINK_COOKIE_TTL_SECONDS}`;
  // SameSite=Lax so the cookie survives the OAuth redirect chain back to
  // our callback. Secure when served over HTTPS (set by browser).
  document.cookie = `signedData=${signedDataB58}; Path=/; ${maxAge}; SameSite=Lax`;
  document.cookie = `publicKey=${pubkeyB58}; Path=/; ${maxAge}; SameSite=Lax`;
}
