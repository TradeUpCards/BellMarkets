# BellMarkets — 3 min Demo

---

## What it is

# 0DTE binary options on MAG7, settled on-chain by Pyth

- *"Will [STOCK] close above [PRICE] today?"*
- One contract per (ticker, strike) — minted ~8 AM ET, dies at the 4 PM ET close
- YES + NO SPL tokens, sum-to-$1 invariant
- On-chain Pyth read at 4:05 PM ET decides the outcome — permissionless caller, no admin sign-off

---

## Stack — onchain

# Solana devnet · Anchor 0.31 program / 0.30 JS client

- **Single Anchor program** owns config, markets, vault, order book
- **In-program CLOB** (DR-020) — bids/asks held in a zero-copy account; no Phoenix dependency for the demo
- **Non-custodial vault** — no `withdraw_to_admin` instruction exists, mechanically enforced (DR-017)
- **Permissionless settlement caller** — anyone can poke `settle_market` after expiry; the program checks Pyth confidence + staleness (DR-002)

---

## Stack — providers

# Pyth · Helius · Vercel · Neon

- **Pyth Hermes** → live underlying price (proxied through `/api/spot/[ticker]`, edge-cached 3s)
- **Pyth on-chain feeds** → settlement source of truth
- **Helius RPC** → Solana reads/writes (standard tier — drove the `getMultipleAccountsInfo` design)
- **Vercel** → Next.js 14 frontend
- **Neon Postgres** → off-chain user/billing state for Bell Pro tier (DR-014)
- **Helio** → USDC subscription rail for Bell Pro

---

## Notable design calls

# Made for a trading-firm audience

- **Anchor version split (DR-004)** — program on 0.31, client on 0.30 to dodge a known IDL-decode regression
- **Fee tiers + creator rebates (DR-008)** — mint-volume-weighted; on-chain in `UserConfig`
- **Force-redeem after settle grace (DR-008)** — unredeemed YES/NO can be force-burned by anyone after the window, recovers vault rent
- **Cron failure ≠ market failure (DR-002)** — Trigger.dev runs nudgers, not authorities; settlement is permissionless

---

## Demo flow

# What you're about to see

1. **Matrix** — 7 MAG7 tickers × 7 strikes around ATM. Real PDAs read live via `getMultipleAccountsInfo` over a hardcoded registry (production path: Neon-backed registry + backend GPA sync)
   - *Note: demo strikes are seeded with a Fri 5/29 expiry so they don't die mid-recording — production is 0DTE*
2. **Trade page** — live Pyth Hermes spot in the chart, in-program order book on the right, position card bottom-left
3. **Buy 17 YES on META $639** — single tx: mint_pair + IOC buy against the book; vault + ATAs update in one round-trip
4. **Position updates** — WebSocket → 5s HTTP polling fallback (Vercel serverless doesn't support WS upgrades)
5. **Settle preview** — admin page shows the `settle_market` path; Pyth feed read on-chain at call time

---

## What's deferred

# Honest about the gap

- **WS subscriptions in prod** → Cloudflare Workers or Fly.io proxy (Helius key can't ship in `NEXT_PUBLIC_*`)
- **Market discovery in prod** → backend job syncs `getProgramAccounts` to Neon, client reads Neon
- **Phoenix CLOB upgrade** → in-program book is fine for demo volume; Phoenix is the v1.1 path

---

# Thanks — questions?
