# BellMarkets v1 Demo Script

**Target:** Sun 2026-05-25 5:00 PM ET (Gauntlet cohort submission)
**Owner:** Drew (script) + presenter TBD (probably Cory or Tate)
**Length:** 3-5 minutes (target 4:00)
**Format:** Live walkthrough preferred; pre-recorded backup at `docs/demo/recording-assets/v1-demo.mp4` (TODO Sat night)

**SHIPPED-STATE HONESTY HEADER (Sat 2026-05-24 evening — re-evaluate before Sunday recording):**

Cleo is mid-ship of the v8 frontend. As of this revision, the following is true and a presenter MUST know it before recording:
- **The v8 trade page is shipped at `localhost:3000/trade/[ticker]/[strike]`** — but the trade-submit handler currently throws `not yet wired` for every Buy/Sell × Yes/No × Market/Limit path. Phantom approval cannot complete a trade in the running app today.
- **Landing page at `localhost:3000/`** renders a `Coming soon` scaffold — no carousel, no probability matrix, no Bell Pro panel, no leaderboard. Those views exist only in `apps/web/public/mockups/v8-landing.html` (a static HTML mockup), not in the Next.js app.
- **`/markets` route** renders `Market list placeholder — coming Day 2.` Same caveat.
- **Bell Pro briefings:** the generator script `pnpm briefings:gen` exists (operator-run) but the morning cron is NOT registered to call it. No "each morning" automation today.
- **Leaderboard ROI metric** is an explicit stub (`metric-leaderboards.ts:topRoiLeaderboard()` returns `[]` until v1.5).

This script is **structured into three flows** that a presenter chooses between based on what's actually live by Sunday:

- **Flow A — Mockup walk-through** (current default, if trade-view submit handlers still throw on Sun): walk reviewers through the v8 mockup HTML files for the visual design, demonstrate the actually-shipped trade-view UI rendering, and pivot to terminal evidence for the on-chain lifecycle proofs.
- **Flow B — Live trade flow** (if Cleo lands the trade-submit wiring by Sun morning): the full Buy YES → Confirm → Settle → Redeem path in the running app.
- **Flow C — Hybrid** (most likely): Flow A for landing + Bell Pro + leaderboard (mockup), Flow B for trade page (if wired by Sun).

Drew's working assumption: Flow A or C. The script below is written for Flow A with [BRACKETED FLOW-B SWAP] markers where the live-app version would substitute. A presenter rehearses 24h before with whichever flow matches reality.

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
- [ ] If Flow B: presenter's demo wallet has SOL + USDC + ATAs for at least one StrikeMarket's YES + NO mints

### Browser + viewport
- [ ] Fresh Chrome window (no extensions other than Phantom)
- [ ] Phantom wallet on devnet
- [ ] Viewport: 1440×900; devtools ready to flip to 375px on request
- [ ] Screen recorder: 1080p, 30 fps (OBS or Loom)
- [ ] **Two browser tabs open** if Flow A: tab 1 = `localhost:3000/trade/META/700` (shipped v8 trade UI), tab 2 = `apps/web/public/mockups/v8-landing.html` opened via `file://` for the carousel/matrix/Bell Pro/leaderboard scenes

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

**On screen:** Browser tab 1 (`localhost:3000/trade/META/700`). v8-themed trade page renders.

**Action:** Click "Connect Wallet" in top-right → Phantom popup → approve → wallet pubkey shows.

**Talking points (pick 2):**
- "BellMarkets is a non-custodial Solana dApp. Binary outcome contracts on daily MAG7 stock prices. Will META close above $700 today? Mint a pair of YES + NO tokens for $1 USDC each, trade them on a real CLOB, redeem the winning side for $1 at settle."
- "Connecting a wallet is enough to trade — no email, no KYC, no custody. The marketing layer (email + social linking) is opt-in at the moment you claim a reward, not before."
- "All settlement happens on chain at 4 PM ET via Pyth. Cron's job is to be the convenience nudger, not the authority — we'll see why that matters in Q&A."

---

### Scene 2 — Landing carousel + session block (0:25 - 1:00)  **[FLOW A: mockup HTML]**

**On screen:** Switch to browser tab 2 (`file://.../apps/web/public/mockups/v8-landing.html`). Hero-grid carousel (4 slides: Markets, Leaderboard, Contests, Bell Pro). Session block on the right shows static settle countdown. Probability matrix below.

**[FLOW B SWAP if Cleo ships v8 landing in Next.js by Sun]:** Stay on `localhost:3000/` instead of the file:// mockup.

**Action:** Auto-rotate carousel through Markets → Leaderboard → Contests → Bell Pro (or use arrow controls). Pause briefly on Leaderboard to show the metric tabs.

**Talking points (pick 2):**
- "Bloomberg-style left rail navigates markets by ticker — MAG7 grouped at the top. Top tickers show spot + implied YES% for the ATM strike."
- "Session block on the right counts down to today's 4 PM ET settle window. When the cron fires, every expired market gets settled in one batch — but if the cron dies, any user can crank settle themselves. We'll cover the architecture in Q&A."
- "Carousel rotates between the 4 product surfaces. The visual you're seeing is the v8 design lock; the Next.js implementation lands this weekend with the trade page first."

---

### Scene 3 — Probability matrix → trade page (1:00 - 1:30)  **[FLOW A: mockup → real]**

**On screen:** Still in mockup tab. Probability matrix renders 7 MAG7 × ~7 strikes = ~49 cells. Each cell shows the implied YES% for that strike. Color-coded heat.

**Action:** Hover one cell → tooltip shows mid/bid/ask + volume. Click the META $700 cell → switch back to browser tab 1 (`localhost:3000/trade/META/700`) which already shows that route.

**Talking points (pick 2):**
- "Whole MAG7 strike grid on one screen — pick any ticker × strike combo in two clicks. The matrix IS the trading entry point."
- "Heat color encodes implied probability — useful at a glance to spot mispricings or skew."
- "Click takes you to the trade page for that contract — which is what we have running here in the actual app."

---

### Scene 4 — Trade page Buy YES (1:30 - 2:15)  **[FLOW A: walk UI, do NOT submit; FLOW B: submit + approve]**

**On screen:** `localhost:3000/trade/META/700`. The v8 trade UI renders: left has order book (showing sample data — Cleo's `data-mock` attribute marks visual fixtures vs live data), right has the trade panel with Buy/Sell + Yes/No toggles + amount field + estimated cost + Submit button.

**Action [FLOW A]:** Walk the UI cursor through: toggle Buy / Sell, toggle Yes / No, type "$5" in the amount field, watch the estimated cost + fee + slippage update live. **Do NOT click Submit** — the handler currently throws `not yet wired` and a Phantom popup will not complete a trade. Narrate the flow as "and submit would..." rather than clicking.

**Action [FLOW B if wired]:** Type $5 amount → click Submit → Phantom popup → approve. Wait ~2s for confirm. Trade summary updates.

**Talking points (pick 2):**
- "Phoenix v1 is the matching engine — it's an existing audited CLOB on Solana. We don't run our own matching. DR-001 in the constitution explains why."
- "Buy YES is designed as a single atomic transaction: bundles mint_pair + a Phoenix swap of the NO half — user keeps the YES. Single wallet signature, single broadcast — POV-3 in the brain lift covers it."  *(FLOW A: "designed as"; FLOW B: "is")*
- "Fee math is tier-based — DR-008. New users pay 2%; volume over $10K drops to 1%. Creator of the strike pays 0% (creator rebate). All shown in the trade panel as you adjust the amount."

---

### Scene 5 — Sell flow + position monitor (2:15 - 2:35)  **[FLOW A: walk UI, FLOW B: submit]**

**On screen:** Same trade page. Toggle "Buy" → "Sell". Position monitor section shows current YES + NO holdings + realized PnL panel.

**Action [FLOW A]:** Toggle to Sell. Show the position monitor area. The "amount" field is now in YES/NO contracts rather than USDC.
**Action [FLOW B]:** Toggle Sell, enter 3 YES, see estimated payout, click Submit, Phantom approve, position updates to 2 YES held.

**Talking points (pick 2):**
- "Sell is the inverse — sells your YES tokens back to the Phoenix order book. Pre-settle, you can exit any time at the market price."
- "Realized PnL panel tracks settlement-equivalent value as the market price moves. Pure on-chain history; no off-chain bookkeeping."

---

### Scene 6 — Toggle Limit (2:35 - 2:50)  **[FLOW A only: walk UI]**

**On screen:** Order entry switches from Market to Limit. Price field appears. Order book on left shows where the order would sit if placed.

**Action [FLOW A]:** Toggle Limit, enter price $0.45, watch the book preview. Do NOT submit — limit orders are UI-shipped but the tx builder + Phoenix `getLimitOrderPacket` integration is queued for v1.5 per Cleo's branch.
**Action [FLOW B]:** Not applicable for v1 demo; limit submit isn't wired.

**Talking points (pick 2):**
- "Limit orders rest on Phoenix until filled or cancelled. The UI affords it today; the on-chain submit lands in the next sprint."
- "Order book reads directly from Phoenix via subscription — no polling. Updates the moment any fill happens (when live)."

---

### Scene 7 — Bell Pro briefing teaser (2:50 - 3:15)  **[FLOW A: switch to mockup; FLOW B: same since no Next.js page yet]**

**On screen:** Switch to mockup tab and scroll to the Bell Pro panel section, OR click the Bell Pro slide in the carousel.

**Action:** Show the AI-generated market briefing template — headline + 3-paragraph briefing + suggested-strike tags + "Subscribe to Pro" CTA via Helio.

**Talking points (pick 2):**
- "Bell Pro is the AI-tier subscription. The classification + retrieval flow generates a daily briefing per MAG7 ticker. Production schedule (morning-cron-driven) lands in v1.5; today the generator runs operator-on-demand via `pnpm briefings:gen`."
- "Subscription is paid via Helio — Solana-native USDC checkout. No credit card. We never touch fiat."
- "The briefing pipeline is independent of the trading pipeline — even if the AI is down, trading works normally."

---

### Scene 8 — Leaderboard with metric toggle (3:15 - 3:40)  **[FLOW A: mockup]**

**On screen:** Mockup tab Leaderboard section. Tab toggle: Profit | Streak | Win-Rate | ROI.

**Action:** Click through 2-3 metric tabs to show different leaders.

**Talking points (pick 2):**
- "Leaderboard tracks 4 metrics simultaneously — absolute profit, win streak, win rate, and ROI. Each surfaces a different kind of skill. Profit + streak + win-rate are live in Bram's indexer; ROI ships in v1.5 once the mint-volume capital data is indexed."
- "Rewards are paid from the protocol fee pool — DR-010 in the constitution. Weekly and monthly payouts to top-10 per metric. Distribution is verified by a Merkle proof committed on chain — anyone can audit the leaderboard."
- "Total of 128 paid positions per period (4 metrics × 10 + rollover). Fee split is 50% to platform, 25% to weekly pool, 25% to monthly pool."

---

### Scene 9 — Close (3:40 - 4:00)

**Talking points (pick 2):**
- "Stack: Anchor on Solana devnet, Phoenix v1 CLOB, Pyth oracle, Next.js frontend, Trigger.dev cron, Neon Postgres for the leaderboard indexer."
- "20-instruction program with 41 error variants — built across 5 devnet deploys with 5 independent Sonnet audit cycles + 14 substantive fixes shipped."
- "Mainnet path: `pre-mainnet-readiness.md` documents the 6 gaps that remain. Today's demo is the devnet evidence."

---

## Q&A defense — anticipated pushbacks

### "What if your cron crashes mid-settle?"
→ Switch to a terminal. Run `node scripts/simulate-trading-day.mjs --kill-cron-at=phase3`. Watch the JSON log emit Bram's exact exhausted-state shape + a fresh keypair successfully cranks settle. Cite DR-002 — settle_market is permissionless by design. Strongest chain-level evidence: `tests/integration/deploy-5-lifecycle.mjs` simulation returned `PythStale (6009)` from a non-admin signer, proving the handler bypassed the absent admin check + evaluated-and-passed NotExpired before hitting Pyth.

### "How do you know the $1 USDC invariant holds?"
→ `scripts/simulate-trading-day.mjs` runs 3 outcome modes (yes/no/invalid) with 5 invariants checked per Phase 5. 63 mocha eval tests + 100/100 Rust property tests cover the math. Sonnet-audit-3 caught a tier-scaling drift that would have broken the invariant under promo-mode fee config; fixed before this demo.

### "What's your security audit story?"
→ `docs/architecture/pre-mainnet-readiness.md` §6 — 13-attack hostile-tester analysis. 11 defended with named test evidence. 1 weakly defended (uneconomic wash-trade for tier gaming). 1 explicit accepted gap (Sybil-mint on the leaderboard — DR-014 social linking + KYC at high-payout tiers mitigate in v2). **No independent third-party audit yet** — that's the #1 mainnet blocker.

### "What if Phoenix has an outage?"
→ DR-009 explicitly accepts the dependency. Phoenix v1 is audited; our settle path doesn't depend on Phoenix (only the trading path does). If Phoenix is down, users can't trade in/out of positions on Phoenix but they CAN still mint_pair + redeem at settle. Trade-off + alternatives documented in DR-009.

### "Show me an actual on-chain transaction"
→ Two evidence levels:
- **Program deploy** (proves devnet deployment): `4rQq81zAxwM9ME4qXdnhuMsJMHWqqwqU7A8aBqHm4urmKPkkw9PX8uupsHXifuhfMwWDNcYLeU4TGF3yCKrkGEss` — pull up Solana Explorer. This is the deploy-5 tx; proves the program lives on devnet at the cited address. **Not a trade transaction.**
- **Lifecycle invariants** (proves trade/settle/redeem math): run `LIVE_DEMO=1 bash scripts/one-command-demo.sh` — exercises mock-mode lifecycle + the real chain-level DR-002 evidence test.
- **A real on-chain trade tx**: only available if Flow B (Cleo's submit handlers wired) — would be the Phantom-approved tx from Scene 4.

### "Why no v2 features yet?"
→ DR-014 (social linking) + DR-015 (multi-metric leaderboard) + `force_redeem_invalid` + Pyth Receiver Program + multi-sig admin are all queued and specced. v1 demo is the trading-protocol + invariant evidence. v2 is the retention layer.

### "Is the live app fully wired?"
→ Honest answer: trade-page UI is shipped, trade-submit handlers throw `not yet wired` as of Saturday evening. Cleo is actively shipping; if it's wired by Sunday morning we run Flow B (the full live Phantom-approved flow). If not, we use Flow A — visual design via mockups + on-chain evidence via terminal. **The protocol on chain is fully functional** (20 ix deployed, 76-test surface verified); the frontend wiring lags by one sprint. v1.5 closes the gap.

---

## Pre-recording (Sat 5/24 night, before Sunday demo)

1. **Re-evaluate flow choice** — what did Cleo land Sat night? If trade-submit wired → Flow B / C. If not → Flow A.
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

This script went through Sonnet-audit-6 (Day-6 round 1) which caught the original draft's over-claims on functionality. Specifically: trade-submit handlers throw `not yet wired` for every path; landing carousel + probability matrix don't exist in shipped Next.js; Bell Pro morning cron is not registered; leaderboard ROI metric is an explicit stub. The current revision restructures the script into three flows (A/B/C) with explicit honesty about what's mockup vs running app vs terminal evidence. **Re-audit before Sunday recording.**
