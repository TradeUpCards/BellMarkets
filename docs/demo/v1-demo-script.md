# BellMarkets v1 Demo Script

**Target:** Sun 2026-05-25 5:00 PM ET (Gauntlet cohort submission)
**Owner:** Drew (script) + presenter TBD (probably Cory or Tate)
**Length:** 3-5 minutes (target 4:00)
**Format:** Live walkthrough preferred; pre-recorded backup at `docs/demo/recording-assets/v1-demo.mp4` (TODO Sat night)

**Pair with:**
- `docs/demo/cron-failure-path.md` — HY-5 evidence (run as Q&A response if asked)
- `docs/architecture/pre-mainnet-readiness.md` — security narrative + v2 gaps (reference for "what's next" questions)
- `scripts/one-command-demo.sh` — show in terminal if reviewer asks to verify lifecycle locally

---

## Pre-flight (30 min before demo start)

### Environment
- [ ] Solana devnet RPC is responsive: `node -e "fetch('https://api.devnet.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'})}).then(r=>r.text()).then(console.log)"` returns `{"result":"ok"}`
- [ ] Pyth SOL/USD feed is fresh on devnet (per `tests/integration/deploy-5-lifecycle-report.md` this can be stale — check `simulateTransaction` of a settle call returns NotExpired NOT PythStale before demo start)
- [ ] Drew's keypair has SOL: `node -e "fetch('https://api.devnet.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:['CJBLhJwTFndhGPvGU4fdoXtWmZHKNmkSn6bEa5MBsYVe']})}).then(r=>r.json()).then(j=>console.log(j.result.value/1e9,'SOL'))"` ≥ 0.4 SOL
- [ ] Presenter's demo wallet has SOL + USDC + ATA-created for at least one StrikeMarket's YES + NO mints (see `coordination/devnet-pubkeys.md` for known markets)
- [ ] At least one settle-eligible StrikeMarket exists on devnet (expired + Pyth-fresh)

### Browser + viewport
- [ ] Fresh Chrome window (no extensions other than Phantom + the demo wallet)
- [ ] Phantom wallet set to devnet
- [ ] Viewport: 1440×900 (standard demo size); have devtools ready to flip to 375px if asked about mobile
- [ ] Disable autofill / pop-up blocker for the recording
- [ ] Screen recorder: 1080p, 30 fps minimum; OBS or Loom

### Apps / services up
- [ ] `pnpm --filter @bell-markets/web dev` running on localhost:3000 (Cleo's frontend)
- [ ] Bram's automation service running (so cron settles happen if a market expires mid-demo)
- [ ] Devnet program at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` confirmed reachable (live-deploy-verify passes)

### Fallback rehearsal
- [ ] `bash scripts/one-command-demo.sh` runs cleanly in <10s — backup if the live UI hits a transient
- [ ] `LIVE_DEMO=1 bash scripts/one-command-demo.sh` — backup for the chain-evidence section
- [ ] `node scripts/simulate-trading-day.mjs --kill-cron-at=phase3` — backup for the HY-5 narrative

---

## Demo arc (4 minutes)

### Scene 1 — Open + connect wallet (0:00 - 0:25)

**On screen:** Browser at `https://localhost:3000/`. Top status bar shows Bloomberg-style timestamp + connection state. CNBC-style ticker marquee scrolling MAG7 prices. Phantom popup ready.

**Action:** Click "Connect Wallet" → Phantom approval → wallet pubkey appears in top-right.

**Talking points (pick 2):**
- "BellMarkets is a non-custodial Solana dApp. Binary outcome contracts on daily MAG7 stock prices. Will AAPL close above $200 today? Mint a pair of YES + NO tokens for $1 USDC each, trade them on a real CLOB, redeem the winning side for $1 at settle."
- "Connecting a wallet is enough to trade — no email, no KYC, no custody. The marketing layer (email + social) is opt-in at the moment you claim a reward, not before."
- "All settlement happens on chain at 4 PM ET via Pyth. Cron's job is to be the convenience nudger, not the authority — we'll see why that matters in a minute."

---

### Scene 2 — Landing carousel + session block (0:25 - 1:00)

**On screen:** Hero-grid carousel (4 slides: Markets, Leaderboard, Contests, Bell Pro). Session block on the right shows live settle countdown (4 PM ET today). Probability matrix below.

**Action:** Auto-rotate carousel through Markets → Leaderboard → Contests → Bell Pro (or use arrow controls). Pause briefly on Leaderboard to show the metric tabs.

**Talking points (pick 2):**
- "Bloomberg-style left rail navigates markets by ticker — MAG7 grouped at the top, more coming. Top tickers show the spot + the implied YES% for the ATM strike."
- "Session block on the right counts down to today's 4 PM ET settle window. When the cron fires, every expired market gets settled in one batch."
- "Carousel hero rotates between the 4 product surfaces — Markets is the trading entry; Leaderboard shows weekly+monthly win streaks across multiple metrics (profit, win rate, ROI); Contests has special promo periods; Bell Pro is the AI-tier briefing we'll get to."

---

### Scene 3 — Probability matrix → trade page (1:00 - 1:30)

**On screen:** Probability matrix renders all 7 MAG7 × ~7 strikes = ~49 cells. Each cell shows the implied YES% for that strike. Color-coded heat (deep amber = high YES, dark = low).

**Action:** Hover one cell → tooltip shows mid/bid/ask + volume. Click the META $700 cell → navigate to `/trade/META/700`.

**Talking points (pick 2):**
- "Whole MAG7 strike grid on one screen — pick any ticker × strike combo in two clicks."
- "Cells are click-targets straight to the trade panel for that contract. No drilldown screens, no modal stack — the matrix IS the entry point."
- "Heat color encodes implied probability — useful at a glance to spot mispricings or skew."

---

### Scene 4 — Trade page Buy YES (1:30 - 2:15)

**On screen:** Trade page for META $700. Left: order book showing YES bids + asks. Right: trade panel with Buy/Sell + Yes/No toggles + amount field + Confirm button. Top: market summary (ticker, strike, expiry, implied prob).

**Action:** Click "Buy" + "YES". Enter $5 amount. Click Confirm. Phantom popup → approve. Wait ~2s for confirm. Trade summary updates: "Bought 5 YES at $0.55 = $2.75 spent."

**Talking points (pick 2):**
- "Phoenix v1 is the matching engine — it's an existing audited CLOB on Solana. We don't run our own matching. DR-001 in the constitution explains why."
- "Buy YES is a single atomic tx: mints a pair, sells the NO half on Phoenix, you keep the YES. Single signature, single broadcast — POV-3 in the brain lift."
- "Settles on chain at 4 PM ET via Pyth. If META closes above $700 today, your 5 YES tokens become $5 USDC. If not, they're worth zero — but the NO side you sold paid you the implied probability."

---

### Scene 5 — Toggle Sell (2:15 - 2:35)

**On screen:** Same trade page. Toggle "Buy" → "Sell". Position summary should show user's 5 YES + realized PnL panel.

**Action:** Toggle to Sell. Enter 3 YES amount. See estimated payout. Click Confirm. Phantom approve. Position updates to 2 YES held.

**Talking points (pick 2):**
- "Sell flow is the inverse — sells your YES tokens back to the Phoenix order book. Pre-settle, you can exit any time at the market price."
- "Realized PnL panel tracks settlement-equivalent value as the market price moves. Doesn't lie — pure on-chain history."

---

### Scene 6 — Toggle Limit + place order (2:35 - 3:00)

**On screen:** Order entry switches from Market to Limit. Price field appears. Order book on left shows where your order would sit.

**Action:** Toggle Limit. Enter limit price of $0.45 (above current bid). Enter 5 YES amount. Click Confirm. Phantom approve. Order appears in the book at your price.

**Talking points (pick 2):**
- "Limit orders rest on Phoenix until filled or cancelled. Standard CLOB behavior."
- "Order book is read directly from Phoenix via subscription — no polling. Updates the moment any fill happens."

---

### Scene 7 — Bell Pro briefing teaser (3:00 - 3:20)

**On screen:** Click into the Bell Pro panel from the landing carousel (or scroll down on the trade page). Shows the AI-generated market briefing — relevant news, sentiment, position recommendations.

**Action:** Read the headline + one bullet. Show the "subscribe for Pro briefings" CTA.

**Talking points (pick 2):**
- "Bell Pro is the AI-tier subscription. Each morning at market open, an LLM ingests the prior 24h of news per MAG7 ticker, generates a 3-paragraph briefing, and tags suggested strikes by conviction."
- "Subscription is paid via Helio — Solana-native USDC checkout. No credit card. We never touch fiat."
- "The briefing's classification + retrieval flow is independent of the trading flow — even if the AI is down, trading works normally."

---

### Scene 8 — Leaderboard with metric toggle (3:20 - 3:40)

**On screen:** Click Leaderboard from the carousel or left rail. Shows top-10 by selected metric. Tab toggle: Profit | Streak | Win-Rate | ROI.

**Action:** Click through 2 metric tabs to show different leaders.

**Talking points (pick 2):**
- "Leaderboard tracks 4 metrics simultaneously — absolute profit, win streak, win rate, and ROI (Pro tier). Each metric surfaces a different kind of skill."
- "Rewards are paid from the protocol fee pool — DR-010 in the constitution. Weekly and monthly payouts to top-10 in each metric. Distribution is verified by a Merkle proof committed on chain — anyone can audit the leaderboard."
- "Total of 128 paid positions per period (4 metrics × 10 + a fallback rollover). Fee split is 50% to platform, 25% to weekly pool, 25% to monthly pool."

---

### Scene 9 — Close (3:40 - 4:00)

**On screen:** Back to landing.

**Talking points (close, 2 of these):**
- "Stack: Anchor on Solana devnet, Phoenix v1 CLOB, Pyth oracle, Next.js frontend, Trigger.dev cron, Neon Postgres for the leaderboard indexer."
- "20-instruction program with 41 error variants — built up across 5 devnet deploys with 5 independent Sonnet audit cycles + 14 substantive fixes shipped."
- "Mainnet path: pre-mainnet-readiness.md documents the 6 gaps that remain before that conversation. Today's demo is the devnet evidence."

---

## Q&A defense — anticipated pushbacks

### "What if your cron crashes mid-settle?"
→ Open `docs/demo/cron-failure-path.md` (or just describe). Run `node scripts/simulate-trading-day.mjs --kill-cron-at=phase3` in terminal to show the cron dying mid-batch and a fresh keypair cranking settle. Cite DR-002 — settle_market is permissionless by design. Layer 4 of the evidence chain: chain-sim returned `PythStale (6009)` from a non-admin signer's call, proving the handler bypasses admin check.

### "How do you know the $1 USDC invariant holds?"
→ `scripts/simulate-trading-day.mjs` runs 3 outcome modes (yes/no/invalid) with 5 invariants checked per Phase 5. 63 mocha eval tests + 100/100 Rust property tests cover the math. The Sonnet audit-3 caught a tier-scaling drift that would have broken the invariant under promo-mode fee config; fixed before this demo.

### "What's your security audit story?"
→ `docs/architecture/pre-mainnet-readiness.md` §6 — 13-attack hostile-tester analysis. 11 defended with named test evidence. 1 weakly defended (uneconomic wash-trade for tier gaming). 1 explicit accepted gap (Sybil-mint on the leaderboard — mitigations via DR-014 social linking + KYC at high-payout tiers planned for v2). NO independent third-party audit yet — that's the #1 mainnet blocker.

### "What if Phoenix has an outage?"
→ DR-009 explicitly accepts the dependency. Phoenix v1 is audited; our settle path doesn't depend on Phoenix (only the trading path does). If Phoenix is down, users can't trade in/out of positions on Phoenix but they CAN still mint_pair + redeem at settle. We documented this trade-off + alternatives in DR-009.

### "Show me an actual on-chain tx."
→ Pull up Solana Explorer with `tx 4rQq81zAxwM9ME4qXdnhuMsJMHWqqwqU7A8aBqHm4urmKPkkw9PX8uupsHXifuhfMwWDNcYLeU4TGF3yCKrkGEss` (deploy-5 tx). Or live-broadcast a settle if one is ready.

### "Why no v2 features yet?"
→ DR-014 (social linking) + DR-015 (multi-metric leaderboard) + force_redeem_invalid + Pyth Receiver Program + multi-sig admin are all queued and specced. v1 demo is the trading-protocol + invariant evidence. v2 is the retention layer.

---

## Pre-recording (Sat 5/24 night, before Sunday demo)

Drew or Tate runs the live demo through twice as a rehearsal:
1. First pass: identify any scene that confuses or hits a transient
2. Second pass: actual recording — 2 takes if time allows
3. Save best take to `docs/demo/recording-assets/v1-demo.mp4`
4. Generate transcript via Whisper or manual; save to `docs/demo/recording-assets/v1-demo-transcript.txt`
5. Optional: a 30-second highlight reel cut for sharing

**If anything in the live demo is too risky to broadcast (e.g., Pyth feed flakiness on devnet that's not addressable in time), pre-recorded video is the fallback presenter shows.**

---

## What this demo deliberately doesn't show

- The cron-failure path live (saved for Q&A — overshooting in a 4-min demo)
- The pre-mainnet readiness analysis (saved for reviewer questions on production posture)
- The 5 Sonnet audit cycles + 14 fixes story (saved for "how do you ensure quality")
- Mobile viewport walkthrough (saved for "how do you handle mobile")

All of these are richer when pulled for a specific reviewer question rather than rushed into the main flow.
