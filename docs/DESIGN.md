# BellMarkets — Frontend Design Direction

> **Bar:** This is a trading platform demo. The visual language is **load-bearing** for grader perception. Generic NextJS/shadcn-default look is a graded weakness for a project whose product is a trading interface.
>
> **Audience:** Gauntlet evaluators + hiring partner reviewers. Many of them have seen 50+ cohort projects. The 5% of projects that look distinctive and professional get remembered. We're aiming for that 5%.
>
> **Owned by:** Cleo (`apps/web/**`, `packages/ui/**`).
> **Updated by:** Tate via MR; lead negotiation thread in `.project/bell-markets/coordination/` first.

---

## What we're trying to look like

A serious on-chain trading platform — not a marketing site, not a generic dashboard, not a consumer-friendly fintech app. Power-user information density, monospace numerics, dark mode default, color semantics borrowed from established trading conventions.

A reviewer landing on `/` should immediately read it as "this team understands what a trading platform looks like" — *before* they read any code.

---

## Reference sites (study these)

### Direct functional analogs (binary outcome markets)

| Site | What to study |
|---|---|
| **Polymarket** (polymarket.com) | Closest functional cousin. Yes/No button hierarchy, probability display, market card layouts, position display with P&L. They've spent millions on this exact shape — learn from it. |
| **Limitless Exchange** (limitless.exchange) | Newer binary markets on Base. Very clean modern design language. Recent (2025) shadcn-adjacent aesthetic done right. |
| **PRJX / Prophet Markets** | Prediction markets on Solana. Similar visual language to where we're going. |

### Solana DeFi / on-chain trading

| Site | What to study |
|---|---|
| **Drift Protocol** (drift.trade) | Our chain, our crank-style architecture. Best reference for Solana DeFi visual language. Dark mode default, monospace numbers, dense order book, position monitor. |
| **Phoenix** (phoenix.trade) | **Our CLOB.** Studying their UI keeps us visually coherent with the matching engine we integrated. Their app is a strong reference for the order-book column specifically. |
| **Hyperliquid** (app.hyperliquid.xyz) | Set the bar for fast, tight on-chain trading UX. Information density without clutter. Subtle yellow-green accent color done well. |
| **Jupiter Perps** (jup.ag/perps) | Recent Solana perps UI; clean. |

### Trading-platform polish (steal patterns)

| Site | What to study |
|---|---|
| **dYdX v4** | Institutional feel; very polished order book + position monitor + trade panel. |
| **Binance Futures** | Dense but functional. Information density gold standard. |
| **TradingView** | Gold standard for charting + data density. Don't copy their chart engine (out of scope) but borrow visual hierarchy + how they treat numerical data. |

### What NOT to look like

- **Robinhood** — too consumer-friendly; positions BellMarkets as a toy. Avoid the gradient hero / "friendly" treatment.
- **Generic shadcn dashboards** — default shadcn looks fine but reads as "AI-generated React project." We need to push beyond defaults.
- **DeFi protocols with marketing-first pages** — loud gradients, hero images, scroll animations. Wrong genre.
- **Mobile-first responsive consumer apps** — we are desktop-first. Mobile is out of scope per `specs/deferred.md`.

---

## Design patterns to adopt

### Color + theme

- **Dark mode default, never offer light.** Black bg (`#0a0a0a` or `#000`), near-black panels (`#0f0f0f`-`#141414`), white-on-grey text, accents only on actionable elements.
- **Trading color semantics:**
  - **Green** = Yes / bullish / win / profit. Use a green that reads "money green" (e.g., `#10b981`, `#22c55e`, or Polymarket-style). NOT a neutral green.
  - **Red** = No / bearish / loss. Specifically `#ef4444` or similar; matches Polymarket/Drift.
  - **Amber** = pending / settling / partial fill. `#f59e0b`.
  - **Neutral grey** = informational, not actionable.
- **Brand accent:** pick ONE strong accent (suggest electric blue `#3b82f6` or violet `#8b5cf6` or Hyperliquid-style yellow-green `#bef264`). Used for: brand mark, link hover, focus rings. Never use for trade actions (those are red/green).
- **No gradients** on functional UI elements (buttons, panels, headers). Gradients are fine for the brand mark only.

### Typography

- **Sans body:** Inter (already installed) or Geist Sans. Used for marketing text, navigation, labels.
- **Mono numerics:** JetBrains Mono (already installed). Used for **all prices, sizes, balances, P&L, timestamps**. Tabular alignment matters.
- **Heading hierarchy:** restrained. Don't use h1/h2 like a marketing site. Most "headings" in trading UIs are small caps labels (e.g., "ORDER BOOK" in 10px tracking-wide grey).

### Layout primitives

- **Information density > whitespace.** Trading users scan, they don't read. Pack data tightly.
- **Tabular layouts** with monospace numbers and fixed-width columns. Strikes, sizes, prices, P&L all in tables.
- **Side panels over modals** for the order ticket. Side panel = always visible, no friction. Modal = one extra click per trade = degens hate it (already a Hard NO).
- **Sticky position monitor** at bottom OR right rail. Live P&L always visible.
- **Order book with depth visualization.** Bid/ask price levels with bars showing relative size. Polymarket/Drift/Phoenix all do this. Communicates liquidity at a glance.

### Component-specific patterns

#### `/markets` page (grid of 7 stocks)

- Compact cards with: ticker, current spot price, today's range, settlement countdown, 3-5 strike rows with implied probabilities (Yes price = probability).
- Hover state previews the order book depth.
- Sort by: ticker, volume, time-to-settle.

#### `/trade/[ticker]/[strike]` page (load-bearing UI)

- **Three-column layout**: order book (left) | trade panel (center) | position monitor (right).
- Order book: 5-10 levels each side, depth bars, last-trade indicator with subtle animation.
- Trade panel: **4 huge action buttons**, color-coded:
  - `Buy Yes` (green) / `Sell Yes` (green outline)
  - `Buy No` (red) / `Sell No` (red outline)
  - Size input + price input (limit) above the buttons.
  - Payoff display: "Pay $0.64 → Win $1.00 if META closes above $680" — always visible, updates as user types.
- Settlement countdown: prominent, mm:ss when < 1hr.

#### `/portfolio` page

- Table of open positions: market, side (Yes/No), size, entry price, current price, unrealized P&L, settles-in countdown.
- Row click → opens detail drawer with full trade history for that position.
- "Redeem all" button at top for settled winners.

#### Header

- Logo (wordmark only, monospace, no icon).
- Network status pill: "🟢 Devnet" or "🔴 RPC disconnected".
- Pyth oracle status pill: "🟢 Pyth: fresh" or "🟡 Pyth: stale".
- Wallet: address truncated `4aPZ...G2iy` + balance `123.45 USDC` + dropdown for disconnect.
- All header elements monospace.

### Motion

- **Subtle, purposeful, never decorative.**
- Price updates: brief background flash (green for tick up, red for tick down). Polymarket-style. ~150ms.
- Fill animation: order disappears from book, position card pulses briefly.
- Connection loss: header status pill turns red + brief shake.
- **No:** scroll animations, gradient sweeps, particle effects, hero-section motion, fade-in on initial load.

### Iconography

- **Lucide icons** (shadcn default — fine) for nav + utility.
- **Custom emoji or unicode for trade actions:** `▲` Buy Yes, `▼` Buy No can replace text on tight mobile widths.
- Avoid heavy iconography in primary UI. Trading is about text + numbers, not icons.

---

## Branding decisions to lock

| Decision | Recommendation | Defense |
|---|---|---|
| Logo / wordmark | Wordmark only: `BellMarkets` or `BM` in JetBrains Mono | Trading platforms favor wordmarks (Polymarket, Hyperliquid, dYdX). No icon = no "AI-generated logo" tell. |
| Brand accent color | Electric violet `#8b5cf6` (suggested) | Distinct from green (Yes) and red (No); high contrast on black; reads "modern DeFi" without copying any specific competitor. **Cleo can override** if she has a stronger candidate. |
| Font primary | Geist Sans (already shadcn default in apps/web) | Modern, neutral, doesn't feel like Inter-default-look. |
| Font numerics | JetBrains Mono (already installed) | Universal trading-app convention. |
| Dark mode | Default and only. No light mode toggle. | Trading apps are universally dark. Toggle = wasted UI surface. |

---

## What success looks like

A grader who visits the deployed frontend should be able to identify, within 5 seconds, that this is a trading platform — not a generic dApp. Specifically, they should see:

- Dark theme with monospace numerics
- An order book with depth visualization
- Yes/No semantics with green/red color coding
- A live settlement countdown
- Their wallet address + USDC balance in the header
- Network + oracle health pills

They should NOT see:

- A marketing-style hero section
- Big "Get Started" / "Learn More" CTAs (we're not a SaaS)
- Light mode (or even a toggle for it)
- Generic card-based grid that could be any dashboard
- Loading spinners (skeleton states only)

---

## How Cleo executes this on Day 2-3

Priority order, per the Gantt:

1. **Day 2 PM (Fri 5/22 afternoon):** Trade panel UI with the 4-button atomic layout. **This is the load-bearing surface — get the visual language right here first.**
2. **Day 2 evening:** Order book column with depth visualization.
3. **Day 3 AM (Sat 5/23):** Markets grid + portfolio page.
4. **Day 3 PM:** Settlement countdown, redeem flow, header polish (network + oracle pills, wallet display).
5. **Day 3 evening:** Spot-polish pass — anywhere the UI still reads as "generic NextJS scaffold," fix it.

**The polish pass is the difference between top-decile and mid-decile cohort projects.** Treat it as feature work, not as decoration.

---

## When to RAISE

- If a reference site does something we can't replicate in 3 days (e.g., TradingView-level charting) — RAISE so we either defer it formally (`specs/deferred.md`) or simplify the scope.
- If a Hard rule conflicts with a design pattern (e.g., the "no polling" Hard YES #9 conflicts with how some reference sites do real-time updates) — RAISE; we resolve via the WebSocket subscription path, not by relaxing the rule.
- If the design direction reveals a missing PRD requirement — RAISE; missing UX surfaces become deferral entries.

---

> **Update protocol:** Tate edits via MR. Cleo can RAISE design issues in `.project/bell-markets/coordination/design-<topic>.md` for negotiation. Major direction shifts require a new MR with `design-change` label.
>
> **Created:** 2026-05-21 (Day 1 evening)
> **Last updated:** 2026-05-21
