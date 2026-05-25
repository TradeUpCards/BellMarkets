# BellMarkets v1 Demo Script

**Target:** Sun 2026-05-25 5:00 PM ET (Gauntlet cohort submission)
**Owner:** Drew (script) + presenter TBD (probably Cory or Tate)
**Length:** 3-5 minutes (target 4:00)
**Format:** Live walkthrough preferred; pre-recorded backup at `docs/demo/recording-assets/v1-demo.mp4` (TODO Sat night)

**FINAL FLOW DECISION (Sun 2026-05-25, post-smoke #3 against main @ `91bb75d`):**

> **Flow C is the chosen flow.** Cleo shipped the two critical surfaces in the merge to main: (a) v8 trade page Buy×Yes wired through `buildMintPairTx` against live devnet, (b) v8 landing page with probability matrix + leaderboard + Bell Pro + Recent Fills. Other 3 trade actions (Buy×No / Sell×Yes / Sell×No) give an honest "Phoenix CLOB binding pending — Buy YES via mint_pair is the live demo path. The other three actions ship in v1.1." rather than throwing. Smoke #3 verdict: GREEN (`cleo-smoke-issues.md` ⇒ "Smoke run #3"). All 9 routes 200; NextAuth routes return well-formed JSON; typecheck PASS; production build PASS; 347 Bram + 63 Drew unit tests green.

What this means for the presenter:
- **Scenes 1, 4, 5, 9 — run LIVE** on `localhost:3000/trade/META/700` (or whichever port the dev server picks if 3000 is busy — smoke #3 saw port 3003 on a multi-worktree dev machine; pre-flight check below).
- **Scenes 2, 3, 7, 8 — run LIVE** on `localhost:3000/` (the v8 landing IS in Next.js now; you do NOT need the mockup HTML for these).
- **Scene 6 (Limit toggle)** — walk the UI; **do NOT submit** (limit submit + Phoenix `getLimitOrderPacket` ships v1.1).
- **Scenes 4 + 5 caveat** — when toggling to Buy×No / Sell×Yes / Sell×No to show the side+outcome state machine, narrate "and the other three actions ship in v1.1 — Phoenix binding to the BellMarkets strike's quote mint is the outstanding work" rather than clicking submit on them. The only Submit click that actually broadcasts is **Buy YES via mint_pair**.

**Caveats the presenter must NOT skip:**
- Bell Pro card on the landing shows the upgrade pitch + 4 feature bullets — it does NOT render live AI briefing content. The Sonnet-generated briefings DO exist (Bram's `pnpm briefings:gen` populates Neon table `briefings`; 7 LIVE briefings persisted as of the demo-eve smoke), but no Next.js consumer hook reads them yet. Scene 7 talking point already covers this: "Production schedule (morning-cron-driven) lands in v1.5; today the generator runs operator-on-demand via `pnpm briefings:gen`."
- Probability matrix + leaderboard + Recent Fills are STATIC FIXTURE data (Cleo's own `STATIC FIXTURE` code comments at `landing-view.tsx:30, 161`). The visual design ships; the wire-to-live `useAllMarkets() / useLeaderboard() / useFills()` lands v1.5.
- Leaderboard ROI metric is an explicit stub (`metric-leaderboards.ts:topRoiLeaderboard()` returns `[]` until v1.5 mint-volume capital indexing). Scene 8 talking point already calls this out: "Profit + streak + win-rate are live in Bram's indexer; ROI ships in v1.5."

**Fallback to Flow A** (mockup HTML) ONLY needed if: the live dev server fails to start, OR the devnet Pyth SOL/USD feed staleness scope changes the Buy×Yes path, OR Phantom approval flow breaks in the presenter's browser. Pre-flight checks below cover these gates.

The three flow definitions below are preserved for posterity but Flow C is what we run.

- **Flow A — Mockup walk-through** (FALLBACK): walk reviewers through the v8 mockup HTML files for the visual design, demonstrate the actually-shipped trade-view UI rendering, and pivot to terminal evidence for the on-chain lifecycle proofs.
- **Flow B — Live trade flow** (NOT chosen — would require Buy×No / Sell×Yes / Sell×No also wired): the full Buy YES → Confirm → Settle → Redeem path PLUS the other 3 trade actions in the running app.
- **Flow C — Hybrid** (CHOSEN — what we run): Live Buy×Yes trade + live landing + screen-recorded mockup ONLY for the deferred Sell/No paths if a reviewer asks to see them.

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
- [ ] **One browser tab open** (Flow C — chosen): `localhost:3000/` (v8 landing + Bell Pro + leaderboard + Recent Fills live). Trade page navigates from matrix click in Scene 3 → `localhost:3000/trade/META/700`. **Mockup HTML tab only needed as fallback if dev server fails to start** — open `apps/web/public/mockups/v8-landing.html` via `file://` only then.
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

**On screen:** Browser tab 1 (`localhost:3000/trade/META/700`). v8-themed trade page renders.

**Action:** Click "Connect Wallet" in top-right → Phantom popup → approve → wallet pubkey shows.

**Talking points (pick 2):**
- "BellMarkets is a non-custodial Solana dApp. Binary outcome contracts on daily MAG7 stock prices. Will META close above $700 today? Mint a pair of YES + NO tokens for $1 USDC each, trade them on a real CLOB, redeem the winning side for $1 at settle."
- "Connecting a wallet is enough to trade — no email, no KYC, no custody. The marketing layer (email + social linking) is opt-in at the moment you claim a reward, not before."
- "All settlement happens on chain at 4 PM ET via Pyth. Cron's job is to be the convenience nudger, not the authority — we'll see why that matters in Q&A."

---

### Scene 2 — Landing hero + ticker marquee (0:25 - 1:00)  **[FLOW C: live Next.js]**

**On screen:** Navigate to `localhost:3000/` (v8 landing — shipped in Next.js as of merge `13a8481`). CNBC-style ticker marquee at top scrolls 7 MAG7 names. Hero card centerpiece below. **Note: dev server may pick a port other than 3000 if other workspaces hold it; check the actual port from `pnpm dev` output.**

**Action:** Let the ticker marquee play for ~3 seconds (each MAG7 ticker + spot + day-change scrolls past). Scroll down past the hero card to reveal the probability matrix below.

**Talking points (pick 2):**
- "Bloomberg-style left rail navigates markets by ticker — MAG7 grouped at the top. Top tickers show spot + implied YES% for the ATM strike."
- "Session block on the right counts down to today's 4 PM ET settle window. When the cron fires, every expired market gets settled in one batch — but if the cron dies, any user can crank settle themselves. We'll cover the architecture in Q&A."
- "Carousel rotates between the 4 product surfaces. The visual you're seeing is the v8 design lock; the Next.js implementation lands this weekend with the trade page first."

---

### Scene 3 — Probability matrix → trade page (1:00 - 1:30)  **[FLOW C: live Next.js]**

**On screen:** Still on `localhost:3000/`, scrolled to the probability matrix. 4 MAG7 rows × 7 strikes = 28 cells visible (META, NVDA, AAPL, MSFT). Each cell shows implied YES% for that strike. Color-coded heat (deep green at high probability → red at low). ATM strike highlighted.

**Action:** Hover one cell (e.g. META $700, ~28% implied). Click the META $700 cell — actually navigate to `localhost:3000/trade/META/700` (the matrix is a live nav surface; cells are real links).

**Caveat to narrate (optional, if reviewer asks):** "The matrix data is currently a static fixture — the design ships today; the wire-to-live `useAllMarkets()` per row is v1.5 work. The trade-page route IS live and reads from chain."

**Talking points (pick 2):**
- "Whole MAG7 strike grid on one screen — pick any ticker × strike combo in two clicks. The matrix IS the trading entry point."
- "Heat color encodes implied probability — useful at a glance to spot mispricings or skew."
- "Click takes you to the trade page for that contract — which is what we have running here in the actual app."

---

### Scene 4 — Trade page Buy YES — LIVE BROADCAST (1:30 - 2:15)  **[FLOW C: live submit on Buy×Yes]**

**On screen:** `localhost:3000/trade/META/700`. v8 trade UI: left = order book (Cleo's `data-mock` attribute marks visual fixtures), right = trade panel with Buy/Sell + Yes/No toggles + amount field + estimated cost + Submit.

**Action:** Side = Buy (default). Outcome = YES (default). Type "$5" in the amount field. Watch the estimated cost + fee + slippage update live. **Click Submit** → Phantom popup → approve. The `buildMintPairTx` flow broadcasts a real `mint_pair` instruction to devnet against the live `StrikeMarket` PDA for META @ $700 (provided Bram's morning create-markets job created it today; otherwise the trade panel shows "No on-chain StrikeMarket found for META @ $700. Bram's morning job creates these daily." — pre-flight check below mitigates).

Wait ~2s for tx confirmation. The submitResult banner shows `Submitted! <16-char sig prefix>… (confirming)` in success-green (Cleo's audit-P1 fix distinguishes success/error states).

**Action — toggle the OTHER paths (don't submit):** Toggle to Buy×No, then Sell×Yes, then Sell×No. Watch the trade panel adjust. **Do NOT click Submit on these.** When you toggle to Sell×Yes (or any non-Buy-Yes path), if you do click Submit, the result banner shows: "Phoenix CLOB binding pending — Buy YES via mint_pair is the live demo path. The other three actions ship in v1.1." This is honest UX, not an error.

**Talking points (pick 2):**
- "Phoenix v1 is the matching engine — it's an existing audited CLOB on Solana. We don't run our own matching. DR-001 in the constitution explains why."
- "Buy YES is shipping today as a `mint_pair` — the user receives equal YES + NO from the protocol vault. The atomic Buy YES design (bundles `mint_pair` + a Phoenix swap of the NO half) ships in v1.1 once Phoenix is bound to the BellMarkets strike's quote mint. POV-3 in the brain lift covers the full atomic design."
- "Fee math is tier-based — DR-008. New users pay 2%; volume over $10K drops to 1%. Creator of the strike pays 0% (creator rebate). All shown in the trade panel as you adjust the amount."

---

### Scene 5 — Sell flow + position monitor (2:15 - 2:35)  **[FLOW C: walk UI, narrate v1.1 deferral]**

**On screen:** Same trade page. Toggle "Buy" → "Sell". Position monitor section shows current YES + NO holdings + realized PnL panel.

**Action:** Toggle to Sell. Show the position monitor area. The "amount" field is now in YES/NO contracts rather than USDC. **Do NOT click Submit** — the Sell flows ship v1.1 with Phoenix CLOB binding; if you click, the result banner explains the same.

**Talking points (pick 2):**
- "Sell is the inverse — sells your YES tokens back to the Phoenix order book. Pre-settle, you can exit any time at the market price. The on-chain ix shipping in v1.1 is `redeem_pair` (Aria's Day-4 deploy) combined with a Phoenix swap; the UI shipped today reads the position correctly."
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

### Scene 7 — Bell Pro panel + Recent Fills (2:50 - 3:15)  **[FLOW C: live Next.js landing]**

**On screen:** Navigate back to `localhost:3000/`, scroll down past the leaderboard to the Bell Pro + Recent Fills row. Bell Pro panel on the left shows the upgrade pitch (✦ Bell Pro · AI briefings + analytics — $9 / mo CTA + 4 bullets: Daily AI briefings on the 7 MAG7 names / Bell Sense / Win-streak boosts / Priority support). Recent Fills panel on the right shows the live tape table.

**Caveat to narrate (Q&A only — don't volunteer):** "The card shows the upgrade pitch; the actual briefing content is generated server-side and persisted to Neon — 7 LIVE Sonnet briefings exist today. Wiring the content into a Bell-Pro-gated section ships v1.5. Recent Fills is static fixture today; live tape from Helius webhook ships v1.5."

**Action:** Hover the "Upgrade · $9 / mo →" button. The CTA links to `/settings#billing` — Helio checkout integration is wired in `apps/web/app/api/billing/route.ts` + `apps/web/src/lib/billing/helio.ts`.

**Talking points (pick 2):**
- "Bell Pro is the AI-tier subscription. The classification + retrieval flow generates a daily briefing per MAG7 ticker — 7 LIVE briefings exist in Neon today, generated via `pnpm briefings:gen` against live Pyth Hermes spot prices + Sonnet 4.6. Production schedule (morning-cron-driven) lands in v1.5."
- "Subscription is paid via Helio — Solana-native USDC checkout. No credit card. We never touch fiat."
- "The briefing pipeline is independent of the trading pipeline — even if the AI is down, trading works normally."

---

### Scene 8 — Leaderboard with metric toggle (3:15 - 3:40)  **[FLOW C: live Next.js landing]**

**On screen:** Scroll up on `localhost:3000/` to the Leaderboard + Contests row (between the matrix and Bell Pro). Tab toggle: Profit | Streak | Win-Rate.

**Action:** Click through Profit → Streak → Win-Rate tabs to show different leaders. (ROI tab not shown — it's an explicit v1.5 stub.)

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
→ Master security model is `constitution/decisions.md` DR-017: PDA self-authority on every fund-moving account + Anchor account constraints validated before handler entry + permissionless `settle_market` + admin-as-cranker-not-redirector. The canonical "where can vault USDC go?" has a finite answer: winning user via redeem, pair-burner via redeem_pair, invalid-market refund via redeem_invalid, fee_collector via mint_pair fee. **No `withdraw_to_admin` instruction exists; no path was ever drafted.** The 13-attack hostile-tester analysis in `docs/architecture/pre-mainnet-readiness.md` §6 stress-tests that model: 11 defended with named test evidence, 1 weakly defended (uneconomic wash-trade for tier gaming — DR-009 amendment closes the Phoenix-secondary-trade fee surface at v1.5 P0), 1 explicit accepted gap (Sybil-mint on the leaderboard — DR-014 social linking + KYC at high-payout tiers mitigate in v2). **No independent third-party audit yet** — that's the #1 mainnet blocker.

### "What if Phoenix has an outage?"
→ DR-009 explicitly accepts the dependency. Phoenix v1 is audited; our settle path doesn't depend on Phoenix (only the trading path does). If Phoenix is down, users can't trade in/out of positions on Phoenix but they CAN still mint_pair + redeem at settle. Trade-off + alternatives documented in DR-009. **DR-009 amendment 2026-05-24** also locks the v1.5 P0 Model D plan (per-market `fee_receiver` set via `phoenix::InitializeMarket` CPI) — verified feasible cross-lead (Bram off-chain + Aria on-chain primary source). The Phoenix-secondary-trade fee gap is *engineered, not aspirational*.

### "Show me an actual on-chain transaction"
→ Two evidence levels:
- **Program deploy** (proves devnet deployment): `4rQq81zAxwM9ME4qXdnhuMsJMHWqqwqU7A8aBqHm4urmKPkkw9PX8uupsHXifuhfMwWDNcYLeU4TGF3yCKrkGEss` — pull up Solana Explorer. This is the deploy-5 tx; proves the program lives on devnet at the cited address. **Not a trade transaction.**
- **Lifecycle invariants** (proves trade/settle/redeem math): run `LIVE_DEMO=1 bash scripts/one-command-demo.sh` — exercises mock-mode lifecycle + the real chain-level DR-002 evidence test.
- **A real on-chain trade tx**: only available if Flow B (Cleo's submit handlers wired) — would be the Phantom-approved tx from Scene 4.

### "Why no v2 features yet?"
→ DR-014 (social linking) + DR-015 (multi-metric leaderboard) + `force_redeem_invalid` + Pyth Receiver Program + multi-sig admin are all queued and specced. v1 demo is the trading-protocol + invariant evidence. v2 is the retention layer.

### "Is the live app fully wired?"
→ Honest answer: as of merge `91bb75d` on Sun 2026-05-25, the v8 landing + trade UI ARE shipped in Next.js. **Buy YES is fully wired through `buildMintPairTx` → `wallet.sendTransaction` against live devnet** — that's the live demo path you just saw. The other three trade actions (Buy NO, Sell YES, Sell NO) ship in v1.1 with Phoenix CLOB binding; today the trade panel returns "Phoenix CLOB binding pending" rather than throwing. Landing page sections (matrix, leaderboard, Recent Fills, Bell Pro card) ship with static fixture data; live-data wiring (`useAllMarkets`, `useLeaderboard`, `useFills`, `useLatestBriefing`) lands v1.5. **The protocol on chain is fully functional** (20 ix deployed across 6 audited devnet deploys, 76-test surface verified, 5 Sonnet audit cycles with 14 substantive fixes); the frontend Phoenix-binding work is the last gap to ship.

---

## Pre-recording (Sat 5/24 night, before Sunday demo)

1. **Flow choice already locked = Flow C** (Sun smoke #3 verdict; see header). Re-evaluate ONLY if smoke #3 evidence becomes stale (Cleo pushes that revert wiring, dev server fails to start, devnet flake). Default = Flow C.
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
- **Smoke #3 + Flow-C lock** (Sun 2026-05-25, this revision): post-merge smoke against main `91bb75d` confirmed Cleo shipped the two critical surfaces (trade Buy×Yes wiring + v8 landing). Flow C is now the chosen flow. Scene-level FLOW markers updated to reflect the live state. Bell Pro card honesty preserved (still doesn't show live briefing content — v1.5 gap, scripted into Scene 7 Q&A).

Re-audit AGAIN if any pre-flight check fails on Sunday afternoon — devnet flakes, Pyth-stale, dev-server-port surprises are the three known fragile points.
