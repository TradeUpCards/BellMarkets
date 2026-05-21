# BellMarkets — Deferred

> What we explicitly chose NOT to build (or NOT to build *yet*) — with
> rationale and revisit threshold. The opposite of a wish list: every
> entry here was considered and deliberately declined.

## Why this file matters

1. **Defensible deferrals are different from gaps.** A grader / partner / future-maintainer who reads "we didn't ship X" will assume neglect unless the doc says "we chose not to ship X because Y." This file is that doc.
2. **Revisit thresholds prevent indefinite deferral.** A deferral without a re-evaluation trigger becomes an indefinite punt.

---

## Deferred entries

### Custom on-chain matching engine

**Status:** Deferred to v2 (post-MVP)
**Decided in:** `constitution/decisions.md` DR-001
**Decided on:** 2026-05-21

**What we considered:** Building a price-time-priority matching engine inside the Anchor program — making the BellMarkets program a self-contained CLOB rather than integrating Phoenix.

**Why deferred:**
- 3-day build window. Phoenix integration is ~half a day; rolling our own matcher is conservatively 1.5–2 days plus extensive testing for fill / partial-fill / self-trade correctness.
- Audited matching logic from Phoenix is more trustworthy than first-week-old code from us for the $1 USDC invariant boundary.
- PRD explicitly accepts integration as a valid path: *"Use an existing on-chain CLOB already deployed on your chosen chain (e.g., Phoenix on Solana)."*

**Trade-off accepted:** Weaker "we built our own matching engine" narrative in interviews. Tied to Phoenix as a hard dependency (no fallback CLOB).

**Revisit threshold:** Post-MVP, only if (a) the cohort scope expands to include a custom-CLOB requirement, or (b) Phoenix's roadmap deprecates a feature we depend on. Otherwise, this stays deferred indefinitely.

**Re-evaluation owner:** Aria + Tate. If Phoenix deprecates anything on the integration path, Aria raises and Tate decides whether to ship the custom matcher or migrate to OpenBook v2.

---

### Mainnet-beta deployment

**Status:** Deferred to post-submission stretch goal
**Decided in:** BRAINLIFT.md §1 "Stretch goal"; reinforced by `constitution/hard-rules.md` §1.1
**Decided on:** 2026-05-21

**What we considered:** Deploying the full system to Solana mainnet-beta with funded automation wallet, production Pyth feeds, monitoring + alerting, and real (small-value) USDC liquidity for a public demo.

**Why deferred:**
- PRD explicitly forbids real funds for the core submission. Mainnet introduces custody and irreversible-loss risk we are not equipped to handle on a 3-day build window.
- Mainnet ops surface (monitoring, alerting, key rotation, funded hot wallet) is a separate, sustained operational commitment — not a build artifact.
- A devnet demo proves the design works. Mainnet proves nothing different until real users are exposed to real money, which is a different project.

**Trade-off accepted:** No production-ready evidence in the submission. Reviewers see devnet only.

**Revisit threshold:** Post-submission. Only after (a) the core submission is graded, (b) the team has uninterrupted time for mainnet ops setup, and (c) a clear public-demo case exists. Likely never re-evaluated unless the project continues beyond the cohort.

**Re-evaluation owner:** Cory (Tate). If the project survives the cohort and becomes a portfolio piece, Tate decides whether mainnet is worth the ongoing ops burden.

---

### Fallback oracle (Switchboard or other)

**Status:** Deferred indefinitely; admin override is the intentional recovery path
**Decided in:** `constitution/decisions.md` DR-003; reinforced by `constitution/hard-rules.md` §4.3
**Decided on:** 2026-05-21

**What we considered:** Adding Switchboard as a secondary oracle, so that if Pyth has a settlement-window outage, settlement can fall through to Switchboard automatically without admin intervention.

**Why deferred:**
- Doubles the integration surface area for a vanishingly rare failure mode (Pyth has high uptime on Solana).
- Admin override (`admin_settle`, time-delayed per Hard YES #7) is the intentional safety valve. Having an automatic-fallback oracle dilutes the "human in the loop for oracle failure" discipline.
- Switchboard's MAG7 equity coverage is thinner than Pyth's. Even if we wired it up, we'd be missing feeds for the same stocks we'd care about during a Pyth outage.

**Trade-off accepted:** If Pyth has a settlement-window outage, markets don't settle automatically — admin override is required (after the 1hr on-chain delay). This is an operational burden during Pyth outages but a security feature in normal operation.

**Revisit threshold:** Only if Pyth has demonstrated unreliability on Solana devnet during the build, OR if a future mainnet phase exposes settlement-window outages that admin override can't reasonably handle (e.g., team is asleep, no admin available within 1hr).

**Re-evaluation owner:** Bram + Aria. If Pyth flakes during devnet integration tests, raise — might be a sign the fallback math needs revisiting.

---

### Custom off-chain caching / persistence database

**Status:** Deferred indefinitely (architecturally rejected)
**Decided in:** `constitution/hard-rules.md` §3.3
**Decided on:** 2026-05-21

**What we considered:** A Postgres / Redis / SQLite caching layer for market state, user positions, and order book snapshots — to reduce frontend RPC load and provide a historical query surface.

**Why deferred:**
- Adds a sync surface between off-chain DB and on-chain truth — failure mode: cache drifts from chain, user sees stale state.
- Undermines the non-custodial / on-chain-is-truth design posture.
- The 3-day window doesn't have room for cache-invalidation correctness.
- WebSocket subscriptions via Helius (Hard YES #9) already give us low-latency real-time updates without the cache.

**Trade-off accepted:** No historical query surface beyond Solana RPC's transaction history. No way to render trade-volume charts or aggregate stats without re-walking the chain.

**Revisit threshold:** Only if the project scales to mainnet AND the chart / aggregate-stats UX gap becomes a user-facing complaint. Then we'd add a read-only indexing layer (not a source-of-truth DB).

**Re-evaluation owner:** Cleo + Tate. If frontend pages become unbearably RPC-heavy on mainnet, raise.

---

### Mobile app

**Status:** Deferred indefinitely (out of scope)
**Decided in:** BRAINLIFT.md §1 "Out of scope"
**Decided on:** 2026-05-21

**What we considered:** A React Native or PWA mobile version of the trade interface.

**Why deferred:**
- 3-day window. Mobile adds wallet-integration complexity (mobile wallet protocols differ from browser extension wallets) and a second build target with its own bugs.
- Demo audience is browser-based.
- Out of scope per PRD (not mentioned as a requirement).

**Trade-off accepted:** No mobile demo. If a partner reviewer asks about mobile, the answer is "browser-first; mobile would be v2 once the lifecycle is locked."

**Revisit threshold:** Only if mainnet stretch ships and mobile becomes the dominant access pattern. Not a near-term concern.

**Re-evaluation owner:** Cleo + Tate.

---

### Self-funding settle bounty (keeper economics)

**Status:** Deferred to v2
**Decided in:** Mentioned in `constitution/decisions.md` DR-002 "Future feature"
**Decided on:** 2026-05-21

**What we considered:** Skimming a tiny fraction (e.g., 0.001 USDC) of each settle into a separate fee account, paid to whoever calls `settle_market` first. This creates a direct economic incentive for keepers to crank settlement — distributed cron via market forces.

**Why deferred:**
- The MVP doesn't need it. Bram's automation service is the happy-path caller; if it dies, any user with a position is already motivated to crank to claim their winnings. The bounty would be a refinement, not a foundation.
- Implementing the bounty requires fee-account architecture + ensuring fees don't leak into the $1 invariant payout (`hard-rules.md` §4.6 says fees go to a separate account — this would be the first test of that design).
- Adds attack surface (griefing via spam-settle when fees are barely above tx cost).

**Trade-off accepted:** Settlement liveness in v1 depends on either (a) automation or (b) a user with a position cranking. If neither happens (very long-tail markets with no holders), settlement just waits until someone notices.

**Revisit threshold:** v2, after mainnet exposure shows real settlement-tail data. If there are markets that go ≥1hr past settlement window without any user cranking, the bounty design becomes worth shipping.

**Re-evaluation owner:** Aria + Tate.

---

### Multi-tenant admin dashboard / multiple admin roles

**Status:** Deferred indefinitely
**Decided in:** BRAINLIFT.md §1 "Out of scope"
**Decided on:** 2026-05-21

**What we considered:** A web UI for the admin authority — view all markets, pause/unpause via UI, trigger admin_settle via UI, manage strike additions.

**Why deferred:**
- Non-custodial product means every user IS a wallet. There's no admin role beyond the program's pause/unpause/admin_settle, which an operator can trigger via CLI scripts.
- Admin dashboard is operational tooling — not part of the user-facing product the PRD is asking us to demo.
- 3-day window.

**Trade-off accepted:** Admin actions require CLI familiarity. Tate operates the demo from a terminal, not a UI. Acceptable for a demo audience.

**Revisit threshold:** Mainnet stretch only. If real users exist, admin tooling becomes a real ops need; until then it's CLI-only.

**Re-evaluation owner:** Cory (Tate).

---

> Aim for clarity over completeness. 7 well-documented deferrals beat 20 thin ones. If something genuinely doesn't need deferral context (e.g., "we're not building an iOS native app"), it can live in `specs/bell-markets-spec.md` §6 (Non-goals) as a one-liner instead.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
>
> **Update protocol:** edit via MR whenever a deferral is made. Each deferral entry should reference the DR-NNN in `constitution/decisions.md` that locked the decision (if one exists). When a revisit threshold trips, EITHER ship the deferred feature OR add a new entry explaining the re-deferral (don't silently keep the old entry alive past its trigger).
