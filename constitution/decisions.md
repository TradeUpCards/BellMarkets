# BellMarkets — Decisions

> Locked architectural decisions. Each entry names the trade-off it
> accepts. Decisions are not deleted — superseded ones stay with status
> updated and the superseding DR cited.

## How to use this file

- **Adding a decision:** append a new `DR-NNN` entry (next sequential
  number). Don't renumber existing entries — citations break.
- **Superseding a decision:** add a new entry, then update the old
  entry's status to `Superseded by DR-XYZ`. Keep the old entry visible.
- **Citing:** "per `constitution/decisions.md` DR-007"

## Decision Record format

Each entry uses this shape:

```
### DR-NNN — [Short title (verb phrase preferred)]

**Date:** YYYY-MM-DD
**Status:** Active | Superseded by DR-XYZ | Deprecated (no replacement)
**Made by:** [Name(s) / lead / team]

**Context:** What was happening when this decision was made? What were
the forces (technical, time, political, partner) in play?

**Decision:** What we're doing. State the choice.

**Trade-off:** What this choice costs. Every real decision has one.
"We pay X in exchange for Y."

**Consequences:** What downstream changes follow from this. What gets
easier; what gets harder.

**Alternatives considered:** What we rejected and why (1-line each).
```

---

## Decision Records

### DR-001 — Integrate Phoenix CLOB; do not build a custom matcher

**Date:** 2026-05-21
**Status:** Active
**Made by:** Cory (Tate) at Day-0 brainlift

**Context:** PRD allows either an existing on-chain CLOB or a hand-built minimal order book. Three-day build window. Team has zero Solana production experience prior to this project. Building a price-time-priority matching engine inside Anchor is a credible interview narrative but consumes a meaningful fraction of the available time and introduces a class of correctness bugs (off-by-one fills, partial-fill accounting, self-trade prevention) that we have no test coverage for yet.

**Decision:** Use **Phoenix** as the on-chain CLOB. Aria's program creates Phoenix markets per strike during the morning create-markets job; Cleo's frontend binds to Phoenix's existing SDK for order placement + book display.

**Trade-off:** We pay a weaker "we built our own matching engine" narrative in exchange for ~1.5 days of build budget, audited matching logic we don't have to test, and a permissionless-crank execution philosophy that aligns with DR-002.

**Consequences:**
- Aria's program does not contain a matcher — only mint-pair / settle / redeem / oracle integration / pause. Smaller surface area, easier to audit ourselves.
- Phoenix market creation must happen before any minting can be useful — morning create-markets job has a sequencing requirement.
- We accept Phoenix's fee schedule (whatever it is on devnet — needs confirmation by Aria during scaffolding).
- If Phoenix has an outage or is deprecated, the trading layer goes away. We have no fallback CLOB.

**Alternatives considered:**
- **Build minimal CLOB inside the Anchor program:** rejected — time budget. Revisitable post-MVP if we ship core lifecycle early.
- **OpenBook v2:** considered but Phoenix is cited specifically in the PRD and has better SDK ergonomics for our timeline.

---

### DR-002 — Permissionless `settle_market`; automation is convenience, not authority

**Date:** 2026-05-21
**Status:** Active
**Made by:** Cory (Tate) at Day-0 brainlift; pushback drove evolution from initial "off-chain owns lifecycle" framing

**Context:** Daily settlement of 35+ markets at 4:05pm ET. Two design options surfaced: (a) Bram's automation service is the sole caller of `settle_market` with signing authority, on-chain enforces only the time gate + Pyth checks; (b) `settle_market` is permissionless — anyone can call it once `block_time >= settlement_window && pyth_fresh && pyth_confident`. Initial framing was (a) on velocity grounds. User raised security and cost/scaling concerns; analysis showed (b) is sharper on multiple axes.

**Decision:** **`settle_market` is permissionless.** The on-chain program enforces all timing rules + Pyth staleness + Pyth confidence + the time-delayed admin override. Bram's automation service is a convenience caller — first to crank wins, automation is the happy-path nudger but holds no special authority over settlement.

The on-chain shape:
- `settle_market(market, pyth_price_account)` — callable by anyone; checks `now >= settlement_time` and `pyth.is_fresh(threshold)` and `pyth.confidence <= threshold`; writes outcome immutably.
- `admin_settle(market, manual_price)` — admin-only; gated by `now >= settlement_time + admin_override_delay` (e.g., 1 hour); used only when Pyth fails persistently.
- `create_strike_market` and `add_strike` remain admin-only (creation needs authority; settlement does not).

**Trade-off:** We pay ~half a day of extra on-chain timing-logic work + tolerance for benign race-condition wasted fees (one tx wins, others fail cleanly), in exchange for: cheaper mainnet ops (~5–10× — no 24/7-monitored hot wallet for liveness), better scaling (settlement load distributes to user demand as market count grows), demo robustness (the cron can crash and the system still works because any user can crank), and alignment with the Phoenix permissionless-crank philosophy (DR-001).

**Consequences:**
- Aria's `settle_market` must be safe under concurrent calls from arbitrary signers — no implicit "caller is admin" assumptions in the instruction.
- Bram's automation service no longer needs a privileged signer for settlement — just gas to call. Morning create-markets still needs admin authority (creation is privileged).
- Demo plan must include the **"cron failure" path**: intentionally kill the automation mid-settle, then trigger settle from a test user wallet. This is the load-bearing evidence that the choice was real, not theoretical.
- Future "settle bounty" (skimmed from settlement fee or admin-funded keeper budget) becomes a natural incentive feature — defer to post-MVP.
- A small class of bug exists where two callers race; on Solana this is benign (one tx wins, losers pay gas and fail). Acceptable.

**Alternatives considered:**
- **Off-chain-owned with admin-only settle:** rejected — creates a single point of failure for liveness, requires monitored hot wallet on mainnet, and the cron going down is a P0 incident rather than a degraded path.
- **No admin override at all:** rejected — Pyth can fail; we need a safety valve, and the time-delay design ensures it can't be abused for adversarial settlement.

---

### DR-003 — Use Pyth Network for stock-price oracle

**Date:** 2026-05-21
**Status:** Active
**Made by:** Cory (Tate) at Day-0 brainlift

**Context:** PRD requires an oracle with staleness + confidence checks, providing both previous-day close (for morning strike calc) and current-day close (for ~4:05pm settlement). Pyth and Switchboard are the two production-grade options on Solana. Pyth has direct US equities feeds (MAG7 included) with a native confidence-interval model; Switchboard is permissionless-feed-first and equity coverage is thinner.

**Decision:** **Pyth Network** for both pre-market reads (off-chain HTTP API) and on-chain settlement reads. **Implementation note:** the on-chain read is implemented via a vendored 30-line price-account parser at `programs/bell-markets/src/oracle.rs` — we **do NOT** import `pyth-sdk-solana`. A same-project veteran (LESSONS.md Lesson 1) documented a Borsh-version cascade that breaks when `pyth-sdk-solana` is in the dependency tree alongside Anchor 0.31. Vendoring is acceptable because Pyth's account binary layout is stable + documented (magic-number check catches any future layout bump). We extract: price, confidence, exponent, publish slot, and status — then validate `status == Trading`, `current_slot - publish_slot < staleness_threshold`, and `confidence / |price| < confidence_threshold_bps`.

**Trade-off:** We pay coupling to Pyth's feed availability and pricing model in exchange for: native equity coverage, native staleness + confidence semantics that map 1:1 to PRD requirements, mature Anchor SDK integration, and lower integration risk on the 3-day timeline.

**Consequences:**
- `settle_market` takes a Pyth price account as input; program validates feed ID matches the market's stock and that the price is recent + tight.
- Morning strike calc reads previous-day close via Pyth HTTP API (off-chain); Bram owns this integration.
- If Pyth has an outage at settlement: admin override path (DR-002) is the recovery, not "swap to Switchboard."
- We do not maintain a fallback oracle. If Pyth deprecates an equity feed, we lose that contract pair until we redeploy with a new feed ID.

**Alternatives considered:**
- **Switchboard:** rejected — thinner equity coverage; would require us to either set up a permissionless feed (extra ops surface) or accept partial coverage.
- **Roll our own admin-pushed price:** rejected — defeats the whole point of being non-custodial / oracle-driven. Reserved as the emergency fallback (admin override path) only.

---

### DR-004 — Anchor CLI 0.31.1 paired with `@coral-xyz/anchor` JS 0.30.1 (deliberate version mismatch)

**Date:** 2026-05-22 (Day-2 morning, surfaced by Aria + Bram Day-1 handoffs)
**Status:** Active
**Made by:** Cory (Tate) per `LESSONS.md` Lesson 1

**Context:** Aria's `Anchor.toml` pins **anchor-cli 0.31.1** (required for Solana 3.x sBPF v3 compatibility per LESSONS.md Lesson 2). Bram + Cleo + Drew pin **`@coral-xyz/anchor` 0.30.1** in their JS workspaces. These versions cannot be unified without giving up either Solana 3.x VM compat (downgrade CLI to 0.30) or ecosystem stability (bump JS to 0.31, which is recently-cut and has not propagated through wallet-adapter / TanStack peer-deps). Aria flagged the mismatch as a potential IDL-deserialization risk for complex enum types.

**Decision:** Keep the mismatch. **Anchor CLI 0.31.1 (Aria) + `@coral-xyz/anchor` JS 0.30.1 (Bram / Cleo / Drew).** This is the exact combination `LESSONS.md` (Ken's same-project Meridian build) shipped to devnet with successfully.

**Trade-off:** We pay the risk that complex enum types in the IDL emitted by Anchor 0.31 don't decode cleanly in the 0.30 client (one-line manual JSON patch if it happens; verified on first `anchor build`) in exchange for: Solana 3.x sBPF v3 compatibility (avoids LESSONS.md Lesson 2's "code that ran on 2.x is rejected by 3.x" trap), and ecosystem stability (every wallet-adapter / TanStack / shadcn / Anchor JS dep in our tree is tested against `@coral-xyz/anchor` 0.30.x; bumping to 0.31 client invites unrelated peer-dep breakage).

**Consequences:**
- BellMarkets' `Outcome` enum is two simple variants (`YesWins`, `NoWins`) — far simpler than the cases where IDL mismatch bites (deeply nested generics, custom serializer-tagged unions). Low probability of needing the manual patch.
- **Day-2 verification step (Aria):** after first `anchor build` produces `target/idl/bell_markets.json`, manually deserialize a `MarketConfig` + a `StrikeMarket` + an `Outcome` value via the JS client (`@coral-xyz/anchor@0.30.1`). If any field decodes incorrectly, manually patch the IDL JSON to match the 0.30 client's expected shape (typically a one-line field-rename). Document the patch in `apps/web/src/idl/bell_markets.json` with a comment block explaining the manual edit.
- **AVM auto-switching mitigates the host-toolchain side.** AVM reads `[toolchain] anchor_version` from `Anchor.toml` in each project's cwd, so the host's `anchor` command auto-uses 0.31.1 for BellMarkets and 0.32.1 for w3Swap. No global pin conflict.
- If the IDL mismatch turns out to be unworkable (worst case), the fallback is to bump JS client to 0.31 across all 3 JS workspaces. This is a one-PR change but invites peer-dep churn — only triggered if the manual patch path fails for some unexpected complex type.

**Alternatives considered:**
- **Bump JS client to `@coral-xyz/anchor@0.31`:** rejected — 0.31 client is recently-cut; ecosystem (wallet-adapter, TanStack Query) hasn't pinned against it yet; introduces unrelated peer-dep risk to a 3-day build.
- **Downgrade CLI to `anchor-cli@0.30.1`:** rejected — LESSONS.md Lesson 2 documents that Solana 3.x's sBPF v3 VM rejects code older Anchor versions produced. We'd ship a binary that compiles locally but won't run on current devnet.
- **Both at 0.32 (matching w3Swap):** rejected — 0.32 has its own IDL format changes; LESSONS.md's tested combination is the 0.31/0.30 split, not 0.32 unified.

---

### DR-005 — User-funded strike PDA creation (Meteora DLMM pattern)

**Date:** 2026-05-22 (Fri evening — post-Day-4 + post-design iteration)
**Status:** Active — implementation queued across Aria / Bram / Cleo / Drew
**Made by:** Cory (Tate-routed)

**Context:** The original architecture had Bram's morning cron eagerly create all 49 strike PDAs per day (7 tickers × 7 strikes — ATM + ±3/6/9%) using the platform-admin keypair. Working capital cost: ~$44/day. Locked rent at scale (stranded user balances): ~$5,500/year — see `.project/bell-markets/coordination/cory_questions_1_answers.md` §1 for the full cost analysis. After discussion, this is misaligned with the protocol's non-custodial thesis (DR-002 permissionless settle, POV-2 permissionless authority) — the platform shouldn't subsidize speculation when a per-user cost-shift pattern exists.

**Decision:** **Platform funds ZERO strike PDAs.** First user to want to trade a strike pays ~$0.90 rent to create the StrikeMarket PDA + YES/NO mints + USDC vault. Pattern modeled on Meteora DLMM's bin-creation mechanism. The Anchor program retains all authority over created PDAs (mint authority, vault authority, settle authority); the user is only the **rent payer**, not a privileged role.

A new permissionless instruction `user_create_strike_market(strike_price, expiry_unix)` is added. On-chain enforcement against malicious strikes:
1. Strike must be within per-ticker `max_user_strike_deviation_bps` of current Pyth spot
2. Strike must align to per-ticker `strike_tick_size` grid (no 100-micro-strike fragmentation)
3. Expiry must be a recognized trading-day close
4. Pyth oracle must pass staleness + confidence checks at create time

Per-ticker config in a new `TickerConfig` PDA (one per Pyth feed) — admin-governable independently per ticker. Initial values per max historical earnings move:

| Ticker | max_user_strike_deviation_bps | strike_tick_size (USD) |
|---|---|---|
| NVDA | 3000 (30%) | $5 |
| META | 3000 (30%) | $5 |
| TSLA | 3000 (30%) | $5 |
| AMZN | 2000 (20%) | $2 |
| AAPL | 1500 (15%) | $1 |
| MSFT | 1500 (15%) | $1 |
| GOOGL | 1500 (15%) | $1 |

Bram's morning cron is **reduced** to maintaining the per-ticker `TickerConfig` PDA (deviation + tick size) and managing any earnings-eve cap expansions. No more eager PDA creation.

**Trade-off:** We pay the cost that the first trader per strike sees a $0.90 friction added to their trade in exchange for: zero platform working capital exposure ($44/day → $0), zero recurring locked rent (~$5,500/year → $0), maximally non-custodial story for interview defense ("platform funds zero infrastructure"), and self-balancing strike inventory (strikes nobody wants never exist; strikes with demand spawn organically).

**Consequences:**
- **Aria's program:** adds 11th instruction `user_create_strike_market` + `TickerConfig` account + per-ticker check logic. Estimated ~3-4 hr work. Existing `create_strike_market` retained for admin-controlled scenarios but not used by Bram's cron.
- **Bram's automation:** morning cron refactor — instead of 7-49 `create_strike_market` calls per day, it does ONE call per ticker per day to update `TickerConfig` (which strikes are allowed today, including any earnings-eve expansions). Earnings calendar logic — initially hardcoded MAG7 dates, later from Polygon.io / Yahoo Finance.
- **Cleo's frontend:** UI now shows "Be the first — ~0.00455 SOL to open this market" CTA when a strike PDA doesn't exist. The first-trade flow bundles `[user_create_strike_market, mint_pair, place_order]` into one atomic transaction (single wallet signature, single broadcast). Lazy state handling becomes a unified code path. **ATA hygiene addition:** every mint_pair tx prepends `createAssociatedTokenAccountIdempotentInstruction` for the user's USDC ATA + YES ATA + NO ATA. Idempotent = no-op if ATAs exist; creates them at user expense (~0.00203 SOL each ≈ $0.40 ATA-only) if they don't. This guarantees ATAs persist for the life of the position, eliminating later admin-borne ATA creation cost during force_redeem (DR-005 §"closed-rent recovery" + cost analysis in `.project/bell-markets/coordination/cory_questions_1_answers.md`).
- **Drew's quality suite:** add tests for `user_create_strike_market` (success + deviation-cap rejection + tick-alignment rejection), plus update `simulate-trading-day.mjs` to exercise the lazy-create path.
- **First-trader UX:** $0.90 added to their first trade on any strike. For $100+ trades this is 0.9%. For small trades the strike likely shouldn't exist anyway. Self-balancing.
- **Closed-rent recovery (when `force_redeem` + `close_settled_market` eventually fire in v2):** refunded rent flows to the `MarketConfig.treasury` (fee_collector) — consistent with Meteora's pattern. User "got" the venue they paid for; platform captures the recovered rent as compensation for ongoing protocol maintenance.

**Alternatives considered:**
- **Eager creation (status quo before this DR):** rejected. Platform funds ~$44/day + ~$5,500/year stranded; misaligned with non-custodial thesis. The hybrid "eager ATM + lazy wings" middle ground was also rejected as unnecessarily complex (per-strike eager/lazy logic in Bram's cron + Cleo's UI handling two states).
- **Per-ticker admin-pre-defined whitelist (no spot-based cap):** rejected. Requires admin to maintain a curated list per ticker per day. The on-chain deviation cap is self-tuning (allows wider strikes when Pyth spot moves; tightens when stable). Less admin maintenance.
- **Cranker bounty on closed-rent (Option C):** deferred. Platform-captures (Option B) is simpler for v2; bounty pattern can be added later if dust-cleanup becomes a real problem.

---

### DR-006 — Strike-grid evolution schedule (post-close anchor + AH/PM wild-swing checks)

**Date:** 2026-05-22 (Fri evening — composes with DR-005)
**Status:** Active — implementation queued for Bram
**Made by:** Cory (Tate-routed)

**Context:** With DR-005 locking user-funded creation, the question becomes: WHEN does Bram's cron update the per-ticker `TickerConfig` (allowed-strikes grid + deviation cap)? The previous cadence (single 8 AM ET morning run anchored on prev-close) has two known problems:
1. Anchoring on prev-close misses overnight news (earnings, geopolitical, Fed) that shifts the spot 4-30% before market open
2. Single morning run gives only ~6.5 hours of trading per market

**Decision:** Bram's cron operates a **24-hour rolling strike-grid evolution** across three phases per trading cycle:

**Phase 1 — Post-close anchor (4:05 PM ET):**
After Bram's existing 4:05 PM settle cron finishes (`settle_market` calls for today's expired markets), the same cron writes tomorrow's per-ticker `TickerConfig`:
- `cap_center` = today's official close price (from Pyth Hermes)
- `allowed_strikes` = ATM ± 3/6/9% of cap_center, rounded to per-ticker `strike_tick_size`
- `max_user_strike_deviation_bps` = per-ticker default (see DR-005 table)

Tomorrow's markets are now openable by users (per DR-005 — they pay rent to actually create the PDA).

**Phase 2 — AH wild-swing checks (4:30 PM - 8:00 PM ET, every 30 min):**
Cron reads live Pyth Hermes spot for each ticker. If `|spot - cap_center| / cap_center > ticker_threshold`:
- Update `cap_center` to current spot
- Expand `allowed_strikes` to include strikes around new spot (without removing existing — users may already hold positions)
- Per-ticker thresholds: NVDA/META/TSLA = 8%, AMZN = 6%, AAPL/MSFT/GOOGL = 4%

**Phase 3 — Pre-market wild-swing checks (4:00 AM - 9:00 AM ET next day, every 30 min):**
Same logic as Phase 2. Catches Asia/Europe overnight news + early-morning announcements.

**9:00 AM ET cutoff:** No more updates between 9 AM and 4 PM ET (regular trading hours). The strike grid is fixed during the trading day.

**Trade-off:** We pay the cost that on busy news days (earnings, Fed, geopolitical surprises), tomorrow's `TickerConfig` may be updated 5-10 times before market open in exchange for: trading window extends from ~6.5 hr to ~24 hr (4:30 PM today → 4:00 PM tomorrow); strikes stay properly centered through overnight news; users can spawn wider wings as the volatility profile evolves; platform never pre-commits rent to strikes that may not be relevant.

**Consequences:**
- **Bram's cron schedule:** ~19 cron fires per trading day instead of 1.
  - 1× 4:05 PM ET (settle + anchor next day)
  - 8× AH window every 30 min (4:30 → 8:00 PM ET)
  - 10× PM window every 30 min (4:00 → 9:00 AM ET next day)
- **Trigger.dev usage:** ~19 × 5 trading days × 4 weeks = 380 runs/month. Well within free tier (1,000 runs/month).
- **Pyth Hermes API usage:** ~19 fires × 7 tickers = 133 reads/day. Free tier covers easily.
- **On-chain writes:** Each cron fire may write `TickerConfig` updates if drift triggers; on quiet days, zero writes; on news days, up to 1-2 writes per ticker. Bram's existing platform-admin keypair signs all updates.
- **`TickerConfig` schema:** new PDA per ticker per day (or a single ticker-keyed map in MarketConfig — Aria's design call). Fields: `cap_center`, `allowed_strikes` (small set), `max_dev_bps`, `tick_size`, `threshold_bps`, `last_updated_slot`, `updated_by_phase` (anchor/AH/PM).
- **Existing 8 AM ET morning cron is REPLACED by Phase 3.** No more "prev close" anchor.
- **Settlement cron (4:05 PM) extends to include "anchor next day" step.** Still runs once daily.
- **Earnings calendar (deferred):** future v2.5 — let Bram's cron pre-expand `allowed_strikes` 24h before known MAG7 earnings dates without waiting for a wild-swing trigger. For MVP, the threshold-based detection catches earnings reactions automatically (NVDA AH at +5% → 8% threshold doesn't trigger yet; at +9% → triggers).

**Alternatives considered:**
- **Single 8 AM ET morning cron (current):** rejected. Misses overnight news; only 6.5 hr trading window.
- **Single 4:05 PM ET post-close cron (no checks):** rejected. Strikes set at close don't catch AH news that happens between 4:05 PM and pre-market open.
- **Continuous cron (every 5 min through AH/PM):** rejected. Excessive Trigger.dev usage (~50K runs/month — exceeds paid tiers); marginal benefit over 30-min cadence.
- **Off-chain earnings-calendar pre-expansion only (no threshold checks):** rejected. Captures only KNOWN events; misses surprise geopolitical / Fed / unscheduled news. Threshold checks are reactive and cover the unknown-unknowns.

---

### DR-007 — Trading calendar (weekends + US full-holidays; half-days settle at 1 PM ET)

**Date:** 2026-05-22 (Fri evening — composes with DR-005 + DR-006)
**Status:** Active — implementation queued for Bram (off-chain) + light Aria validation (on-chain)
**Made by:** Cory (Tate-routed)

**Context:** Underlying stocks don't trade on weekends or US equity full-holidays (~9-10 full closures per year). A market created at Friday's close that "expires Saturday" would have no Pyth close-price to settle against — Saturday's Pyth feed reflects no real trading. Settlement would either fail (oracle stale) or use the stale Friday close (incorrect — gives users an arbitrage window).

User's correct intuition: "The strikes we open should not resolve until the next trading day."

**Half-days are NOT skipped.** Per-year ~3 half-day sessions (day after Thanksgiving, Christmas Eve when appropriate, July 3 in certain years) have **early close at 1:00 PM ET**. Real trading happens, real close prices are produced, Pyth has data. We settle normally — just at 1:00 PM ET instead of 4:00 PM ET.

**Decision:** Each US equity trading day has an associated **close time**:
- Full trading days (weekdays, not a full holiday): close 4:00 PM ET
- Half-days (per-year list): close 1:00 PM ET
- Weekends + full holidays: NOT trading days; cron no-ops

All strike expiries anchor to the next US equity trading day's **close time** (4 PM ET on regular days, 1 PM ET on half-days). Implementation owns:

**Off-chain (Bram):**
Hardcoded US 2026 trading calendar in `services/automation/src/calendar.ts`:
- 9 full holidays: New Year's Day, MLK Day, Presidents Day, Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas (closes shift if holiday falls on weekend per NYSE rules)
- Half-days (1:00 PM ET close): day after Thanksgiving, Christmas Eve (when appropriate), July 3 (in years where July 4 is a weekday but markets close early the day before)

Three helpers:
- `isTradingDay(date): boolean` — weekday AND not in full-holidays set (half-days return TRUE)
- `getCloseTime(date): Date` — returns date at 4:00 PM ET, or 1:00 PM ET if date is a half-day
- `nextTradingDay(from: Date): Date` — skips weekends + full holidays only; half-days are kept

Every cron entry-point gates with `if (!isTradingDay(today)) return;` — prevents Trigger.dev runs on Saturday/Sunday/full-holidays from doing anything. Half-days run normally.

Settle cron is split into two trigger fires:
- "5 18 * * 1-5" (1:05 PM ET) → checks `if (isHalfDay(today)) settle();` else no-op
- "5 21 * * 1-5" (4:05 PM ET) → checks `if (!isHalfDay(today)) settle();` else no-op

Phase 1 of DR-006 uses `nextTradingDay(today)` + `getCloseTime(nextTradingDay)` for `TickerConfig.expiry_unix` — anchors to the correct close time for whatever the next trading day is.

**On-chain (Aria — minimal):**
- `create_strike_market` + `user_create_strike_market` validate `expiry_unix` is at exactly **1:00 PM ET OR 4:00 PM ET** (16:00 or 13:00 UTC adjusted for EST/EDT; on devnet assume EDT) AND is at most 7 calendar days in the future (catches typos but doesn't enforce full-holiday logic — that's Bram's responsibility off-chain)
- No on-chain holiday calendar — calendars change yearly; on-chain config maintenance is heavier than worth

**Cross-day timing examples:**

*Friday Memorial Day weekend (Memorial Day is full-holiday):*

| Time | Action |
|---|---|
| Friday 4:05 PM ET | Settle Thursday's markets. Anchor **Tuesday's** TickerConfig (skipping Mon Memorial Day) — `expiry_unix` = Tuesday 4 PM ET |
| Friday 4:30 PM - 8:00 PM ET | AH wild-swing checks for Tuesday's anchor (standard AH session active) |
| Saturday + Sunday + Monday | No cron firing (or no-op via `isTradingDay()` guard) |
| Tuesday 4:00 AM - 9:00 AM ET | PM wild-swing checks for Tuesday's anchor |
| Tuesday 9:30 AM ET | Market opens; Tuesday markets live for trading until 4 PM ET |
| Tuesday 4:05 PM ET | Settle Tuesday's markets; anchor Wednesday's TickerConfig |

*Day-before half-day (e.g., Christmas Eve as half-day):*

| Time | Action |
|---|---|
| Dec 23 (full day) 4:05 PM ET | Settle Dec 23's markets. Anchor **Dec 24 (half-day)** TickerConfig — `expiry_unix` = Dec 24 **1:00 PM ET** (not 4 PM ET) |
| Dec 23 4:30 PM - 8:00 PM ET | AH wild-swing checks normal |
| Dec 24 4:00 AM - 9:00 AM ET | PM wild-swing checks normal |
| Dec 24 9:30 AM - 1:00 PM ET | Half-day trading; ~3.5 hr regular session |
| Dec 24 1:05 PM ET | **Settle Dec 24's markets** (early settle cron fires); anchor Dec 26 (or next trading day) TickerConfig |
| Dec 25 | Full holiday — no cron |
| Dec 26 cycle resumes | Normal schedule for Dec 26 4 PM ET close |

**Trade-off:** We pay the maintenance cost of yearly calendar updates (Bram's hardcoded sets need annual refresh) + a slightly more complex cron schedule (two settle-cron entries, only one fires per day) in exchange for: correct settlement timing on half-days (settle against real 1 PM close, not skip the day entirely); compliance with how US equity markets actually work; users get the additional trading day on half-days instead of losing it.

**Consequences:**
- **Bram's automation needs an annual calendar update.** For MVP: hardcode 2026 full-holiday + half-day calendars (one-time, ~30 min). For v2: use `nyse-holidays` npm package or pull from Polygon.io free tier (~1 hr setup).
- **The Phase 3 "PM check" window (4-9 AM) operates on the NEXT trading day's morning, not "tomorrow" calendar morning.** For a Friday → Tuesday market, PM checks fire 4-9 AM Tuesday, not Saturday/Sunday/Monday.
- **Users see expiry time in their wallet display.** Cleo's frontend reads `TickerConfig.expiry_unix` and displays human-readable date+time ("Dec 24, 1:00 PM ET" on half-day; "Tuesday, 4:00 PM ET" on regular). Half-day awareness is automatic.
- **Two settle-cron triggers, only one fires per day:** 1:05 PM ET cron checks `isHalfDay(today)`; 4:05 PM ET cron checks `!isHalfDay(today)`. Other days both no-op via the `isTradingDay()` guard. Trigger.dev usage barely increases (~22 extra fires/year for the half-day cron, vs ~2900 for the existing daily one).
- **Edge case: late-Friday earnings announcement** (e.g., 5 PM ET) → AH check at 5:30 PM catches it → updates Tuesday's TickerConfig deviation cap → users can spawn appropriate strikes for the new spot. Works automatically.
- **Edge case: weekend geopolitical event** (e.g., Sunday news) → no cron fires until Tuesday 4 AM PM check → by Tuesday 9 AM, Pyth pre-market spot reflects the news → cap_center updates → users spawn appropriate strikes before market open.

**Alternatives considered:**
- **No holiday handling (let markets create with `today + 1` expiry blindly):** rejected. Saturday/Sunday/full-holiday "expiries" have no real close to settle against; would either fail settlement or use stale Friday close (arbitrage exploit).
- **Skip half-days too (treat as non-trading):** rejected. Half-days are real trading days with real closes. Users would lose ~3.5 hours of trading opportunity AND we'd lose one settlement cycle per half-day. No upside to skipping them.
- **On-chain holiday calendar in MarketConfig:** rejected. ~96 bytes of storage; admin maintenance (signed config updates yearly); on-chain logic complexity. Off-chain calendar is simpler and accurate.
- **External calendar API at create-time (Polygon.io / Yahoo):** deferred to v2. Hardcoded list is fine for MVP and the year ahead.

---

### DR-008 — Fee model: mint-side 2% with creator rebate + 30-day mint-volume tier discount

**Date:** 2026-05-22 (Fri evening — composes with DR-005)
**Status:** Active — implementation queued for Aria + Drew + Cleo
**Made by:** Cory (Tate-routed)

**Context:** With DR-005 locking user-funded strike creation, the protocol needs a revenue model. Three candidates were evaluated:
- **Model A — redeem-only** (Polymarket-style 2% on winning redemptions): user-friendly but systematically misses revenue from Phoenix-only traders who mint and exit via Phoenix without ever calling redeem. Also requires consistent fee on `force_redeem` (and arguably `redeem_pair`), creating accounting branches.
- **Model B — mint-only** (2% on `mint_pair`): captures every protocol interaction (winners + losers + Phoenix-only churners). Single accounting point. No branching for force_redeem or redeem_pair. Slightly worse "no fees on losing" branding.
- **Model C — symmetric hybrid** (small fee on both mint and redeem): more moving parts; rejected as over-engineered.

Per-market revenue at $10K mint volume / 95% redemption rate: A ~$190, B ~$200, C ~$200-250 depending on activity. Comparable headline numbers; the difference is which user behaviors get captured.

**Decision:** **Mint-only fee model.** 2% (200 bps) charged on `mint_pair` to the user, paid in USDC, transferred to `MarketConfig.treasury` (fee_collector). No fee on `redeem`, `redeem_pair`, `redeem_invalid`, or `force_redeem` — fee already captured at mint time.

**Three layered discounts:**
1. **Creator rebate (per DR-005 alignment):** First-trader-of-strike (the user who paid SOL rent to create the StrikeMarket PDA via `user_create_strike_market`) pays 0% fee on their first mint into that strike. Tracked via `StrikeMarket.creator: Pubkey` + `StrikeMarket.creator_rebate_claimed: bool`. Refunds their ~$0.40-equivalent strike-creation cost out of trading revenue. Strong DR-005 narrative loop ("pioneer recoups their venue cost").
2. **30-day mint-volume tier discount:** Per-user `UserConfig` PDA tracks `mint_volume_30d` with linear decay. Three tiers:
   - $0-$1,000: 200 bps (2%)
   - $1,000-$10,000: 150 bps (1.5%)
   - $10,000+: 100 bps (1%)
   Updated in every `mint_pair` call. ~$0.16 user-paid rent per UserConfig PDA (one-time, first mint).
3. **Phoenix venue fee (Model D, IN INVESTIGATION):** Bram investigates whether Phoenix v1 exposes a per-market `fee_receiver` configuration that flows taker fees to our `fee_collector` PDA. If feasible, layer 5-10 bps on Phoenix trades to capture Phoenix-only users (those who mint + churn + walk away without redeeming). Discovery first; ~30-45 min Bram research. If validated, additional ~1-2 hr to wire fee_receiver into `create_strike_market` Phoenix CPI.

**Fee config defaults:**
- `MarketConfig.mint_fee_bps`: 0 (default) — fee mechanism present but disabled. Admin flips to 200 (2%) via signed config update when ready.
- This ships as INFRASTRUCTURE so demo can run with or without fees active. Strong flexibility for interview narrative ("we shipped the mechanism; turning it on is a flag").

**Trade-off:** We pay slightly worse "no fees on losing" branding (vs Model A) in exchange for: single fee touchpoint (cleaner accounting); captures Phoenix-only users (the gap Model A leaves); predictable revenue per mint; no force_redeem fee branching; deterministic treasury accumulation; UI simplicity ("Cost to open: $1.02 = $1 pair + $0.02 protocol fee").

**Consequences:**
- **Aria's program:** modify `mint_pair` to add tier-based fee calc + creator-rebate check + USDC transfer to treasury. Add `mint_fee_bps` to MarketConfig. Add `UserConfig` PDA (init_if_needed in mint_pair). Add `creator` + `creator_rebate_claimed` fields to StrikeMarket (already specced in DR-005). Estimated 2-2.5 hr.
- **Drew's tests:** add fee math + tier transition + creator rebate + decay logic tests. ~30 min.
- **Cleo's frontend:** show user's volume tier + projected fee in mint UI ("Cost: $1.02 USDC = $1 pair + $0.02 fee (tier 2, 2%)"). Show creator-rebate ("you opened this market: -100% fee"). ~20-30 min.
- **Bram's investigation:** validate Model D feasibility on Phoenix v1 ~30-45 min discovery; if green, additional ~1-2 hr Aria + Bram to wire fee_receiver into Phoenix market creation.
- **Fee accumulation:** USDC flows to `fee_collector` ATA. Initially passive; v2 withdrawal instruction by admin if needed.
- **`mint_pair` math** (clean $1 invariant): user pays `amount + fee` total USDC; `amount` goes to vault (maintains $1-per-pair invariant); `fee` goes to treasury. User receives `amount` YES + `amount` NO. The vault's USDC balance always equals `pairs_outstanding × $1`.
- **Mint-volume gaming:** users can't easily game tier via wash-trading (Phoenix is outside our program; minting takes real capital). Possible attack: mint + redeem_pair + mint + redeem_pair to inflate mint_volume_30d. Cost: each cycle pays the fee at mint and recovers $1 minus the fee, so the user pays $0.02 to add $1 of "volume" — strongly bounded by their fee paid. Not worth gaming for a 50 bps tier discount.

**Alternatives considered:**
- **Model A (redeem-only):** rejected. Misses Phoenix-only revenue; force_redeem fee branching adds complexity; redeem_pair fee decision needs separate adjudication.
- **Model C (symmetric hybrid mint + redeem):** rejected. More moving parts; UX explanation harder; revenue comparable to A or B alone.
- **No tier discount (flat 2%):** rejected by user. Tier discount is standard CEX retention mechanic and aligns with rewarding commitment.
- **Total-traded volume (mint + Phoenix activity)** for tier definition: rejected. Requires off-chain Phoenix-event indexer (centralized trust assumption + ~6-8 hr extra work). Mint-volume captures what matters (capital committed); ~3 hr trustless on-chain implementation.
- **Token-holder discount layer:** deferred (no token yet).
- **Maker-taker rebate within Phoenix:** deferred. Couples with Model D investigation; if Phoenix venue fees work, exploring rebate structure is v2 polish.

---

### DR-009 — CLOB strategy: integrate Phoenix v1 for MVP; revisit at scale

**Date:** 2026-05-22 (Fri evening — extends DR-001)
**Status:** Active — MVP commitment; future revisit triggered by scale + Model D outcome
**Made by:** Cory (Tate-routed)

**Context:** DR-001 chose Phoenix v1 integration over building our own CLOB primarily on time-budget grounds (1.5-day build savings). DR-008 surfaced a fee-capture concern: Phoenix trades bypass our `mint_pair`/`redeem` fee touchpoints entirely. The question: does the missed Phoenix-fee revenue justify building (or forking) our own CLOB?

**Decision:** Stay with Phoenix v1 for MVP. Defer custom-CLOB consideration to v2+ scale milestones. Trigger to revisit: ($1M+ daily Phoenix volume) AND (Model D — per-market `fee_receiver` config — proves infeasible on Phoenix v1).

**Revenue math (50-bps Phoenix venue fee, hypothetical):**

| Daily volume | Annual fee captured | Cost-effective vs build? |
|---|---|---|
| $500K | ~$30K | NO (build cost dwarfs revenue) |
| $1M | ~$60K | MARGINAL (4-8mo to recoup audit) |
| $5M | ~$305K | YES (full audit recouped in <1yr) |
| $50M | ~$3M | OBVIOUSLY YES (clear strategic priority) |

**Build cost reality check:**
- Initial build: 2-4 months focused engineering. Ellipsis Labs spent ~1.5 years on Phoenix v1 (admittedly broader feature set).
- Audit: $50K-$200K (matching engines are top-risk audit category).
- Liquidity bootstrap: zero day-1 traders + no integrator network (Jupiter routes through Phoenix v1, not us).
- Ongoing maintenance: ~$30-50K/year.

**Three escalation paths (in order of severity, choose based on what fails):**

1. **Phoenix v1 + Model D venue fees** (current attempt): if Bram validates `fee_receiver` config, we capture Phoenix-trade fees with zero extra build. Keep all of Phoenix's audited matching + integrator network. Most-preferred outcome.

2. **Phoenix v1 + no Model D** (fallback if D fails on v1): keep DR-001 + DR-008 mint-only fee. Lose Phoenix-trade fee layer. Acceptable below $1M daily volume.

3. **Fork Phoenix v1** (revisit at scale): copy Phoenix v1's MIT-licensed source; add per-market `fee_receiver` + `set_fee_receiver` ix. Deploy as "BellPhoenix" replacement. ~1-2 weeks build + ~$10-30K audit (reduced because Phoenix's base is well-understood). Loses Phoenix's integrator network (Jupiter routing) — accept that trade for full fee capture.

4. **Build from scratch** (never seriously considered): full custom matching engine. ~2-4 months + $50-200K audit + zero integrator network. Only ROI-positive at $5M+ daily volume; even then, fork is preferable.

**Phoenix v2 watch:** Ellipsis Labs has hinted at Phoenix v2. If launched with native `fee_receiver` support, we migrate to v2 instead of forking v1. Bram monitors quarterly.

**Trade-off:** We accept ~$60-300K/year in foregone Phoenix-trade fees at moderate scale ($1-5M daily volume) in exchange for: zero matching-engine maintenance burden; Phoenix's integrator network (Jupiter routes); audited matching logic we don't have to defend; faster iteration on our actual differentiation (binary options primitives, lifecycle, demo).

**Consequences:**
- **MVP through ~6 months post-launch:** Phoenix v1 integration as-is. DR-008 mint-fee captures most revenue.
- **First 6-12 months at scale:** if Model D works, we're already capturing Phoenix trades passively. Skip fork entirely.
- **12+ months at $5M+ daily volume:** assemble fork team if Model D didn't materialize. Or migrate to Phoenix v2 if launched.
- **Documentation:** v2 planning doc references this DR. Engineering leads aware that "build our own CLOB" is a scale-triggered conversation, not an MVP question.

**Alternatives considered:**
- **Build custom CLOB for MVP:** rejected. Time + audit cost + zero liquidity + risks dwarf the 3-day demo's needs.
- **Wait indefinitely for Phoenix v2:** rejected as default. Don't bet revenue on Phoenix's roadmap timing; ship Model D investigation + mint fees first.
- **Use a different existing CLOB (Drift Spot, Serum, Manifest, etc.):** rejected. Phoenix is best-fit for our use case (pure FIFO order book; minimal abstractions; tested with our magic-prefix check). Switching for fee-capture reasons creates the same integrator-network gap as forking, without the time savings.
- **Hybrid (Phoenix for tokens that need integrator routing, our own CLOB for tokens we won't list elsewhere):** rejected. Adds complexity without clear win at our scale.

---

### DR-010 — Win-streak rewards: pool structure, fee split, leaderboard, distribution

**Date:** 2026-05-22 evening (composes with DR-008)
**Status:** Active — implementation queued for Aria + Bram + Cleo + Drew
**Made by:** Cory (Tate-routed)

**Context:** DR-008 establishes a mint-side 2% fee flowing to `fee_collector`. User originally proposed in `cory_questions_1.md` that a portion of fee revenue fund win-streak contests with weekly + monthly prizes. This DR formalizes the funding split, pool structure, leaderboard, and distribution mechanics.

**Decision:** Win-streak contests structured as **two-period prize pools (weekly + monthly), funded by fee skim at mint time, leaderboard tracked off-chain via Helius indexer, distribution signed by admin via on-chain ixs.**

**Default funding split (configurable):**
- Platform retains: 50% (`platform_retain_bps = 5000`)
- Weekly pool: 25% (`weekly_pool_bps = 2500`)
- Monthly pool: 25% (`monthly_pool_bps = 2500`)
- Sum must equal 10,000 (enforced on-chain)

In every `mint_pair` call, the fee is split three ways immediately:
```
fee × platform_retain_bps / 10_000  → fee_collector ATA (platform revenue)
fee × weekly_pool_bps / 10_000      → weekly_rewards_pool PDA
fee × monthly_pool_bps / 10_000     → monthly_rewards_pool PDA
```

**Promo mode example (admin signs config update):**
- `mint_fee_bps` = 100 (1% — half off normal)
- `platform_retain_bps` = 0
- `weekly_pool_bps` = 5000 (50%)
- `monthly_pool_bps` = 5000 (50%)
- Result: Black-Friday-style promo — half-fee + 100% to contests. Strong engagement narrative.

**Pool PDAs (on-chain):**
- `WeeklyRewardsPool` — USDC token account, owned by program PDA. Funded by mint fee skim. Drained by `distribute_weekly_rewards` ix.
- `MonthlyRewardsPool` — Same for monthly.
- Each pool ~$0.23 one-time rent (paid by platform at deploy).

**Leaderboard (off-chain, by Helius indexer):**
- Bram's automation listens to `settle_market` events via Helius webhooks
- Per-user streak state stored in Postgres or simple JSON
- Win = user held winning side (any amount > 0) at settle time
- Loss = user held losing side at settle (resets streak to 0)
- Abstained = user held nothing at settle (doesn't reset, doesn't extend)
- Weekly streak = longest consecutive run in past 7 trading days
- Monthly streak = longest consecutive run in past 30 trading days
- Tiebreakers: (1) total markets traded in period, (2) random

**Trust model — two options:**

*Option A (off-chain trust, simplest):* leaderboard ranks are off-chain; underlying event data is public on-chain. Anyone can run their own indexer + verify our ranking informally. Admin signs distributions trusting Bram's indexer output.

*Option B (Merkle commitment, trustless verifiable):* the proper cryptographic upgrade. Per-period flow:
1. Bram's indexer computes full leaderboard at period end (every user with any streak, ranked)
2. Builds Merkle tree (leaves = `hash(user_pubkey, streak_count, position, period_id)`)
3. Admin commits root on-chain: `commit_leaderboard_root(period_id, merkle_root)` — 32 bytes stored
4. Distribute ix accepts Merkle proof: `distribute_weekly_rewards(period_id, recipient, position, amount, merkle_proof)` — verifies proof against committed root; reverts if invalid
5. Anyone can run their own indexer over public settle events, compute their own root, verify it matches the committed root

Under Option B, admin CANNOT manipulate distributions to wrong recipients — proof verification rejects unauthorized addresses. Stores ~24 roots (12 weeks + 12 months) in a `LeaderboardCommitments` PDA. Adds ~3 hr to total implementation (~10-11 hr total for #7 with Merkle).

**Default for MVP:** Option A (off-chain trust). Documented Merkle migration path is additive (adds verification without breaking existing distributions). User-decision pending on whether to ship A or B for MVP demo — see `cory_questions_1_answers.md` discussion.

**Distribution (admin-signed, top-10 per period):**

Default smooth-decay distribution (configurable per-position bps):

| Place | Bps | Pct | Notes |
|---|---|---|---|
| #1 | 2500 | 25% | Champion |
| #2 | 1800 | 18% | |
| #3 | 1200 | 12% | |
| #4 | 1000 | 10% | |
| #5 | 800 | 8% | |
| #6 | 700 | 7% | |
| #7 | 600 | 6% | |
| #8 | 500 | 5% | |
| #9 | 500 | 5% | |
| #10 | 400 | 4% | |
| **Total** | **10000** | **100%** | |

Stored in `MarketConfig.weekly_distribution_bps: [u16; 10]` and `monthly_distribution_bps: [u16; 10]`. Admin can update via signed config change.

**Edge case — fewer than 10 unique users with active streaks:**
- Pay out only positions that have qualifying winners
- Unpaid prize amounts stay in pool and roll over to next period
- Implementation: Bram's distribution cron iterates winners array; only calls `distribute_X_rewards` for positions with winners

**Distribution timing:**
- Weekly: Fridays at 5 PM ET (after market close + settle); Bram's cron triggers
- Monthly: Last Friday of the month, 5 PM ET; Bram's cron triggers
- Holiday adjustments per DR-007 (skip non-trading days; distribute on next trading day)

**Trade-off:** We pay engineering complexity (~7-8 hr cross-lead) + retain ~50% of fee revenue instead of 100% in exchange for: strong user engagement / retention mechanism; differentiation from Polymarket (they don't have win-streak contests); growth-marketing tool (promo mode flexibility); aligns with user's explicit growth-vector ask in cory_questions_1.md.

**Consequences:**
- **Aria's program:** Add 2 new PDAs (WeeklyRewardsPool + MonthlyRewardsPool token accounts). Add 3 new bps fields to MarketConfig with sum-validation. Add 2 distribution arrays (`weekly_distribution_bps` + `monthly_distribution_bps`). Add 2 new admin ixs (`distribute_weekly_rewards` + `distribute_monthly_rewards`). Modify `mint_pair` to split fee three ways. ~2-2.5 hr.
- **Bram's automation:** Helius webhook listener for `settle_market` events. Per-user streak state tracking (Postgres or JSON for MVP). Weekly + monthly distribution crons. Admin-signed distribution flow. Rollover for under-10 case. Tiebreaker logic. ~2.5-3 hr.
- **Cleo's frontend:** Leaderboard page (top-10 weekly + monthly with streak counts). User's own streak badge in portfolio. Toast notifications on milestone streaks ("🔥 5-streak!"). Past rewards display. Pool balance visibility (read PDA via RPC). ~1.5-2 hr post-design-lock.
- **Drew's tests:** Fee split correctness (3 transfers totaling fee). Distribution ix (admin-only; transfers from pool). Sum=10000 validation. Rollover edge case. ~45 min.
- **Total: ~7-8 hr cross-lead.** Significant addition but bounded.

**Alternatives considered:**
- **20/20/60 split (more to platform):** rejected. User explicitly wanted growth mechanism funded aggressively; 50% to platform retain still preserves majority revenue.
- **Top-3 distribution only:** rejected. Top-10 spreads engagement to more users; tiebreaker depth matters for healthy contest dynamics.
- **On-chain leaderboard:** rejected for MVP. Per-user state writes per market = ~$120/year tx cost + complexity. Off-chain handles MVP scale; v2 could add Merkle commitment if trust becomes concern.
- **Daily contests instead of weekly:** deferred. Daily would create more frequent dopamine but tinier pools per period. Could be added v2 as third tier (daily + weekly + monthly).
- **Single combined pool (weekly drains from same as monthly):** rejected. Separate pools cleaner accounting; admin can tune ratios independently; rollover semantics simpler.

---

> Aim for 5–15 active DRs over a project's life. Fewer and you're not
> locking enough; more and the file becomes unscannable (rotate stable
> ones into `specs/architecture.md` if they've become "just how the
> system works" rather than "a choice we made").

> **Citation format:** "per `constitution/decisions.md` DR-007"
