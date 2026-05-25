"use client";

/**
 * User menu — replaces the default wallet-adapter `WalletMultiButton`.
 *
 * Pre-connect: a single "Connect Wallet" CTA that opens the wallet-adapter
 * modal (programmatically via `useWalletModal`).
 *
 * Post-connect: a chip showing the truncated pubkey + wallet name. Click
 * opens a Radix dropdown with:
 *   - Wallet card (name + pubkey + copy + Solana Explorer link)
 *   - Linked socials (Discord / Google / Twitter) with link/unlink CTAs
 *     driven by `useSocialLinks` + NextAuth `signIn(provider)`
 *   - Bell Pro tier badge (`useBellProSubscription` + `isBellProActive`)
 *   - Settings + Disconnect Wallet + Sign out (when signed in)
 *
 * Matches the fanalytics dual-identity dropdown pattern. The wallet-adapter
 * default dropdown is generic-looking and doesn't expose the social-link
 * surface; this surfaces both identities cleanly.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { signIn, signOut, useSession } from "next-auth/react";

import {
  isBellProActive,
  useBellProSubscription,
} from "@/hooks/use-bell-pro-subscription";
import { useSocialLinks } from "@/hooks/use-social-links";
import type { SocialProvider } from "@/types/profile";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  discord: "Discord",
  google: "Google",
  twitter: "X / Twitter",
};

const PROVIDER_ICON: Record<SocialProvider, string> = {
  discord: "🎮",
  google: "G",
  twitter: "𝕏",
};

function fmtPubkey(s: string): string {
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function ProviderRow({
  provider,
  linkedUsername,
  walletConnected,
  onUnlink,
}: {
  provider: SocialProvider;
  linkedUsername: string | null;
  walletConnected: boolean;
  onUnlink: () => void;
}) {
  const linked = linkedUsername !== undefined && linkedUsername !== null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        fontSize: 12,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(255,255,255,0.06)",
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        {PROVIDER_ICON[provider]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500 }}>{PROVIDER_LABEL[provider]}</div>
        <div
          style={{
            fontSize: 11,
            opacity: 0.6,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {linked ? linkedUsername : "Not linked"}
        </div>
      </div>
      {linked ? (
        <button
          type="button"
          onClick={onUnlink}
          style={{
            fontSize: 11,
            padding: "4px 8px",
            background: "transparent",
            color: "var(--text-muted, #9aa3b2)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Unlink
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (!walletConnected) {
              alert("Connect a wallet first — social links bind to your wallet pubkey.");
              return;
            }
            void signIn(provider);
          }}
          style={{
            fontSize: 11,
            padding: "4px 8px",
            background: "var(--accent, #22d3ee)",
            color: "black",
            border: "none",
            borderRadius: 4,
            cursor: walletConnected ? "pointer" : "not-allowed",
            opacity: walletConnected ? 1 : 0.5,
          }}
        >
          Link
        </button>
      )}
    </div>
  );
}

export function UserMenu() {
  const wallet = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { data: session } = useSession();
  const { data: sub } = useBellProSubscription();
  const proActive = isBellProActive(sub);
  const { links, unlink } = useSocialLinks();

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on route change is implicit because the dropdown isn't portaled
  // out of the header — navigation unmounts it.

  const linkedByProvider = useMemo(() => {
    const m: Partial<Record<SocialProvider, string | null>> = {};
    for (const l of links) m[l.provider] = l.username;
    return m;
  }, [links]);

  const pubkey = wallet.publicKey?.toBase58() ?? null;
  const walletName = wallet.wallet?.adapter.name ?? "Wallet";

  // ── Pre-connect state ─────────────────────────────────────────────────
  if (!pubkey) {
    return (
      <button
        type="button"
        className="connect-btn"
        onClick={() => setWalletModalVisible(true)}
        style={{
          padding: "8px 14px",
          background: "var(--accent, #22d3ee)",
          color: "black",
          border: "none",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          letterSpacing: "0.02em",
        }}
      >
        Connect Wallet
      </button>
    );
  }

  // ── Post-connect chip + dropdown ──────────────────────────────────────
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="connect-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          padding: "6px 10px 6px 8px",
          background: "rgba(255,255,255,0.04)",
          color: "inherit",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 6,
          fontSize: 12,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-mono, ui-monospace)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 18,
            height: 18,
            background:
              "linear-gradient(135deg, var(--accent, #22d3ee), var(--violet, #8b5cf6))",
            borderRadius: 4,
            display: "inline-block",
          }}
        />
        <span>{fmtPubkey(pubkey)}</span>
        {proActive && (
          <span
            style={{
              fontSize: 9,
              padding: "1px 4px",
              borderRadius: 3,
              background: "rgba(34, 211, 238, 0.18)",
              color: "var(--accent, #22d3ee)",
              fontFamily: "var(--font-sans, system-ui)",
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            PRO
          </span>
        )}
        <span aria-hidden style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 320,
            background: "var(--panel, #0f141e)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.6)",
            zIndex: 1000,
            overflow: "hidden",
          }}
        >
          {/* Wallet card */}
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div
              aria-hidden
              style={{
                width: 36,
                height: 36,
                background:
                  "linear-gradient(135deg, var(--accent, #22d3ee), var(--violet, #8b5cf6))",
                borderRadius: 6,
                flex: "0 0 36px",
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{walletName}</div>
              <div
                style={{
                  fontSize: 11,
                  opacity: 0.6,
                  fontFamily: "var(--font-mono, ui-monospace)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={pubkey}
              >
                {pubkey}
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(pubkey);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch {
                  /* clipboard blocked — silently no-op */
                }
              }}
              title="Copy pubkey"
              style={{
                fontSize: 11,
                padding: "4px 8px",
                background: "transparent",
                color: "var(--text-muted, #9aa3b2)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {copied ? "✓" : "Copy"}
            </button>
          </div>

          {/* Bell Pro tier */}
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 12,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 22,
                height: 22,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(34, 211, 238, 0.12)",
                color: "var(--accent, #22d3ee)",
                borderRadius: 4,
              }}
            >
              ✦
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>Bell Pro</div>
              <div style={{ fontSize: 11, opacity: 0.6 }}>
                {proActive ? "Active subscription" : "9 bUSDC/mo for AI briefings"}
              </div>
            </div>
            {proActive ? (
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 3,
                  background: "rgba(34, 211, 238, 0.18)",
                  color: "var(--accent, #22d3ee)",
                  fontWeight: 600,
                }}
              >
                ACTIVE
              </span>
            ) : (
              <Link
                href="/settings#billing"
                onClick={() => setOpen(false)}
                style={{
                  fontSize: 11,
                  padding: "4px 8px",
                  background: "var(--accent, #22d3ee)",
                  color: "black",
                  textDecoration: "none",
                  borderRadius: 4,
                  fontWeight: 600,
                }}
              >
                Upgrade
              </Link>
            )}
          </div>

          {/* Linked socials */}
          <div
            style={{
              padding: "6px 0",
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div
              style={{
                padding: "4px 12px",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                opacity: 0.5,
              }}
            >
              Linked accounts
            </div>
            {(["discord", "google", "twitter"] as const).map((p) => (
              <ProviderRow
                key={p}
                provider={p}
                linkedUsername={linkedByProvider[p] ?? null}
                walletConnected={!!pubkey}
                onUnlink={() => unlink.mutate(p)}
              />
            ))}
            {session?.user && (
              <div
                style={{
                  fontSize: 10,
                  padding: "4px 12px 8px",
                  opacity: 0.5,
                  fontStyle: "italic",
                }}
              >
                Session: {session.user.name ?? session.user.email ?? "signed in"}
              </div>
            )}
          </div>

          {/* Actions */}
          <div>
            <Link
              href="/settings"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "10px 12px",
                fontSize: 12,
                color: "inherit",
                textDecoration: "none",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}
            >
              Settings
            </Link>
            <Link
              href="/portfolio"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "10px 12px",
                fontSize: 12,
                color: "inherit",
                textDecoration: "none",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}
            >
              My positions
            </Link>
            {session?.user && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void signOut();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "10px 12px",
                  fontSize: 12,
                  textAlign: "left",
                  color: "inherit",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  cursor: "pointer",
                }}
              >
                Sign out (session)
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                setOpen(false);
                try {
                  await wallet.disconnect();
                } catch {
                  /* disconnect can throw on some adapters; surface no-op */
                }
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 12px",
                fontSize: 12,
                textAlign: "left",
                color: "var(--no, #ef4444)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              Disconnect wallet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
