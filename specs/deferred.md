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

### Docker / containerization for build, deploy, or demo

**Status:** Deferred indefinitely (architecturally not needed for this stack)
**Decided in:** Day-0 presearch session
**Decided on:** 2026-05-21

**What we considered:** Adding a `Dockerfile` + `docker-compose.yml` that pins the Solana CLI 3.1.14 / Anchor 0.31.1 / Rust 1.95 / Node 24 / pnpm toolchain inside a container, so any grader could run `docker compose up` to reproduce the full lifecycle on any host machine. This is the pattern the team's prior Solana project (w3Swap) used.

**Why deferred:**
- **No service in BellMarkets' stack actually needs containerization.** The Solana program deploys via `anchor deploy` from a dev machine; the frontend deploys to Vercel which builds from git natively (and fights containerization); the automation runs on Trigger.dev's managed runtime. There is no Python / FastAPI / custom backend service (like w3Swap had) that needs packaging.
- **Toolchain consistency across the 4 leads is already solved** via version pins in `Anchor.toml`, `BRAINLIFT.md` §3, and `package.json` engines/packageManager. Docker would be redundant infrastructure for a job already done.
- **The grader workflow** (per ARCHITECTURE.md §1: async repo review + on-demand live devnet demo + recorded backup video) does NOT require grader-side toolchain installation. The team demos on their own pinned machines; the recorded video is the async artifact. Containerization adds no value here.
- **Time cost is real on a 3-day window:** ~3-6 hours of Aria/Drew time to write + test + verify that `anchor deploy` works from inside a container with the Solana keypair mounted from the host. That time is better spent on the lifecycle, the simulation, and the demo recording.

**Trade-off accepted:** A hostile reviewer who asks "why no Docker?" gets a project-specific defense: "Our stack has no service that benefits from containerization (Solana program deploys directly; Vercel builds natively; Trigger.dev manages its own runtime). Toolchain consistency is solved by version pins. Grader workflow is async + video + on-demand-live, none of which need grader-side reproducibility." If a future component required a custom managed-runtime service or a deterministic build environment for audit, Docker would be the right call.

**Revisit threshold:** Only if (a) BellMarkets adds a custom backend service that doesn't fit a managed runtime like Trigger.dev / Vercel / Solana RPC, OR (b) mainnet stretch goal requires a deterministic, audit-friendly build environment for on-chain program verification (e.g., publishing reproducible build hashes alongside the deployed program). Until either trigger fires, indefinite skip.

**Re-evaluation owner:** Aria + Tate. If a new backend service is introduced, Aria flags whether it needs containerization; Tate decides.

---

### OrderBook + escrow rent recovery (post-settle cleanup)

**Status:** Deferred to v1.1 (post-submission, pre-mainnet — P1 hard precondition for mainnet)
**Decided in:** This file + `docs/architecture/pre-mainnet-readiness.md` §"v2 gap #8"
**Decided on:** 2026-05-25

**What we considered:** Adding two new permissionless instructions — `force_cancel_order(side, seq)` (post-settle sweep) + `close_order_book()` (closes OrderBook + both escrows once empty) — so the operator can reclaim ~95% of per-market SOL rent (0.121 of 0.128 SOL/market) after settlement. The StrikeMarket PDA stays as the historical tombstone holding `outcome`, `settle_price`, `settled_at_unix`, and `pairs_outstanding` for late redemptions.

**Why deferred:**
- ~60-90 min of Aria's critical-path time before the 2026-05-25 7pm ET submission, competing with the Pyth-feed audit + settle/redeem smoke test that are demo-blocking.
- Devnet SOL is free; the stranded-rent cost is $0 today. The cost is documented and known.
- Both instructions are extensions of existing patterns (`cancel_order` for the cancel logic, `close_settled_market` for the rent-flow pattern) — low-risk to ship post-submission with fresh test coverage.
- `close_settled_market.rs:115-116` already documents this as a "future sweep mechanism" — explicit scope decision, not an oversight.

**Trade-off accepted:** ~0.122 SOL/market stranded on devnet (free; doesn't matter). On mainnet at 49 markets/day × 30 days = ~187.7 SOL/month = ~$30K/month stranded — economically unsustainable. **Therefore: ship before mainnet, not before submission.**

**Revisit threshold:** Pre-mainnet (P1 hard precondition). The first mainnet deploy must include `force_cancel_order` + `close_order_book` in the instruction surface. If the mainnet conversation opens before v1.1 ships, treat this as a launch blocker, not a v1.2 polish item.

**Re-evaluation owner:** Aria (program-side implementation) + Bram (cron integration to call the cancel sweep + close in the post-settle phase) + Tate (mainnet-readiness gating).

---

### Mint rent recovery (close YES/NO mints post-redemption)

**Status:** Deferred to v1.2 (post-mainnet polish)
**Decided in:** This file + `docs/architecture/pre-mainnet-readiness.md` §"v2 gap #8"
**Decided on:** 2026-05-25

**What we considered:** Adding `mint::close_authority = strike_market` to the Anchor `init` schema in `create_strike_market`, then a small `close_market_mints()` instruction that calls SPL Token's `CloseAccount` on each mint (PDA-signed) once `supply == 0`. Reclaims the remaining ~0.003 SOL/market of stranded mint rent.

**Why deferred:**
- Requires a program upgrade (schema change to `init`) — every new deploy is a fresh audit cycle. Not worth it for 0.003 SOL/market when the v1.1 OrderBook+escrow close already recovers 95% of per-market rent.
- The existing mints work fine without `close_authority`; setting it doesn't change runtime behavior, only enables cleanup.

**Trade-off accepted:** 4.8% of per-market rent (~0.006 SOL — StrikeMarket tombstone + two mints) stays permanently locked. At mainnet scale, that's ~$1.50/market or ~$2,100/month at 1,470 markets/month. Material but not load-bearing.

**Revisit threshold:** Bundle into whatever deploy_index ships next after v1.1, OR wait until a mainnet program upgrade is happening for another reason and ride along. Don't deploy specifically for this.

**Re-evaluation owner:** Aria + Tate.

---

> Aim for clarity over completeness. 8 well-documented deferrals beat 20 thin ones. If something genuinely doesn't need deferral context (e.g., "we're not building an iOS native app"), it can live in `specs/bell-markets-spec.md` §6 (Non-goals) as a one-liner instead.

---

> **Template:** SDD v1 (from `claude-code-project-template` v0.3.0+)
> **Created:** 2026-05-21
>
> **Update protocol:** edit via MR whenever a deferral is made. Each deferral entry should reference the DR-NNN in `constitution/decisions.md` that locked the decision (if one exists). When a revisit threshold trips, EITHER ship the deferred feature OR add a new entry explaining the re-deferral (don't silently keep the old entry alive past its trigger).
