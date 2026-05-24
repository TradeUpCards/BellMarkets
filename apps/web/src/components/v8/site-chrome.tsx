"use client";

/**
 * v8 site chrome — top-status bar + sticky header + (mobile) bottom tabs.
 *
 * Visual reference: `apps/web/public/mockups/v8-trade.html` + `v8-landing.html`.
 * Both pages share this chrome; per-page nav active state passed via prop.
 *
 * The header surfaces (left-to-right):
 *   - Brand mark + wordmark linking home
 *   - Vertical divider
 *   - Main nav (Markets / Trade / Positions / Orders / History)
 *   - Centered search bar (cmd-K affordance)
 *   - Right cluster: session module, notifications icon, theme toggle, Go-Pro
 *     CTA, Connect-Wallet button
 *
 * Wallet connection comes from `@solana/wallet-adapter-react-ui`'s
 * `WalletMultiButton` (dynamic-imported to dodge SSR rendering).
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";

const WalletMultiButton = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

export type ActiveNav = "markets" | "trade" | "positions" | "orders" | "history";

export interface SiteChromeProps {
  active: ActiveNav;
  /** Optional override of the top-status SETTLE countdown label. */
  settleCountdown?: string;
}

const NAV: Array<{ key: ActiveNav; href: string; label: string }> = [
  { key: "markets", href: "/", label: "Markets" },
  { key: "trade", href: "/trade/META/680", label: "Trade" },
  { key: "positions", href: "/portfolio", label: "Positions" },
  { key: "orders", href: "/portfolio?tab=orders", label: "Orders" },
  { key: "history", href: "/history", label: "History" },
];

function nowEt(): string {
  // Use America/New_York for the ET label — Solana cluster time + market hours
  // both anchor to ET. Locale "en-US" gives the 24h-ish formatted version.
  const d = new Date();
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }) + " ET";
}

export function TopStatusBar({ settleCountdown = "02:13:47" }: { settleCountdown?: string }) {
  const [tickEt, setTickEt] = useState<string>("");
  useEffect(() => {
    setTickEt(nowEt());
    const id = window.setInterval(() => setTickEt(nowEt()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="top-status">
      <div><span className="pulse" /><span className="label">CONN</span><span className="val green">DEVNET</span></div>
      <div><span className="label">PYTH</span><span className="val green">FRESH</span></div>
      <div><span className="label">PROG</span><span className="val">599h7V…kS7uV</span></div>
      <div><span className="label">CFG</span><span className="val">6CYzWh…ev9gQ</span></div>
      <div><span className="label">SETTLE</span><span className="val amber">{settleCountdown}</span></div>
      <div style={{ marginLeft: "auto" }}>
        <span className="label">TIME</span>
        <span className="val">{tickEt || "—"}</span>
      </div>
    </div>
  );
}

export function SiteHeader({ active }: { active: ActiveNav }) {
  const wallet = useWallet();
  const walletShort = wallet.publicKey
    ? `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}`
    : null;

  const toggleTheme = () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    if (next === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try { localStorage.setItem("bm-theme", next); } catch {}
  };

  return (
    <header className="top">
      <div className="header-inner">
        <div className="brand">
          <Link href="/" className="logo" aria-label="Bell.Markets home">
            <span className="logo-mark" aria-hidden="true" />
            <span>Bell<span className="label">.Markets</span></span>
          </Link>
          <span className="brand-divider" aria-hidden="true" />
          <nav className="nav" aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={active === item.key ? "active" : ""}
                aria-current={active === item.key ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="searchbar">
          <span className="searchbar-icon">⌕</span>
          <input
            type="text"
            placeholder="Switch market — META.680 / NVDA.1340 / search..."
          />
          <span className="searchbar-kbd">⌘K</span>
        </div>
        <div className="header-right">
          <button className="session-module" aria-label="Session: market open" type="button">
            <span className="session-pulse" aria-hidden="true" />
            <span>
              <span className="session-status">OPEN</span>
              <span className="session-time"> · MAG7</span>
            </span>
            <span className="session-expand" aria-hidden="true">⌃</span>
          </button>
          <button className="icon-btn" aria-label="Notifications" title="Notifications" type="button">🔔</button>
          <button className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme" type="button">◐</button>
          <Link href="#pro" className="go-pro-btn" title="Bell Pro · AI briefings + analytics">
            <span aria-hidden="true">✦</span>
            <span>Go Pro</span>
          </Link>
          {walletShort ? (
            <button className="connect-btn" type="button" aria-label={`Wallet ${walletShort}`}>
              <span style={{ fontSize: 14 }} aria-hidden="true">⬢</span>
              <span>{walletShort}</span>
            </button>
          ) : (
            <WalletMultiButton className="connect-btn" />
          )}
        </div>
      </div>
    </header>
  );
}

export function MobileBottomTabs({ active }: { active: ActiveNav }) {
  return (
    <nav className="bottom-tabs" aria-label="Mobile navigation">
      <Link href="/" className={`bottom-tab${active === "markets" ? " active" : ""}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
        Markets
      </Link>
      <Link href="/trade/META/680" className={`bottom-tab${active === "trade" ? " active" : ""}`} aria-current={active === "trade" ? "page" : undefined}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 17l6-6 4 4 8-8" /><path d="M17 7h4v4" /></svg>
        Trade
      </Link>
      <Link href="/portfolio" className={`bottom-tab${active === "positions" ? " active" : ""}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 12h8M12 8v8" /></svg>
        Positions
      </Link>
      <Link href="/auth/signin" className={`bottom-tab${active === "orders" ? " active" : ""}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" /></svg>
        Profile
      </Link>
    </nav>
  );
}

export function SiteChrome({
  active,
  children,
  settleCountdown,
}: {
  active: ActiveNav;
  children: ReactNode;
  settleCountdown?: string;
}) {
  return (
    <>
      <TopStatusBar settleCountdown={settleCountdown} />
      <SiteHeader active={active} />
      {children}
      <MobileBottomTabs active={active} />
    </>
  );
}
