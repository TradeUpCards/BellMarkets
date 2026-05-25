# BellMarkets v1 Demo Script

**Target:** Sun 2026-05-25 5:00 PM ET (Gauntlet cohort submission)
**Owner:** Drew (script) + presenter TBD (probably Cory or Tate)
**Length:** 3-5 minutes (target 4:00)
**Format:** Live walkthrough preferred; pre-recorded backup at `docs/demo/recording-assets/v1-demo.mp4` (TODO Sat night)

**FINAL FLOW DECISION (Sun 2026-05-25, post-deploy_index=8 smoke against main `ca3c2e1`):**

> **Flow B is the chosen flow — full live execution against deploy_index=8.** All 4 trade paths now broadcast against the deployed in-program CLOB (DR-020) on devnet bUSDC. Three demo strikes are seeded with $0.40–$0.50 bid ladder + $0.55–$0.65 ask ladder (50 YES per rung, $0.05 inside spread): **META @ $610**, **NVDA @ $215**, **AAPL @ $309**. Live smoke `LIVE_DEVNET=1 pnpm --filter @bell-markets/tests test:contracts` returns 17/17 (3 oracle byte-parity + 14 DR-020 CLOB: vault invariant through cross/cancel flurry, escrow reconciliation with rounding, all 4 trade paths execute + vault invariant preserved, 9 adversarial cases incl. IOC empty-book reverts + BookFull at N=128, 2 meta-tests).

**Demo strike: META @ $610** (Bram's primary). Other 2 seeded strikes (NVDA $215, AAPL $309) are presenter-fallback if META Phantom flow flakes mid-run.

What this means for the presenter:
- **Scenes 1–9 all run LIVE** on `localhost:3000/` (landing) + `localhost:3000/trade/META/610` (trade).
- **Scene 4** = **Buy YES Market** (taker bid crosses $0.55 ask) → Phantom approve → fill broadcasts → position updates.
- **Scene 5** = **Sell YES Market** (taker ask crosses $0.50 bid) → Phantom approve → fill broadcasts → position updates.
- **Scene 6** = **Limit toggle** on Buy YES → place a $0.45 limit that rests on the book (now LIVE — DR-020 ships limit orders); toggle to Sell NO and observe the Limit option is grayed-out per DR-019 (NO-side trades are market-only).
- **Scene 6b** = **Buy NO Market** on a separate small-size click (e.g. 10 contracts) — atomic mint_pair + sell-YES against best bid; user wallet shows NO balance, no orphan YES.
- **Scene 6c** = **Sell NO Market** — atomic burn-pair flow; presenter narrates the redeem_pair leg.

**The bUSDC narrative** (Scene 4 first mention, then again if asked):
> "BellMarkets runs on `bUSDC` for this devnet demo — a self-controlled SPL mint at `5vq2oah...KtBZp`, 1:1 with USDC, with unlimited supply so we can fund judge wallets instantly. The protocol is mint-agnostic via the `update_usdc_mint` admin instruction — production deploys against Circle USDC. We migrated devnet from Circle USDC → bUSDC mid-build via two instructions: `update_usdc_mint` and `reinit_rewards_pools` (deploy_index=8). The vault math, the $1 invariant, the redeem path — all identical."

**"Get demo USDC" narration** (use if presenter wants to fund a judge wallet mid-demo):
> "Tate can run `pnpm mint-demo-usdc <judge-wallet> 100` from terminal — that drops 100 bUSDC into the judge's wallet in one tx. Try the demo yourselves."

**Caveats the presenter must NOT skip (Bell Pro card + leaderboard):**
- Bell Pro card on the landing shows the upgrade pitch + 4 feature bullets (Cleo's paired-sprint ship added a live `/api/briefings/AAPL` route that overrides the card body with a Sonnet-generated briefing on hover/mount — verify in pre-flight). The Sonnet-generated briefings DO exist (Bram's `pnpm briefings:gen` populates Neon table `briefings`).
- Probability matrix + leaderboard + Recent Fills on the landing are STATIC FIXTURE data (Cleo's own `STATIC FIXTURE` code comments at `landing-view.tsx:30, 161`). The visual design ships; the wire-to-live `useAllMarkets() / useLeaderboard() / useFills()` lands v1.5.
- Leaderboard ROI metric is an explicit stub (`metric-leaderboards.ts:topRoiLeaderboard()` returns `[]` until v1.5 mint-volume capital indexing).

**Fallback to Flow C** (live Buy×Yes only + narration for the other 3 paths) ONLY needed if: the live dev server fails to start, OR Cleo's UI wire-in for the new place_order path regressed after the deploy_index=8 IDL refresh, OR Phantom approval flow breaks. Pre-flight checks below cover these gates.

The three flow definitions are preserved for the record:

- **Flow A — Mockup walk-through** (last-resort fallback): walk reviewers through the v8 mockup HTML files for the visual design, terminal-based on-chain evidence for the lifecycle proofs.
- **Flow B — Full live trade flow** (CHOSEN — what we run): all 4 trade paths broadcast on `localhost:3000/trade/META/610` against deploy_index=8 + bUSDC + seeded books.
- **Flow C — Hybrid** (intermediate fallback): live Buy×Yes only + narration for Sell/No (the previous flow choice before deploy_index=8 + Bram's re-seed unlocked the other 3).

**Pair with:**
- `docs/demo/cron-failure-path.md` — HY-5 evidence (run as Q&A response if asked)
- `docs/architecture/pre-mainnet-readiness.md` — security narrative + v2 gaps (reference for production-posture questions)
- `scripts/one-command-demo.sh` — show in terminal if reviewer asks to verify lifecycle locally

---

## Pre-flight (30 min before demo start)

### Environment
- [ ] Solana devnet RPC responsive (run from a terminal):
  ```
  node -e "fetch('https://api.devnet.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'})}).then(r=>r.text()).then(console.log)"
  ```
  Expected: `{"jsonrpc":"2.0","result":"ok","id":1}`
- [ ] **Settle-eligible market check.** Pyth SOL/USD on devnet has historically gone stale (see `tests/integration/deploy-5-lifecycle-report.md`). Pre-flight check:
  ```
  node tests/integration/deploy-5-lifecycle.mjs 2>&1 | grep -E "step-1-settle|status"
  ```
  Expected: returns either `Custom: 6003 NotExpired` (market is fresh enough), OR `status: ok` (real settle would broadcast). **If it returns `Custom: 6009 PythStale`, the live-settle-broadcast Q&A is OFF — use the mock simulation instead.** Fallback: `node scripts/simulate-trading-day.mjs --kill-cron-at=phase3` shows the same architectural claim against a deterministic mock.
- [ ] Drew's keypair has SOL ≥ 0.4 SOL:
  ```
  node -e "fetch('https://api.devnet.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:['CJBLhJwTFndhGPvGU4fdoXtWmZHKNmkSn6bEa5MBsYVe']})}).then(r=>r.json()).then(j=>console.log(j.result.value/1e9,'SOL'))"
  ```
- [ ] **Presenter's demo wallet funded** (Flow B requirement):
  - SOL ≥ 0.05 SOL for tx fees + ATA rent
  - bUSDC ≥ 20 (run `pnpm --filter @bell-markets/automation mint-demo-usdc <presenter-pubkey> 100` from terminal — Tate signs as platform admin)
  - The first Buy YES tx auto-creates the YES ATA; no manual ATA prep needed
- [ ] **Verify seeded books are intact** (run from a terminal):
  ```
  node -e "import('@solana/web3.js').then(async w=>{const c=new w.Connection('https://api.devnet.solana.com');const ob=await c.getAccountInfo(new w.PublicKey('XWEymjgovx7F1uHNb24mFoMHsNTMNkij6t1Jywk4YvB'));console.log('META OrderBook bytes:',ob?.data?.length ?? 'NOT FOUND')})"
  ```
  Expected: `META OrderBook bytes: 16448` (zero_copy account). If `NOT FOUND` → Bram's re-seed didn't land cleanly; fall back to Flow C.

### Browser + viewport
- [ ] Fresh Chrome window (no extensions other than Phantom)
- [ ] Phantom wallet on devnet, switched to the demo wallet pubkey
- [ ] Viewport: 1440×900; devtools ready to flip to 375px on request
- [ ] Screen recorder: 1080p, 30 fps (OBS or Loom)
- [ ] **One browser tab open** (Flow B — chosen): `localhost:3000/` (v8 landing live; navigates to trade page from matrix click in Scene 3). Trade page = `localhost:3000/trade/META/610` (matches Bram's seeded strike).
- [ ] **Verify the actual dev-server port.** `pnpm dev` on a clean machine picks 3000; on a multi-worktree dev machine it may pick 3001/3002/3003. Confirm + update the URLs you'll demo with before you go live.

### Apps / services up
- [ ] `pnpm --filter @bell-markets/web dev` running on localhost:3000
- [ ] Bram's automation service running (so cron settles happen if a market expires mid-demo)
- [ ] Devnet program at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` confirmed reachable

### Windows-specific
- [ ] All `bash` commands in this script require WSL or Git Bash (the repo is on Windows 11). `node` commands work in any terminal.

### Fallback rehearsal
- [ ] `bash scripts/one-command-demo.sh` runs cleanly in <10s — backup if the live UI hits a transient
- [ ] `LIVE_DEMO=1 bash scripts/one-command-demo.sh` — backup for the chain-evidence section
- [ ] `node scripts/simulate-trading-day.mjs --kill-cron-at=phase3` — backup for the HY-5 narrative

---

## Demo arc (4 minutes)

### Scene 1 — Open + connect wallet (0:00 - 0:25)

**On screen:** Browser tab 1 (`localhost:3000/`). v8 landing page renders (Scene 1 starts on landing, navigates to trade via Scene 3 matrix click).

**Action:** Click "Connect Wallet" in top-right → Phantom popup → approve → wallet pubkey shows.

**Talking points (pick 2):**
- "BellMarkets is a non-custodial Solana dApp. Binary outcome contracts on daily MAG7 stock prices. Will META close above $700 today? Mint a pair of YES + NO tokens for $1 USDC each, trade them on a real CLOB, redeem the winning side for $1 at settle."
- "Connecting a wallet is enough to trade — no email, no KYC, no custody. The marketing layer (email + social linking) is opt-in at the moment you claim a reward, not before."
- "All settlement happens on chain at 4 PM ET via Pyth. Cron's job is to be the convenience nudger, not the authority — we'll see why that matters in Q&A."

---

### Scene 2 — Landing hero + ticker marquee (0:25 - 1:00)  **[FLOW B: live Next.js]**

**On screen:** Navigate to `localhost:3000/` (v8 landing — shipped in Next.js as of merge `13a8481`). CNBC-style ticker marquee at top scrolls 7 MAG7 names. Hero card centerpiece below. **Note: dev server may pick a port other than 3000 if other workspaces hold it; check the actual port from `pnpm dev` output.**

**Action:** Let the ticker marquee play for ~3 seconds (each MAG7 ticker + spot + day-change scrolls past). Scroll down past the hero card to reveal the probability matrix below.

**Talking points (pick 2):**
- "Bloomberg-style left rail navigates markets by ticker — MAG7 grouped at the top. Top tickers show spot + implied YES% for the ATM strike."
- "Session block on the right counts down to today's 4 PM ET settle window. When the cron fires, every expired market gets settled in one batch — but if the cron dies, any user can crank settle themselves. We'll cover the architecture in Q&A."
- "Carousel rotates between the 4 product surfaces. The visual you're seeing is the v8 design lock; the Next.js implementation lands this weekend with the trade page first."

---

### Scene 3 — Probability matrix → trade page (1:00 - 1:30)  **[FLOW B: live Next.js]**

**On screen:** Still on `localhost:3000/`, scrolled to the probability matrix. 4 MAG7 rows × 7 strikes = 28 cells visible (META, NVDA, AAPL, MSFT). Each cell shows implied YES% for that strike. Color-coded heat (deep green at high probability → red at low). ATM strike highlighted.

**Action:** Hover the **META $610 cell** (ATM strike, ~52% implied). Click — navigate to `localhost:3000/trade/META/610` (matches Bram's seeded strike + book; Scene 4 lands here).

**Caveat to narrate (optional, if reviewer asks):** "The matrix data is currently a static fixture — the design ships today; the wire-to-live `useAllMarkets()` per row is v1.5 work. The trade-page route IS live and reads from chain."

**Talking points (pick 2):**
- "Whole MAG7 strike grid on one screen — pick any ticker × strike combo in two clicks. The matrix IS the trading entry point."
- "Heat color encodes implied probability — useful at a glance to spot mispricings or skew."
- "Click takes you to the trade page for that contract — which is what we have running here in the actual app."

---

### Scene 4 — Buy YES Market — LIVE BROADCAST against in-program CLOB (1:30 - 2:15)  **[FLOW B: full live]**

**On screen:** `localhost:3000/trade/META/610`. v8 trade UI: left = live order book reading from the OrderBook PDA `XWEymjgovx7F1uHNb24mFoMHsNTMNkij6t1Jywk4YvB` (Bram's seeded liquidity: 3 bids $0.40/$0.45/$0.50 + 3 asks $0.55/$0.60/$0.65, 50 YES per rung). Right = trade panel with Buy/Sell + Yes/No toggles + amount field + estimated cost + Submit.

**Action:** Side = Buy (default). Outcome = YES (default). Order type = Market (default). Type "10" contracts in the amount field. Watch the estimated cost ≈ $5.50 (10 × $0.55 best ask) + DR-008 fee + slippage update live. **Click Submit** → Phantom popup → approve. The `place_order` instruction broadcasts to devnet against the OrderBook PDA. The matching engine crosses 10 YES from the $0.55 ask in one tx.

Wait ~2s for tx confirmation. The submitResult banner shows `Submitted! <16-char sig prefix>… (confirming)` in success-green. The order book on the left updates — the $0.55 ask drops from 50 → 40 YES. The position monitor shows 10 YES held.

**Drop the bUSDC narrative here (first mention):**
> "BellMarkets runs on bUSDC for this devnet demo — a self-controlled SPL mint with unlimited supply so we can fund judge wallets instantly. The protocol is mint-agnostic via the `update_usdc_mint` admin instruction — production deploys against Circle USDC. Tate can run `pnpm mint-demo-usdc <judge-wallet> 100` from terminal — try the demo yourselves."

**Talking points (pick 2):**
- "The matching engine ships in our own program — DR-020. Three-phase plan→settle→apply, escrow accounts owned by the strike's PDA, no Phoenix dependency. We pivoted from Phoenix v1 mid-build because per-market fee_recipient routing is what the protocol needs and that was a v1.5 effort vs ship-now in our own ix."
- "Trading touches escrow accounts — not the protocol vault. The vault math (vault == pairs_outstanding × $1) is preserved through every cross/cancel/match — verified by 17 live invariant + adversarial tests against deploy_index=8."
- "Fee math is tier-based — DR-008. New users pay 25 bps mint + 10 bps Phoenix taker (DR-018); creator of the strike pays 0% (creator rebate). All shown in the trade panel as you adjust the amount."

---

### Scene 5 — Sell YES Market — LIVE BROADCAST (2:15 - 2:35)  **[FLOW B: full live]**

**On screen:** Same trade page. Toggle "Buy" → "Sell". Position monitor still shows 10 YES from Scene 4.

**Action:** Side = Sell. Outcome = YES. Order type = Market. Type "5" contracts. Estimated payout ≈ $2.50 (5 × $0.50 best bid). **Click Submit** → Phantom approve. The `place_order(side=ASK, is_market=true)` ix broadcasts; matches against the $0.50 inside bid; position monitor drops 10 → 5 YES; wallet bUSDC increases by ~$2.50.

**Talking points (pick 2):**
- "Sell is the inverse — taker ask crosses into the resting bid. Same matching engine, same atomic tx. Pre-settle, users can exit any time at the market price."
- "Realized PnL panel tracks settlement-equivalent value as the market price moves. Pure on-chain history; no off-chain bookkeeping — the indexer Bram built reads `OrderMatched` events from Helius and reconstructs PnL in the UI."

---

### Scene 6 — Limit order + DR-019 gating (2:35 - 2:50)  **[FLOW B: full live]**

**On screen:** Order entry. Toggle Buy YES + Limit. Price field appears, defaults to a mid-book value (e.g. $0.475).

**Action 6a — Limit Buy YES rests on book:** Toggle to Limit. Set price = $0.45, size = 5. Click Submit → Phantom approve → `place_order(side=BID, price=450_000, is_market=false)` broadcasts. The order does NOT cross (it's below the $0.55 best ask + above the resting $0.45 bid). It rests on the book; the order book on left shows a new bid layer at $0.45 size 55 (50 from Bram's seed + 5 from us). Position monitor unchanged (no fill).

**Action 6b — DR-019 Limit-disabled-on-NO check:** Toggle Outcome from YES → NO. The Limit/Market toggle should disable Limit (grayed out, tooltip "NO-side trades are market-only — DR-019"). Toggle Side from Buy → Sell. Sell × NO is also market-only.

Narrate: "DR-019 locks NO-side trades to market-only at the protocol level. The Buy NO and Sell NO paths are atomic two-leg trades — mint_pair + sell-YES for Buy NO; buy-YES + redeem_pair for Sell NO. A limit on NO would be ambiguous about which leg the price applies to. The UI enforces it; if a user crafts the raw ix, the program rejects it."

**Action 6c — Buy NO Market (atomic):** Toggle Outcome = NO + Side = Buy + Order = Market. Type "5" contracts. Estimated cost ≈ $2.75 (5 × ($1 − $0.45 best bid) = 5 × $0.55, since Buy NO mints a pair then sells the YES half at the best bid). Click Submit → Phantom approve. The atomic flow: (1) mint_pair burns $5 bUSDC + mints 5 YES + 5 NO; (2) `place_order(side=ASK, is_market=true)` sells the 5 YES at $0.45 best bid; user nets +$2.25 + 5 NO contracts. **Critical check: position monitor shows 5 NO, zero orphan YES.** If the bid book were empty, the BuyNoIocError would have reverted the whole tx atomically.

**Action 6d (optional, if time) — Sell NO Market (atomic):** Toggle Outcome = NO + Side = Sell + Order = Market. Type "5" contracts (user holds 5 NO from 6c). Estimated payout ≈ buy-YES leg at best ask + redeem_pair refund. Click Submit → Phantom approve. The atomic flow: (1) `place_order(side=BID, is_market=true)` buys 5 YES at best ask; (2) `redeem_pair(5)` burns 5 YES + 5 NO + refunds 5 bUSDC. User wallet now has zero YES + zero NO + net bUSDC delta from the round-trip.

**Talking points (pick 2):**
- "Limit orders rest in the OrderBook PDA — same account-shape Aria designed under Keith's adversarial review. Telescoping escrow ensures no stranded dust on partial fills."
- "Buy NO + Sell NO are atomic two-leg trades; the program guarantees both legs land or neither. The IOC `BuyNoIocError` is the kill-switch — if the second leg can't fill, the first leg unwinds. We adversarially tested this with an empty book + got a clean revert."
- "DR-019 prevents UI footguns. NO-side trades are conceptually atomic — limit pricing on a two-leg atomic doesn't have one obvious meaning, so we disallowed it at the protocol level."

---

### Scene 7 — Bell Pro panel + Recent Fills (2:50 - 3:15)  **[FLOW B: live Next.js landing]**

**On screen:** Navigate back to `localhost:3000/`, scroll down past the leaderboard to the Bell Pro + Recent Fills row. Bell Pro panel on the left shows a LIVE Sonnet briefing header (`AAPL · today's briefing` + ET date) + scrollable body — Cleo's paired-sprint shipped the `/api/briefings/AAPL` route + landing-view fetch-on-mount hook. Recent Fills panel on the right shows the live tape table (static fixture today; live tape from Helius webhook ships v1.5).

**Action:** Scroll through the briefing body for ~3 seconds — show that it's a real AI-generated daily briefing, not a placeholder. Hover the "Upgrade · $9 / mo →" button. The CTA links to `/settings#billing` — Helio checkout integration is wired in `apps/web/app/api/billing/route.ts` + `apps/web/src/lib/billing/helio.ts`.

**Talking points (pick 2):**
- "Bell Pro is the AI-tier subscription. Daily Sonnet 4.6 briefing per MAG7 ticker, generated against live Pyth Hermes spot prices + ET market-session context. The card you're looking at is reading directly from Neon — 7 briefings persisted today."
- "Subscription is paid via Helio — Solana-native USDC checkout. No credit card. We never touch fiat."
- "The briefing pipeline is independent of the trading pipeline — even if the AI is down, trading works normally. DR-014 social linking + Helio billing are off-chain off-path systems."

---

### Scene 8 — Leaderboard with metric toggle (3:15 - 3:40)  **[FLOW B: live Next.js landing]**

**On screen:** Scroll up on `localhost:3000/` to the Leaderboard + Contests row (between the matrix and Bell Pro). Tab toggle: Profit | Streak | Win-Rate.

**Action:** Click through Profit → Streak → Win-Rate tabs to show different leaders. (ROI tab not shown — it's an explicit v1.5 stub.)

**Talking points (pick 2):**
- "Leaderboard tracks 4 metrics simultaneously — absolute profit, win streak, win rate, and ROI. Each surfaces a different kind of skill. Profit + streak + win-rate are live in Bram's indexer; ROI ships in v1.5 once the mint-volume capital data is indexed."
- "Rewards are paid from the protocol fee pool — DR-010 in the constitution. Weekly and monthly payouts to top-10 per metric. Distribution is verified by a Merkle proof committed on chain — anyone can audit the leaderboard."
- "Total of 128 paid positions per period (4 metrics × 10 + rollover). Fee split is 50% to platform, 25% to weekly pool, 25% to monthly pool."

---

### Scene 9 — Close (3:40 - 4:00)

**Talking points (pick 2):**
- "Stack: Anchor on Solana devnet, in-program CLOB (DR-020 — Keith's reference design adapted), Pyth oracle via vendored parser, Next.js frontend, Trigger.dev cron, Neon Postgres for the leaderboard indexer + briefings, Helius webhook for event indexing, Helio for fiat-free subscription billing."
- "27-instruction program with 54 error variants — built across 8 audited devnet deploys with 7 independent Sonnet audit cycles + 17 substantive fixes shipped. The DR-020 in-program CLOB pivot landed mid-build; we pivoted from Phoenix v1 + Model D fee-recipient to a self-owned matching engine in ~24 hours."
- "Mainnet path: `pre-mainnet-readiness.md` documents the 7 gaps that remain (including a fresh third-party audit on the new matching-engine surface). Today's demo is the devnet evidence."

---

## Q&A defense — anticipated pushbacks

### "What if your cron crashes mid-settle?"
→ Switch to a terminal. Run `node scripts/simulate-trading-day.mjs --kill-cron-at=phase3`. Watch the JSON log emit Bram's exact exhausted-state shape + a fresh keypair successfully cranks settle. Cite DR-002 — settle_market is permissionless by design. Strongest chain-level evidence: `tests/integration/deploy-5-lifecycle.mjs` simulation returned `PythStale (6009)` from a non-admin signer, proving the handler bypassed the absent admin check + evaluated-and-passed NotExpired before hitting Pyth.

### "How do you know the $1 USDC invariant holds?"
→ `scripts/simulate-trading-day.mjs` runs 3 outcome modes (yes/no/invalid) with 5 invariants checked per Phase 5. 63 mocha eval tests + 100/100 Rust property tests cover the math. Sonnet-audit-3 caught a tier-scaling drift that would have broken the invariant under promo-mode fee config; fixed before this demo.

### "What's your security audit story?"
→ Master security model is `constitution/decisions.md` DR-017: PDA self-authority on every fund-moving account + Anchor account constraints validated before handler entry + permissionless `settle_market` + admin-as-cranker-not-redirector. The canonical "where can vault USDC go?" has a finite answer: winning user via redeem, pair-burner via redeem_pair, invalid-market refund via redeem_invalid, fee_collector via mint_pair fee. **No `withdraw_to_admin` instruction exists; no path was ever drafted.** The 13-attack hostile-tester analysis in `docs/architecture/pre-mainnet-readiness.md` §6 stress-tests that model: 11 defended with named test evidence, 1 weakly defended (uneconomic wash-trade for tier gaming — DR-009 amendment closes the Phoenix-secondary-trade fee surface at v1.5 P0), 1 explicit accepted gap (Sybil-mint on the leaderboard — DR-014 social linking + KYC at high-payout tiers mitigate in v2). **No independent third-party audit yet** — that's the #1 mainnet blocker.

### "What if Phoenix has an outage?"
→ Trick question post-DR-020 — we don't depend on Phoenix anymore. The matching engine ships in our own program (DR-020 pivot, mid-build, Sun 2026-05-24). Reference design from Keith's adversarially-reviewed CLOB. Phoenix code stays *dormant* in the program (`verify_phoenix_market` adapter present but unused) per DR-020's additive policy — we may pivot back to Phoenix v2 if it ships with native per-market `fee_recipient`. For now, no external matching dependency. DR-009 amendment (Model D feasibility) is preserved in the constitution for the historical record; DR-020 supersedes it operationally.

### "Show me an actual on-chain transaction"
→ Two evidence levels:
- **Program deploy** (proves devnet deployment): `4rQq81zAxwM9ME4qXdnhuMsJMHWqqwqU7A8aBqHm4urmKPkkw9PX8uupsHXifuhfMwWDNcYLeU4TGF3yCKrkGEss` — pull up Solana Explorer. This is the deploy-5 tx; proves the program lives on devnet at the cited address. **Not a trade transaction.**
- **Lifecycle invariants** (proves trade/settle/redeem math): run `LIVE_DEMO=1 bash scripts/one-command-demo.sh` — exercises mock-mode lifecycle + the real chain-level DR-002 evidence test.
- **A real on-chain trade tx**: every Scene 4-6 Submit click broadcasts to devnet via `place_order` (Buy YES Market, Sell YES Market, Limit Buy YES, Buy NO atomic, Sell NO atomic). Open Solana Explorer on devnet, paste any of the tx sigs returned by the trade panel after Phantom approve — full inner-instruction view shows mint_pair + place_order (or place_order alone) executing.

### "Why no v2 features yet?"
→ DR-014 (social linking) + DR-015 (multi-metric leaderboard) + `force_redeem_invalid` + Pyth Receiver Program + multi-sig admin are all queued and specced. v1 demo is the trading-protocol + invariant evidence. v2 is the retention layer.

### "Is the live app fully wired?"
→ Honest answer: as of merge `ca3c2e1` on Sun 2026-05-25, **all 4 trade paths are LIVE end-to-end** against deploy_index=8 + bUSDC + Bram's seeded books on devnet. Buy YES + Sell YES are direct taker crosses; Buy NO + Sell NO are atomic two-leg trades (mint_pair + sell-YES; buy-YES + redeem_pair) with IOC reverts guaranteeing no orphan tokens. The full v1 lifecycle (create_strike_market → init_order_book → grow_order_book → mint_pair → place_order × N → match_orders → settle_market → redeem) executes against the deployed program. Landing page sections (probability matrix, leaderboard, Recent Fills) ship with static fixture data; live-data wiring (`useAllMarkets`, `useLeaderboard`, `useFills`) lands v1.5. Bell Pro card IS live (Sonnet briefing fetched from Neon via `/api/briefings/:ticker`). **The protocol on chain is fully functional** (27 ix deployed across 8 audited devnet deploys, deploy_index=8 = deploy_index=7 + reinit_rewards_pools for the bUSDC migration; 17 live invariant + adversarial tests passing against the in-program CLOB; 7+ Sonnet audit cycles with 17+ substantive fixes).

---

## Pre-recording (Sat 5/24 night, before Sunday demo)

1. **Flow choice locked = Flow B** (Sun deploy_index=8 smoke verdict; see header). Re-evaluate ONLY if pre-flight (1) dev server doesn't start, (2) bUSDC seeded books missing, (3) Phantom approval flow breaks. Fallback ladder: Flow B → Flow C (Buy×Yes only + narration) → Flow A (mockup HTML + terminal).
2. **Run pre-flight checks** end-to-end. Especially the Pyth feed staleness check.
3. **Rehearse twice** — first pass identify hiccups, second pass record.
4. **Save best take** to `docs/demo/recording-assets/v1-demo.mp4`.
5. **Generate transcript** via Whisper or manual; save to `docs/demo/recording-assets/v1-demo-transcript.txt`.
6. **Optional**: 30-second highlight reel cut for sharing.

**Pre-recorded backup is the safety net** if anything in the live flow is too risky to broadcast.

---

## What this demo deliberately doesn't show

- The cron-failure path live (saved for Q&A — overshooting in a 4-min demo)
- The pre-mainnet readiness analysis (saved for production-posture questions)
- The 5 Sonnet audit cycles + 14 fixes story (saved for "how do you ensure quality")
- Mobile viewport walkthrough (saved for "how do you handle mobile")

All of these are richer when pulled for a specific reviewer question rather than rushed into the main flow.

---

## Audit lineage

- **Sonnet-audit-6** (Sat 2026-05-24 round 1) caught the original draft's over-claims: trade-submit handlers throw `not yet wired` for every path; landing carousel + probability matrix don't exist in shipped Next.js; Bell Pro morning cron is not registered; leaderboard ROI metric is an explicit stub. Drew restructured the script into three flows (A/B/C) with explicit honesty about what was mockup vs running app vs terminal evidence.
- **Smoke #3 + Flow-C lock** (Sun 2026-05-25 morning): post-merge smoke against main `91bb75d` confirmed Cleo shipped the two critical surfaces (trade Buy×Yes wiring + v8 landing). Flow C was the chosen flow as of that revision.
- **Smoke #4 + Flow-B promotion** (Sun 2026-05-25 afternoon, this revision): post-deploy_index=8 + Bram's bUSDC re-seed against main `ca3c2e1`. Live contracts smoke = 17/17 passing (3 oracle + 14 DR-020 CLOB; the 1 prior Chai red is fixed via Aria's `22c9cdf`). All 4 trade paths confirmed live-fillable on Bram's seeded META/NVDA/AAPL strikes. **Flow B is now the chosen flow.** Bell Pro card now renders live Sonnet briefing content via Cleo's paired-sprint `/api/briefings/:ticker` route. Phoenix Q&A pivoted to DR-020 narrative (in-program CLOB; Phoenix dormant).

Re-audit AGAIN if any pre-flight check fails on Sunday afternoon — devnet flakes, seeded books missing, dev-server-port surprises, Phantom approval breakage are the four known fragile points.
