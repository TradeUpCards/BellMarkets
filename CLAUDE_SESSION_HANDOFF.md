# Claude Session Handoff — BellMarkets

**Date:** 2026-05-23 (Fri night → Sat morning — post-architectural-lock session)
**Session phase:** **Architecture phase COMPLETE. 11 Decision Records locked. All 4 lead dispatch prompts written + ready to paste. Mockup design lock + AI v2 plan deferred to Sat morning resume.**
**Next hard gate:** Mon 2026-05-25 7:00 PM ET (final). MVP demo target sometime Sun/Mon.
**Current branch / SHA:** `main` @ `2827292` (DR-008 creator rebate configurable). ~30 commits today; all pushed to GitLab + GitHub.

---

## TATE — START HERE ON RESUME

This session ended after a long architectural strategy sweep. Four things to do FIRST when you resume:

1. **Check if Cory dispatched the 4 leads tonight.** Look at recent commits on `main` and each lead branch (`crt/aria-init`, `crt/bram-init`, `crt/cleo-init`, `crt/drew-init`). If leads have committed work, merge to main.
2. **Read the 4 lead handoffs** at `.project/bell-markets/handoffs/{aria,bram,cleo,drew}-handoff.md` for their latest state.
3. **Mockup design lock** is the highest-leverage pending decision. Cleo's visual work blocks on it. v6 (Pulse / orange) and v7 (Terminal / cyan) are the front-runners — see `apps/web/public/mockups/` + `.project/bell-markets/coordination/design-feedback-cory.md`. Cory wanted more rounds before locking.
4. **AI v2 plan is OUTSTANDING.** Cory's last question before stopping: "as v2 feature, how might we implement an AI agent into this platform?" — research on MAG7, user trading analytics, winning strategies, etc. Also asked about freemium pricing model. **One research agent was launched and may still be running** — see "Background work" section below. Resume with a comprehensive AI v2 plan as the first synthesis.

---

## What got locked in this session (11 Decision Records)

DR-001 through DR-004 were already locked before this session. DR-005 through DR-011 + Tier-1 work were locked in this session. Total new scope: ~32-38 hr cross-lead work.

| DR | Title | Owner |
|---|---|---|
| DR-005 | User-funded strike PDA creation (Meteora DLMM pattern) | Aria |
| DR-006 | Strike-grid evolution schedule (post-close anchor + AH/PM wild-swing checks) | Bram |
| DR-007 | Trading calendar (weekends/full holidays/half-days at 1 PM ET) | Bram + light Aria |
| DR-008 | Mint-side 2% fee + creator rebate (configurable, 100% default) + 30-day volume tier | Aria/Drew/Cleo |
| DR-009 | Phoenix v1 CLOB strategy + Model D venue-fee investigation | Bram (research) |
| DR-010 | Win-streak rewards: 50/25/25 fee split, top-10 distribution, Merkle commitment + Arweave pinning + Neon Postgres | Cross-lead |
| DR-011 | Earnings-calendar pre-expansion (hardcoded MAG7 2026 dates) | Bram |

Plus Tier-1 ad-hoc work:
- Open orders + cancellation UI (Cleo, ~2 hr post-design-lock)
- Slippage slider + computed-price display (Cleo, ~30 min)
- Devnet faucet CTAs USDC + SOL (Cleo, ~20 min)
- `force_redeem` + `close_settled_market` instructions + ATA hygiene (Aria + Drew, ~1.75 hr)
- Jupiter+Phoenix-fallback SOL→USDC swap (Cleo, ~2.5 hr)

Plus supporting doc:
- `specs/clob-strategy.md` (CLOB build-vs-fork-vs-Phoenix analysis at scale)
- `.project/bell-markets/coordination/cory_questions_1_answers.md` (strategic Q&A — full cost analysis of stranded balances, fee model justification, etc.)

---

## Dispatch prompts (ready to fire)

I wrote 4 paste-ready dispatch prompts before stopping. They're in this conversation but if you need to recreate them, they cover:

**Aria** (~9-12 hr): DR-005 + StrikeMarket.creator field (Priority 1), DR-008 fee+UserConfig (P2), DR-010 on-chain win-streak pieces (P3), Tier-1 force_redeem + close_settled (P4), redeploy + audit log (P5).

**Bram** (~8-10 hr): DR-009 Model D investigation (~30-45 min discovery FIRST), DR-007 trading calendar, DR-006 19-fires/day cron refactor, DR-010 off-chain (Helius webhooks + Neon Postgres + Merkle tree + Arweave pinning + period crons), DR-011 earnings calendar.

**Drew** (~3-4 hr): Continue HY-5 cron-failure-path doc, reconcile mock against Aria's IDL refresh, property tests for new ixs, live program rewire with new flows + earnings-day scenario.

**Cleo** (~3-4 hr DESIGN-AGNOSTIC ONLY): New tx builders (user_create_strike, sellNo, cancelOrder, smart SOL→USDC swap), updated mint_pair builder with ATA hygiene, new hooks (TickerConfig, UserConfig, OpenOrders, RewardsPool), view-model types. **Critical directive: NO visual work — design not locked. No Trade panel layout, no color/typography, no page composition.**

Cory ran sync commands on all 4 worktrees before stopping. State at session end:
- Aria + Bram: 22-23 unpushed commits (the docs commits from main merged in; nothing lost)
- Cleo: 25 unpushed (her Day-2/3 work + docs)
- Drew: 0 unpushed (Day-4 work already pushed)

All committed work is preserved. Sync command was safe.

---

## Background work (may still be running)

Before stopping, I launched 2 research agents for the AI v2 plan:

1. **Trading platforms AI features research** (agent ID `ae7e3317e4304ea92`) — **COMPLETED** while writing this handoff. Full output preserved at `.project/bell-markets/coordination/ai-v2-research-notes.md`. Covers: TradFi (Robinhood Cortex, Webull Vega, TradeStation MCP+Claude, Schwab, eToro Tori, Tastytrade), institutional (Bloomberg ASKB, TradingView Copilot), DeFi (Hyperliquid agent ecosystem, Polymarket Rust CLI, ElizaOS / Virtuals, Predictool/JogoJogo on Solana), feature-by-feature what-works analysis, full regulatory landscape (SEC IAA-1940, FINRA Notice 24-09, CFTC Feb 2026 prediction-market guidance), and a 6-item recommended v2 feature priority ranking. **Read that file first when synthesizing the v2 plan.**

2. **Solana AI agent infrastructure research** (agent ID `a8bad160aee31a891`) — **DID NOT RUN**. Hit API rate limit at 0 tokens. Needs to be re-launched on resume to fill the gap on: Anthropic Claude API stack details (Tool Use, Agent SDK), Solana AI frameworks (ElizaOS / SendAI / Senpi Skills technical details), orchestration patterns, on-chain ZK-ML for verifiable signals, cost projections by tier.

**On resume:**
- Read `.project/bell-markets/coordination/ai-v2-research-notes.md` for the trading-platform landscape
- Re-launch the Solana agent infrastructure research to complete the picture
- Synthesize both into the comprehensive v2 plan + freemium pricing model

---

## Cory's specific AI v2 ask (PENDING — synthesize on resume)

> "as v2 feature, how might we implement an AI agent into this platform? Research on MAG7 companies, upcoming events, trend analysis, etc? User stats and analysis on their trading behavior? Tips for winning strategies? Give me a list of things we could implement and a plan for doing so. I want this to be comprehensive, so deploy research agents if you need to. Impress me."

> "also think about pricing models. I'm thinking some kind of freemium model"

What I owe Cory on resume (comprehensive synthesis):
1. **Feature catalog** organized by category — market intelligence (research, news, sentiment, earnings analysis), user behavior analytics, trade signal generation, educational/conversational, autonomous agents
2. **Technical architecture** — Anthropic Claude API stack (Tool Use, Agent SDK), Helius event triggers, Neon for analytics state, integration with existing Pyth + Phoenix data
3. **Implementation roadmap** — phased rollout (read-only intelligence → strategy recommendations → limited automation → autonomous agents)
4. **Compliance considerations** — SEC robo-advisor rules, "informational not advice" framing, geo-fencing implications
5. **Freemium pricing model** — free tier features vs paid tier features vs SOL-token-gated tier; per-month subscription? Per-feature unlocks? Token-utility model? Compare to similar platforms
6. **Specific stack recommendations** — Anthropic Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5 by use case, with cost estimates
7. **Differentiation moat** — why this matters for BellMarkets vs Polymarket/Kalshi
8. **Demo value** — could AI features be partially demoed even before MVP?

The plan should be impressive but practical. Cory wants "comprehensive" but also "v2" — so distinguish "must build first" from "nice to have later."

---

## Operator state at handoff

| | State |
|---|---|
| **Toolchain** | WSL2 Ubuntu-24.04 with Solana 3.1.14 + Anchor 0.31.1 (per LESSONS.md). Unchanged this session. |
| **Worktrees** | All 4 lead worktrees synced to `origin/main` (Cory ran sync commands). Local commits ahead of origin/main visible per `git log` per worktree. |
| **Devnet program** | `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` (unchanged this session; Aria will redeploy after DR-005-011 work) |
| **MarketConfig PDA** | `6CYzWhTMzsndRrnRcHgWCUfVDvrRh3Cfoze6GSVev9gQ` (initialized 2026-05-22; admin verified) |
| **Keypairs** | Spread across all 5 worktree `keys/` dirs + OneDrive backup at `~/OneDrive/Documents/GauntletAI/BellMarkets/keys-backup/`. Drew's admin keypair funded 0.5 SOL by Aria earlier. |
| **Mockups** | 7 candidates at `apps/web/public/mockups/` (v1-v5 round 1 + v6-v7 round 2 feedback-driven). Compare hub at `mockups/index.html` + side-by-side at `compare-{landing,trade}.html`. |
| **Design feedback** | Cory's notes at `.project/bell-markets/coordination/design-feedback-cory.md`. Lean: Linear orange (#1), Bloomberg cyan (#2). Asked for "wow, modern, beautiful, functional" + degen-trader narrative. |
| **In-flight notes** | `.project/bell-markets/in-flight.md` has cross-workstream notes through 2026-05-22 mid-day. Doesn't have the architectural decisions from this session — those are in `constitution/decisions.md`. |

---

## Recommended sequence on next session start

1. `git status` + `git log --oneline -10` to see what's landed overnight from lead dispatches (if Cory dispatched)
2. Read lead handoffs to assess overnight progress
3. Check agent `ae7e3317e4304ea92` status (research agent for trading platforms)
4. Synthesize AI v2 plan (Cory's pending ask) — incorporate research agent output + freemium pricing model
5. Surface the AI v2 plan + recommend whether to lock + add as DR-012 or keep as v2 roadmap
6. Discuss mockup direction with Cory (if he's ready) and finalize design lock
7. If design is locked, write Cleo's visual-layer dispatch prompt

---

## Files modified this session (mostly docs)

```
constitution/decisions.md                      (added DR-005 through DR-011 — 7 new DRs + DR-008 amendments)
specs/clob-strategy.md                         (new — full Phoenix vs fork vs build analysis)
.project/bell-markets/coordination/cory_questions_1_answers.md  (extensive strategic Q&A doc)
.project/bell-markets/coordination/design-feedback-cory.md       (Cory's mockup feedback)
```

---

## Hard rules respected

- No secrets / API keys / mnemonics in any committed file
- No mainnet program IDs (`599h7V...` is devnet only)
- No live stock prices in tests (mocked Pyth feeds only per Hard NO #12)
- All admin actions still flow through `7b17F...Lprp5` platform admin keypair
- No backwards-compatibility shims added to existing instructions
- All 11 new DRs reference existing DRs they compose with

---

## Aria's queued work depends on this sequence

Aria's first action: Priority 1 in her dispatch prompt — `user_create_strike_market` + TickerConfig PDA + StrikeMarket.creator field + IDL refresh push. Other 3 leads block on her IDL push.

Bram can start Priority 1 (Model D investigation) and Priority 2 (trading calendar) without waiting on Aria.

Drew can start her HY-5 demo doc work without waiting.

Cleo's most work is non-IDL plumbing; she can start the new tx builders + new hooks (logic only, no UI).

Once Aria pushes IDL refresh → Drew updates mock + Cleo copies IDL → full implementation parallelism unlocks.

---

## Session ended on Cory's request for clear

Cory said "stop what you're doing. do handoff update so we can clear and then start this." This handoff captures everything needed to resume cleanly. The AI v2 plan is the load-bearing next deliverable. After that: mockup design lock + dispatch Cleo for visual layer.

**Total decision velocity this session: 11 DRs locked, 1 supporting spec doc, ~32-38 hr scope queued for team. Substantial.**
