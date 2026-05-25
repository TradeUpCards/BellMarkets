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
- **Cleo's frontend:** UI now shows "Be the first — ~0.00455 SOL to open this market" CTA when a strike PDA doesn't exist. The first-trade flow bundles `[user_create_strike_market, mint_pair, place_order]` into one atomic transaction (single wallet signature, single broadcast). Lazy state handling becomes a unified code path. **ATA hygiene addition:** every mint_pair tx prepends `createAssociatedTokenAccountIdempotentInstruction` for the user's USDC ATA + YES ATA + NO ATA. Idempotent = no-op if ATAs exist; creates them at user expense (~0.00203 SOL each ≈ $0.40 ATA-only) if they don't. This guarantees ATAs persist for the life of the position, eliminating later admin-borne ATA creation cost during force_redeem (DR-005 §"closed-rent recovery" + cost analysis in `.project/bell-markets/coordination/cory_questions_1_answers.md`). **StrikeMarket.creator field:** set to the user pubkey that signs `user_create_strike_market`. Immutable. Used by DR-008 fee logic to identify creator (0% fee on all mints into their strike until settle).
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
1. **Creator rebate (per DR-005 alignment, UPGRADED + CONFIGURABLE):** First-trader-of-strike (the user who paid SOL rent to create the StrikeMarket PDA via `user_create_strike_market`) pays a discounted fee rate on **ALL mints into that strike until it settles** (typically a 24-hour window).
   - **Rate controlled by `MarketConfig.creator_rebate_bps: u16`** — applied as fee multiplier. Default: **10000 (100% rebate = creator pays 0% fee)**. Admin can dial to any value via signed config update (e.g., 5000 = 50% rebate = creator pays half normal fees; 0 = no rebate).
   - Effective fee for creator = `tier_fee_bps × (10000 - creator_rebate_bps) / 10000`
   - Default behavior (10000): creator trades free in their strike. Strong incentive for active market-making.
   - Tunable: at scale, admin can shift to 5000 or lower if economics demand it (no redeploy needed; signed config update).
   - Tracked via `StrikeMarket.creator: Pubkey` (set at create, immutable) + checking `outcome == Outcome::Unsettled` at mint time.
   - **Critical safeguard against tier gaming:** mints that receive ANY creator rebate (even partial) do NOT update `user_config.mint_volume_30d` — otherwise a creator could mint $1500 free/discounted in 7 strikes to accelerate tier progression for ~$77 net gaming profit. Code: `if !creator_rebate_fires { user_config.mint_volume_30d += amount }`. Closes the attack vector regardless of rebate magnitude.
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
**Status:** Active — MVP commitment; **Model D verified feasible 2026-05-24 (Aria + Bram primary-source verification); execution promoted to v1.5 P0**
**Made by:** Cory (Tate-routed)

**Context:** DR-001 chose Phoenix v1 integration over building our own CLOB primarily on time-budget grounds (1.5-day build savings). DR-008 surfaced a fee-capture concern: Phoenix trades bypass our `mint_pair`/`redeem` fee touchpoints entirely. The question: does the missed Phoenix-fee revenue justify building (or forking) our own CLOB?

**Decision:** Stay with Phoenix v1 for MVP. Defer custom-CLOB consideration to v2+ scale milestones. Trigger to revisit: ($1M+ daily Phoenix volume) AND (Model D — per-market `fee_receiver` config — proves infeasible on Phoenix v1).

---

### DR-009 amendment 2026-05-24 — Model D feasibility VERIFIED; v1.5 P0 promotion

**Two independent verifications confirm Model D is mechanically feasible on Phoenix v1:**
- Bram (off-chain investigation): all 5 discovery questions in `specs/clob-strategy.md` §"Discovery questions for Bram" answered YES against the Phoenix v1 codebase
- Aria (on-chain verification): same 5 questions re-verified against Phoenix-v1 primary source via `gh api repos/Ellipsis-Labs/phoenix-v1/...`; on-chain integration design walk documented in `specs/clob-strategy.md`

**Locked integration plan (v1.5 P0 — first thing post-submission):**

| Component | Change | Estimate |
|---|---|---|
| `create_strike_market` ix | Wrap `phoenix::InitializeMarket` CPI; set `fee_recipient` to our `fee_collector_usdc` ATA | ~3-4 hr Aria |
| Account list | Add `phoenix_program`, `phoenix_market`, `fee_recipient_ata`, `base_lot_size`, `quote_lot_size` to `create_strike_market` accounts struct | included above |
| State changes | New `phoenix_market` field on `StrikeMarket` PDA (was implicitly derived; now explicit Pubkey to capture the CPI-initialized market) | included above |
| Property tests | Fee recipient = our ATA invariant; verify fees accumulate to our address on every Phoenix fill | ~1 hr Aria |
| Audit cycle | Sonnet audit on the new CPI path (matching engine CPI is high-risk category) | ~1 hr |
| Deploy + verification | deploy_index=7 (or whatever next index lands); verify on-chain that new markets initialize with our fee_recipient | ~30 min |
| Indexer adapter | Bram updates Helius webhook parser if Phoenix events surface fee accrual differently | ~30 min Bram |
| Frontend (no change) | Cleo's `create_strike_market` builder gets new account list from refreshed IDL — minimal change | ~15 min Cleo |

**Total v1.5 P0 effort:** ~6-8 hr cross-lead. Single deploy cycle. Routine integration — no novel cryptography or matching-engine work.

**Why this is v1.5 P0 (NOT v1 submission):**
1. Submission risk — touches `create_strike_market`, the program's core market-creation flow, ~24 hr before submission deadline. Audit cycle + edge-case discovery don't fit the timeline.
2. Revenue today = $0 — devnet/demo has zero Phoenix volume; the integration captures nothing measurable until mainnet + traction.
3. Demo defense unaffected — submission narrative includes "DR-009 amendment 2026-05-24 — Model D verified feasible; locked integration plan; ~6-8 hr work gated on $500K+ daily Phoenix volume, not engineering uncertainty."

**Why NOT defer indefinitely:**
1. Closes the **mint-only fee gap** (DR-008): Phoenix-only secondary trades currently pay zero protocol fees. Model D captures them passively at every fill.
2. **Defensible at interview** — the integration is *engineered*, not aspirational. We're not betting on Phoenix's roadmap or external dependencies; everything we need exists today.
3. **No new audit categories** — wrapping an existing audited CPI is dramatically lower-risk than forking Phoenix or building our own matching engine.

**Revisit threshold (unchanged):** if Model D execution somehow fails post-submission, fork-Phoenix conversation resumes at $1M+ daily volume per the existing escalation tree.

---

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

**Leaderboard (off-chain, by Helius indexer + Neon Postgres):**
- Bram's automation listens to `settle_market` events via Helius webhooks
- Per-user streak state stored in **Neon Postgres** (serverless Postgres, free tier 256MB sufficient for ~18-24 months of MVP; paid $19/mo for 1GB beyond)
- Schema: user_streaks, settle_events, user_market_holds, leaderboard_snapshots, distributions
- Total per-year storage at MAG7 scale: ~130MB
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

**LOCKED for MVP: Option B (Merkle commitment) + Arweave pinning for permanent verification.** Aligns with non-custodial / verifiable thesis (DR-002, DR-005, DR-009). Distributions cryptographically verifiable from day 1; admin cannot manipulate recipient selection. Bram's indexer uploads full leaderboard data to Arweave (decentralized permanent storage, ~$0.01/period) at each commit; on-chain `commit_leaderboard_root` includes both the 32-byte Merkle root AND the Arweave content ID. Anyone can fetch full leaderboard from Arweave forever + verify against on-chain root.

**Verification model (now permanent):**
1. **Proof verification:** any user with their Merkle proof can verify on-chain forever. Cheap cryptographic math.
2. **Full re-verification:** fetch full leaderboard from Arweave (forever, free, public), reconstruct Merkle root, compare to on-chain commitment. Anyone, anytime.

Trust narrative for interview: "Win-streak leaderboards are cryptographically verifiable. Merkle root committed on-chain per period; full leaderboard data permanently archived to Arweave. Anyone can fetch the data + reconstruct the proof + verify our distributions for any past period, free, forever."

Adds ~3.5-4 hr to baseline implementation (~10.5-12 hr total for #7).

**Implementation breakdown for Option B:**
- Aria: WeeklyRewardsPool + MonthlyRewardsPool PDAs + LeaderboardCommitments PDA + commit_leaderboard_root ix + Merkle proof verification helper + distribute_weekly/monthly_rewards ixs (accept proof + verify) + fee-split logic in mint_pair + bps configuration fields + sum-to-10000 validation. **~3-4 hr.**
- Bram: Helius webhook for settle_market events + per-user streak state tracker (Postgres or JSON for MVP) + Merkle tree builder (use `merkletreejs` library or equivalent) + per-period root computation + proof generation per top-10 winner + weekly + monthly distribution crons + tiebreaker logic + rollover for under-10 case + admin-signed distribution flow. **~3-4 hr.**
- Cleo: Leaderboard page (top-10 weekly + monthly) + streak badges + toast notifications + past rewards display + pool balance visibility + "verifiable leaderboard" link to indexer instructions. **~1.5-2 hr post-design-lock.**
- Drew: Tests for valid + invalid + tampered proofs + fee split correctness + rollover edge case + admin-only distribute ixs + sum-validation. **~1 hr.**
- **Total: ~9-11 hr.**

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

### DR-011 — Earnings-calendar pre-expansion (proactive deviation-cap widening)

**Date:** 2026-05-22 evening (composes with DR-006)
**Status:** Active — implementation queued for Bram (off-chain) + minor Cleo UI
**Made by:** Cory (Tate-routed)

**Context:** DR-006 covers reactive wild-swing detection: Bram's cron expands `TickerConfig.max_user_strike_deviation_bps` if Pyth spot moves > ticker threshold during AH/PM windows. This catches earnings reactions ~30 min after they happen. Earnings windows are the highest-volume trading periods of any quarter (20-40% of daily volume in the first 30 min post-announcement). A 30-min lag between gap and tradeable strikes is meaningful user experience cost AND foregone fee revenue.

**Decision:** Bram's automation maintains a hardcoded MAG7 earnings calendar. The day BEFORE each known earnings event, the cron pre-expands that ticker's deviation cap from default (e.g., NVDA 30%) to a wider value (e.g., 50%). Day after earnings, restore default.

Implementation:
- `services/automation/src/earnings-calendar.ts` — hardcoded JSON of MAG7 earnings dates for 2026:
  - Apple, Microsoft, Google, Amazon, Meta: quarterly (Feb/May/Aug/Nov typical)
  - NVIDIA: ~Feb 21, May 22, Aug 28, Nov 20
  - Tesla: ~Jan 24, Apr 24, Jul 24, Oct 23
  - Total ~28 events/year (7 tickers × 4 quarters)
- New cron entry: 4:30 PM ET each trading day → check tomorrow's calendar → if earnings event scheduled, expand deviation cap via signed `update_ticker_config` ix
- Cleanup cron: 4:30 PM ET day after earnings → restore default deviation cap
- Cleo UI surfaces "📊 NVDA earnings tomorrow — wider strikes available" indicator (~15 min addition)

Pre-expansion magnitudes (per-ticker, configurable):
- High-vol tickers (NVDA, META, TSLA): default 30% → 50% on earnings-eve
- Mid-vol tickers (AMZN): default 20% → 30%
- Low-vol tickers (AAPL, MSFT, GOOGL): default 15% → 25%

**Trade-off:** We pay annual calendar maintenance (~15 min/year manual update) and ~2 hr Bram implementation in exchange for: zero lag between earnings announcement and tradeable strikes; captures peak earnings volume / fee revenue; strong demo narrative (anticipatory strike expansion); user experience win on highest-impact trading moments.

**Consequences:**
- **Purely additive over DR-006.** If hardcoded calendar is wrong or stale, DR-006's reactive wild-swing detection still catches missed earnings within 30 min. Never breaks anything.
- **Bram's automation:** new earnings-calendar.ts module + cron entries for pre-expansion + restoration. ~1-2 hr.
- **Aria's program:** no changes — uses existing `update_ticker_config` admin-signed ix.
- **Cleo's frontend:** optional UI badge showing earnings-eve status. ~15 min.
- **Drew's tests:** pre-expansion + restoration logic + edge cases (calendar empty, earnings during half-day, etc.). ~15 min.
- **Demo narrative win:** Drew's `simulate-trading-day.mjs` can include "earnings day" scenario showing immediate strike availability vs reactive lag.
- **V2 path:** swap hardcoded calendar for API integration (Polygon.io / Yahoo Finance / Alpha Vantage). Auto-updates each quarter without manual intervention. ~1 hr upgrade.
- **Calendar maintenance:** Bram reviews quarterly. If a date is missed, DR-006 catches it; we update the calendar next quarter.

**Alternatives considered:**
- **Skip pre-expansion (DR-006 reactive only):** rejected. 30-min lag during peak volume is meaningful UX + revenue cost.
- **API-driven calendar from day 1:** deferred to v2. Hardcoded list is fine for MVP and saves API integration complexity (~1 hr extra) + handles rate limiting / API downtime concerns. Trade slight maintenance burden for reliability.
- **On-chain earnings calendar:** rejected. Calendars change yearly; on-chain config maintenance is heavier than off-chain. Bram's hardcoded list with quarterly review is appropriate.
- **Pre-expansion by larger margins (e.g., 30% → 100%):** rejected. Excessive cap widening would allow users to spawn nonsensical strikes (e.g., NVDA at $50 when spot is $1300). Tier-based 2× expansion is sufficient for historical earnings reactions.
- **Per-event expansion magnitudes (different for each earnings call):** deferred. Default 2× expansion captures most cases; if specific events need more (e.g., post-IPO earnings, mega-cap mergers), v2 can add per-event overrides.

---

### DR-013 — Web2 onboarding via embedded wallets (v2.x scope)

**Date:** 2026-05-23
**Status:** Active — v2.x scope, not v1
**Made by:** Cory (Tate-routed)

**Context:** v1 ships pure non-custodial — users bring a Solana wallet (Phantom, Backpack, Solflare) via `@solana/wallet-adapter-react`. This is interview-defensible and matches Polymarket's design. But it excludes web2 users: anyone who has never used crypto cannot participate. Kalshi (the regulated competitor to Polymarket) does not require a crypto wallet, and that's a meaningful TAM gap — Kalshi's user count is multiples of Polymarket's. The product opportunity in v2.x: open the funnel to users who pay with a card and have never touched crypto, without compromising the non-custodial trust boundary.

**Decision:** Add embedded-wallet onboarding as a v2.x feature using **Privy** or **Turnkey** (decision deferred to v2 design). Key properties locked:

1. **User owns the key, not BellMarkets.** Both Privy and Turnkey use TEE (Trusted Execution Environment) or MPC (Multi-Party Computation) key custody — the user's email/social login derives a key the *user* controls; BellMarkets never has the key in custody. **Legal accounting consequence: embedded-wallet balances are not on BellMarkets' books**, same as a self-custodial wallet. No money-transmitter licensing risk; no custodial KYC obligations beyond what v1 already requires.
2. **Fiat ramp via Helio (primary) or MoonPay (alternative).** Card → ramp → USDC into embedded wallet → mint flow. Helio includes integrated card on-ramp + Solana-native USDC subscription support (validated by Squads, Backpack). MoonPay is the alternative if Helio's ramp coverage is insufficient for target geographies.
3. **Withdrawals are user-initiated SPL transfers** (or back through ramp for cashout). User signs, on-chain, no admin touch.
4. **Email becomes mandatory for embedded-wallet users** (Privy/Turnkey require it for account recovery). Captured at onboarding, used for transactional + opt-in newsletter (see DR-014).
5. **Wallet abstraction layer** — frontend wraps `@solana/wallet-adapter-react` so embedded wallets (Privy/Turnkey) and self-custodial wallets (Phantom/Backpack) present a uniform signing interface to the rest of the app. No conditional code paths in mint/redeem/Phoenix builders.

**Trade-off:** We pay onboarding-flow complexity (email verification, account recovery UX, ramp integration, additional KYC review at the ramp layer) **in exchange for** ~10× addressable market versus pure web3 onboarding (Kalshi/Robinhood demographic) and a smoother first-time experience for users who would bounce on the "install Phantom" step.

**Consequences:**
- **Frontend:** Cleo's wallet-adapter integration in v1 is compatible — Privy ships `@privy-io/react-auth` that wraps wallet-adapter cleanly. No v1 rework needed; v2.x adds the embedded-wallet provider on top.
- **Compliance scope:** the *ramp* layer (Helio/MoonPay) handles KYC, not us. We never touch fiat directly. Our compliance burden grows only by "we are a venue an embedded-wallet user transacts through," not by "we are a custodian."
- **AI v2 plan:** Bell Pro subscription via Helio works for both wallet types — embedded-wallet users pay in USDC through the same on-chain flow as self-custodial users. The MCP server (DR-014 spec) treats embedded wallets and self-custodial wallets identically.
- **Geo-fencing inherits from v1.** US blocked at v1; embedded-wallet users get blocked at the same border check. No looser policy for embedded users — Privy/Turnkey users can still be in non-US geographies same as Phantom users.
- **Anti-Sybil:** embedded wallets are easier to spin up than Phantom (email = one wallet vs phone-verified email). Tier-1 mint-volume gaming (DR-008) needs review at v2 launch: consider tying the 30-day-volume tier to KYC'd identity at the ramp layer rather than just (config, user) pubkey.
- **DR-014 (profiles + social linking) is the user-facing companion** — embedded-wallet users get a profile with their email/social capture; self-custodial users opt-in to the same profile system.

**Alternatives considered:**
- **Custodial wallet (we hold the key):** rejected. Triggers money-transmitter licensing (state-by-state in the US), AML/KYC obligations, fiduciary-duty scrutiny. Polymarket's strategic mistake — they later had to unwind US custody to settle with regulators. We don't repeat it.
- **No web2 onboarding at all (Polymarket model):** rejected for v2.x. The TAM gap is meaningful and Kalshi proves it; pure web3 is fine for v1 demo but caps long-term growth.
- **Web3Auth (formerly Torus) / Magic.link:** considered as embedded-wallet alternatives to Privy/Turnkey. Magic.link's Solana support is mature but its TEE model is older. Privy and Turnkey are the 2026 frontier. Final pick deferred to v2 implementation.
- **Build our own embedded wallet:** rejected. Custom key-management infra is a hard-to-justify build vs ~5K-10K/yr in Privy/Turnkey costs at our scale. We are not a wallet company.

---

### DR-014 — User profiles + social linking + notification channels (v1.5/v2.0 scope)

**Date:** 2026-05-23
**Status:** Active — v1.5/v2.0 scope
**Made by:** Cory (Tate-routed)

**Context:** A pure wallet-pubkey-only identity (v1 default) is a known retention ceiling. Polymarket-style "you are a hex address" prevents the marketing loop (newsletter, push notifications, share-card virality) that drives every successful retail finance product. Cory has prior production experience building this stack at **fffanalytics_t3** (`/c/Dev/fffanalytics_t3`) — NextAuth v4 OAuth + Neon Postgres + Discord.js v14 + nodemailer + web-push. The patterns are reusable, which collapses the design risk to schema choices.

**Decision:** Add an opt-in user-profile layer that captures:

1. **Identity:** wallet pubkey (canonical) + email (optional for self-custodial users, **mandatory for embedded-wallet users per DR-013**)
2. **Display:** avatar + handle. Avatar priority order: **explicit upload → most-recent linked social-account avatar → SNS metadata (`.sol` name) → generated identicon (Boring Avatars or equivalent)**. ENS (`.eth`) resolution is nice-to-have, not load-bearing.
3. **Social links via OAuth (no post-verify required):** X (Twitter), Discord, Google. Each provider may surface email — capture opportunistically. OAuth-only flow; no manual "paste your handle" + verification post.
4. **Notification preferences (granular opt-in per channel):**
   - **Email** — transactional (settlements, won-trades) + opt-in newsletter
   - **Discord DM** — via shared-server bot pattern (user must be in BellMarkets Discord; bot DMs them). Production-tested at fanalytics.
   - **Browser push** — web-push API, where supported
   - **Telegram** — bot pattern, added in v2.0
   - **X** — deferred until ≥5K MAU justifies API tier ($200/mo Basic for read access, $5K/mo Pro for posting). X *OAuth* (identity, email capture) is free at any scale; X *posting/reading* is the gated capability.
5. **Stack:** NextAuth v4 (OAuth) + Neon Postgres (user/session/notification-pref tables) + Discord.js v14 + nodemailer + web-push. Pattern reuse from fanalytics; schema-level details deferred to implementation pickup.

**Trade-off:** We pay the engineering scope of a user-profile system, OAuth integration, notification infrastructure, and email/DM template authoring — plus the perception cost of "this is no longer pure wallet-only" — **in exchange for** real marketing surface (newsletter, share-cards, push retention) and the foundation DR-013 needs (email mandatory for embedded-wallet users).

**Consequences:**
- **Database:** Neon Postgres becomes a hard dependency (already adopted in DR-010 for leaderboard state; this confirms the choice). User table, OAuth account-link table, notification-preference table, push-subscription table all live in Neon.
- **Profile creation is gated behind reward-claim** (high-intent moment). Don't surface email-capture during pre-trade browsing — convert at the moment of meaningful upside.
- **Share-card generator** — PNG generation of "I went 7-0 on MAG7 today" / win-streak milestones / leaderboard rank, with BellMarkets watermark. Generated server-side (Node canvas or `@vercel/og`), stored ephemerally, shareable to X/Discord/Telegram. Drives viral loop without requiring X API access.
- **Reference implementation:** `fffanalytics_t3` patterns lift cleanly. Specifically:
  - `src/app/api/auth/[...nextauth]/options.ts` — provider config (Twitter, Discord)
  - `src/actions/pushNotificationActions.ts` + `src/utils/pushNotifications.ts` — web-push subscription model
  - `src/components/PushNotificationTester.tsx` + `ReminderSubscriptionModal.tsx` — UI patterns
- **Token impact:** if `$BELL` ever launches (v2.5+, deferred per AI v2 plan §6), profiles become the natural attachment point for token-balance display + governance.
- **Privacy:** Hard NOs around PII unchanged. Email + social handles are PII; stored in Neon, never logged to handoffs / commit messages / public chat.

**Alternatives considered:**
- **Wallet-pubkey-only forever (Polymarket model):** rejected. Capped retention; no email = no newsletter = no re-engagement loop.
- **Auth0 / Clerk:** considered as NextAuth alternatives. Auth0/Clerk are heavier (Auth0 is $240/mo above hobby; Clerk is similar). NextAuth is free + already battle-tested at fanalytics. No reason to migrate to a paid auth platform.
- **Build the profile system on-chain (profile PDA per user):** rejected. Profiles are write-heavy (notification prefs change, avatar updates, social links toggled), on-chain writes are expensive vs. Neon row updates. On-chain profile = bad UX. Wallet pubkey is the only identity primitive that needs to be on-chain.
- **SIWE (Sign-In With Ethereum-style) only, no OAuth:** rejected. Doesn't capture email. Without email we lose the newsletter + recovery channels.

---

### DR-015 — Multi-metric leaderboard: single Merkle tree per period (extends DR-010)

**Date:** 2026-05-23
**Status:** Active — pre-mainnet, before next on-chain deploy
**Made by:** Cory (Tate-routed)

**Context:** DR-010 locked a Merkle-commitment + Arweave-pinned leaderboard structure with one root committed per `(period_id, period_type)` and distribution to top-10. Aria's P3 deploy implemented this for a single ranking metric (interpreted as absolute profit). Cory raised the product question: leaderboards should track *multiple* metrics simultaneously (profit, win streak, win rate, etc.) because different metrics surface different kinds of skill — absolute profit favors capital deployed, win rate favors accuracy, win streak favors discipline. Two implementation paths surfaced:

- **(a)** Extend `period_type` enum to one variant per metric (`WeeklyProfit / WeeklyStreak / WeeklyWinRate / ...`). Each metric gets its own Merkle commitment + distribution cron. Familiar pattern, simpler verifier, but every new metric requires a program redeploy + audit pass.
- **(b)** Single Merkle commitment per `(period_id, period_type)` with multi-metric leaves: `(user, metric_id, value, ...)`. Verifier branches on `metric_id` for distribution authorization. Atomic, extensible without redeploy.

**Decision:** Lock **(b)** — single Merkle tree per period, multi-metric leaves. Specific structure:

```
leaf_hash = sha256(user_pubkey || metric_id || rank || amount || period_id || period_type)
                  32 bytes    || 1 byte  || 1 byte || 8 bytes (u64) || 4 bytes || 1 byte
```

`metric_id` is a `u8` enum on-chain (256 possible metrics, easily extended). Verifier in `distribute_*_rewards` checks the proof + branches on `metric_id` to select the correct pool sub-balance or claimed_bitmap segment.

**Initial metric set (v1 launch):**

| `metric_id` | Metric | Source | Free / Pro |
|---|---|---|---|
| `0x00` | Absolute profit (USDC) | Settled-trade history in Neon | Free |
| `0x01` | Win streak (current period) | `UserConfig.win_streak` per Aria P3 | Free |
| `0x02` | Win rate % | Settled trades in Neon; min 20 trades to qualify | Free |
| `0x03` | ROI % (profit ÷ capital deployed) | Computed off-chain from mint events | Bell Pro tier (DR-014) |

Adding `0x04 EarningsAccuracy` or `0x05 StreakBreaker` post-launch requires **only** off-chain leaf encoding + Bram's indexer recognizing the new ID. No on-chain redeploy.

**Trade-off:** We pay ~30-50 lines of additional Rust + audit surface (verifier branches on `metric_id`) **in exchange for** (1) atomic period commits — no partial-update windows where some metrics are stale; (2) future metric additions require zero on-chain changes; (3) cross-metric proofs in a single RPC for user-rank UX; (4) simpler indexer fan-out (one cron per period, not N per metric).

**Consequences:**

- **Aria's P3 work stays.** `LeaderboardCommitments` PDA structure unchanged (24-entry ring buffer of period commitments). `commit_leaderboard_root` ix unchanged in signature — only the underlying off-chain Merkle tree includes more leaf types. The on-chain entry already stores `(period_id, period_type, merkle_root, arweave_tx_id)` — fits unchanged.
- **`distribute_weekly_rewards` + `distribute_monthly_rewards` evolve:** verifier reads `metric_id` from the proven leaf and routes the USDC transfer through a per-metric `claimed_bitmap` segment (so claiming Profit doesn't mark Streak as claimed). 32-bit bitmap supports up to 32 entries per metric per period — across 4 metrics that's 128 total claimable positions per period. Plenty for top-10 distributions across each metric.
- **Pool split:** the 50/25/25 fee split (per DR-010) funds the weekly+monthly pools. Each pool's USDC balance subdivides by metric weight. Default v1: 60% profit / 20% streak / 15% win-rate / 5% ROI (Pro). Configurable via `update_fee_config`.
- **Frontend** queries Neon for the leaf set + Arweave for the manifest, then constructs a Merkle proof for the user's claim. Same UX flow as DR-010, just with a `metric_id` parameter on the claim button.
- **Transaction size (~721 bytes at top-50 × 4 metrics)** fits comfortably under the 900-byte practical limit after wallet overhead. See size math below.
- **Defensive recommendation: Address Lookup Tables (ALTs).** Aria sets up a single ALT during deployment containing the standard accounts (`token_program`, `system_program`, `rent`, `weekly_pool`, `monthly_pool`, `usdc_mint`, `fee_collector`, `leaderboard_commitments`). Each `distribute_*` tx references those accounts by 1-byte index instead of 32-byte pubkey — saves ~200 bytes per tx. Not required for v1 launch (we have headroom), but kept on the shelf for when account count grows (adding metric-specific pool sub-balances, audit-log accounts, etc.). ~1 hr Aria implementation when triggered.

**Transaction size math (per DR-015 verifier path):**

| Component | Bytes |
|---|---|
| 1 signature | 64 |
| Message header | 3 |
| Blockhash | 32 |
| Program ID | 32 |
| ~8 account keys | ~256 |
| Ix discriminator + args (recipient, amount, period_id, period_type, metric_id, leaf_idx) | ~48 |
| Merkle proof (depth 8, top-50 × 4 metrics) | 256 |
| Compact-array overheads | ~30 |
| **Total** | **~721 B** ✓ under 900 |

Worst-case (depth 10, top-200 × 4 metrics): proof grows to 320 B, total ~785 B. Still safe.

**Alternatives considered:**

- **(a) — per-metric Merkle tree:** rejected. Atomicity gap (one metric can lag another during cron flakes), every new metric requires program redeploy + audit, fan-out complexity, cross-metric rank lookups require N RPCs. The only win was a slightly simpler verifier — outweighed by future-flexibility cost.
- **Single ranking metric (profit only), defer multi-metric to v2:** rejected. Win streak is already tracked on-chain via `UserConfig.win_streak` and is the strongest behavioral-discipline signal for a $1-payout product. Surfacing only profit misses the retention story Webull Vega / Louis Limited proved (per AI v2 research).
- **Composite scoring (single weighted metric blending profit + streak + win-rate):** rejected. Black-box scoring is unauditable and a regulatory smell — "we ranked you with our secret formula." Multiple transparent metrics each ranked independently is defensible.
- **Off-chain-only leaderboard (no Merkle commitment):** rejected. DR-010 already established verifiable leaderboards as a moat vs Polymarket/Kalshi. Backing off would erase the differentiation.

---

### DR-016 — Token program selection: SPL Token for tradeable assets, Token-2022 for platform NFTs, compressed for mass-minted badges

**Date:** 2026-05-24
**Status:** Active — SPL Token locked for v1 (the tradeable assets); Token-2022 + compressed reserved for v2+ identity surfaces
**Made by:** Cory (Tate-routed)

**Context:** Solana has three programs that mint balance-bearing tokens, each with different shape and integration cost:

| Program | Account model | Fungible? | Phoenix v1 support |
|---|---|---|---|
| SPL Token (`Tokenkeg…`) | Full SPL token account per holder | Yes | Native (Phoenix is built on it) |
| Token-2022 (`TokenzQd…`) | Full SPL token account per holder; supports extensions (transfer fee, confidential, transfer hook, metadata pointer, non-transferable, etc.) | Yes | Unsupported (Phoenix v1 predates T22) |
| Compressed (Bubblegum) | Off-chain Merkle leaf; root on-chain | No — asset/NFT-shaped | Unsupported (Phoenix is account-based) |

We have three distinct token-issuance surfaces: (a) YES/NO position tokens that need to trade on Phoenix, (b) Founder Pass NFT (DR-013) + soulbound achievement badges (DR-014), (c) mass-minted per-period leaderboard/contest badges. Picking one program for all three is wrong — they have different shape requirements.

**Decision:** Use SPL Token (legacy) for all tradeable fungible assets in v1 (YES, NO, USDC). Plan Token-2022 + compressed for v2+ identity/badge surfaces, but defer their implementation.

| Use case | Pick | Why |
|---|---|---|
| YES/NO position mints, USDC | **SPL Token** | Phoenix v1 requires it; vault arithmetic depends on no transfer-fee skew |
| Founder Pass NFT (DR-013) | **Token-2022 w/ metadata extension** (v2+) | Saves the separate Metaplex metadata account; cleaner on-token data |
| Soulbound achievement badges (DR-014) | **Token-2022 non-transferable** (v2+) | Prevents secondary market on identity |
| Per-week win badges, leaderboard rank NFTs | **Compressed (Bubblegum)** (v2+) | ~1000× cheaper for 500K+ mints/year; correct shape (unique-per-user-per-period) |

**Trade-off:** We pay ~$50/year in extra rent (vs. compressed) for the YES/NO + USDC accounts at 10K MAU scale, in exchange for native Phoenix CLOB integration and zero novel attack surface in the v1 audit. We also defer ~$50K/year in compressed-NFT savings (at scale) by not shipping the badge system in v1 — recoverable in v2.

**Consequences:**
- v1 audit surface is minimal — only well-understood SPL Token primitives in fund-moving paths
- Phoenix integration "just works" with our existing account model
- Future v2 badge work is additive — Bubblegum tree + cNFT mint path, no breaking changes to existing accounts
- Token-2022 + compressed familiarity is a v2 audit cost we explicitly accept later

**Alternatives considered:**

- **All-SPL-Token (use SPL for badges too):** rejected. At 500K badges/year, account rent is ~$50K/year. Compressed is the correct shape for the use case (unique, per-period, non-tradeable).
- **All-Token-2022 (use T22 even for YES/NO):** rejected. Phoenix v1 doesn't support T22 markets — would break our CLOB integration entirely. Transfer-fee extension would skew vault math; confidential-transfer extension would hide our settlement invariant from auditors and indexers.
- **All-compressed (cNFTs for everything):** rejected. cNFTs are NFT-shaped, not fungible. Can't represent "Alice holds 10 YES" without 10 separate Merkle leaves; can't trade on Phoenix at all.
- **Custom token program forked from SPL:** rejected. We're a binary-options dApp, not a token-standards lab. Forking the most-audited program on Solana to add a feature we don't need is strictly negative.

---

### DR-017 — Vault security model: PDA self-authority, permissionless settle, admin-as-cranker-not-redirector

**Date:** 2026-05-24
**Status:** Active — load-bearing v1 invariant; auditor-enforced
**Made by:** Cory (Tate-routed)

**Context:** A non-custodial dApp that holds USDC in vaults needs to prove three properties to be defensible: (1) no human keypair can drain a vault, (2) settlement isn't a centralization vector, (3) admin powers are bounded to "cranking" — making things happen on time — not "redirecting" — choosing who gets paid.

**Decision:** Layer four mechanisms to enforce the three properties:

1. **Every fund-moving account has the strike_market PDA as its authority.**
   - `usdc_vault: token::authority = strike_market` (programs/bell-markets/src/instructions/create_strike_market.rs:84-87)
   - `yes_mint: mint::authority = strike_market`, `no_mint: mint::authority = strike_market` (same file lines 62-77)
   - Result: no keypair — not user, not admin — can move USDC out of a vault or mint YES/NO tokens. Only the program itself, via `CpiContext::new_with_signer` with PDA seeds, can authorize a transfer/mint/burn. Every code path that does this is in our audited source.

2. **Anchor account constraints validate every account before the handler runs.**
   - `seeds = [b"vault", strike_market.key().as_ref()]` ties each vault to a specific market — can't substitute another market's vault
   - `has_one = usdc_mint` on config — can't substitute a different stablecoin
   - `constraint = strike_market.config == config.key()` everywhere — can't mix accounts from different deployments
   - `token::mint = …, token::authority = user` on user-owned accounts — can't pass someone else's wallet
   - `constraint = fee_collector_usdc.owner == config.treasury` — can't redirect protocol fees to attacker ATA
   - These run as part of account validation, BEFORE the handler executes. A malicious tx fails at the boundary, not deep inside business logic.

3. **`settle_market` is permissionless** (programs/bell-markets/src/instructions/settle_market.rs:6, kickoff §4.2 auditor-enforced).
   - Anyone can crank a settle from the Pyth feed after expiry. No `admin` constraint on the Accounts struct.
   - Removes the "what if Bell's cranker dies" centralization risk. Users (or third-party bots) can settle their own markets.

4. **Admin can crank but cannot redirect.**
   - `force_redeem` routes USDC to the *user's* ATA, never admin's (programs/bell-markets/src/instructions/force_redeem.rs:6, 86): "admin is the cranker, USER is made whole"
   - `admin_settle` is gated by `now >= strike_market.admin_override_eligible_at` (default expiry + 30 days) — admin can't pre-empt oracle settlement (programs/bell-markets/src/instructions/admin_settle.rs:50)
   - `pause` is a kill-switch only; doesn't permit fund redirection
   - There is no `withdraw_to_admin`, `set_vault_authority`, or `transfer_vault` instruction. The program has no path to send vault USDC anywhere other than: a winning user (redeem / force_redeem), pair-burner (redeem_pair), or invalid-market refund (redeem_invalid).

**User-side specifics (this is the "how do we stop a user from sending wrong amount / wrong vault / wrong wallet" question):**

| Attack the user might try | What blocks it |
|---|---|
| Pass a `usdc_vault` from a different market to drain its funds | `seeds = [b"vault", strike_market.key().as_ref()]` constraint — Anchor recomputes the PDA and rejects if it doesn't match. The vault for market X cannot be paired with a redeem on market Y. |
| Pass another user's `user_winning_token` to burn their tokens | `token::authority = user` constraint — Anchor verifies the account's authority field equals the `user` signer. Mismatch = rejected. |
| Pass another user's `user_usdc` as destination, hoping vault sends them USDC | `token::authority = user` on `user_usdc` — same defense. Even if user wants to *gift* USDC to another wallet, they can't; the destination must be theirs. |
| Burn 1 token, claim 1000 USDC | `token::transfer(…, amount)` and `token::burn(…, amount)` use the same `amount` arg. The SPL Token program enforces that the burn from `user_winning_token` requires `amount` units actually be present (insufficient balance → tx fails). The transfer of `amount` from vault is gated by the burn succeeding first (sequential CPIs in the handler). Amounts are bound together by sharing the same variable. |
| Burn `amount` they don't own, claim USDC from vault | SPL Token's `Burn` instruction validates that `user_winning_token.amount >= amount` and that `authority == user`. The CPI fails inside the SPL Token program if insufficient. Our program propagates the error and aborts the tx — no partial state mutation, no USDC moves. |
| Mint pair without paying USDC | `token::transfer(USDC user→vault, amount)` runs first in `mint_pair` (programs/bell-markets/src/instructions/mint_pair.rs:298), THEN the YES/NO mints. If the user lacks USDC, the transfer fails inside SPL Token, the tx aborts, no YES/NO is minted. |
| Pass `usdc_vault` from market A as the source on a redeem against market B, hoping to mismatch the math | Constraint chain breaks: `strike_market: B` (constraint passes); then `usdc_vault: seeds = [b"vault", strike_market.key().as_ref()]` requires the vault be derived from B's pubkey. Passing A's vault → PDA derivation mismatch → reject. |
| Settle a market on a Pyth feed that isn't the one bound at creation | `strike_market.underlying_pyth_feed` was set at `create_strike_market`. `settle_market` reads from the same field; the supplied Pyth account is validated against it. Wrong feed = reject. |
| Resubmit the same redeem tx repeatedly to drain the vault | Each redeem burns the user's winning tokens. Once their balance is 0, the next burn fails. The vault can never pay out more than total tokens of the winning side, which equals the total USDC originally deposited (1:1 invariant). |
| Mint after settle, hoping to mint cheap losers and avoid the loss | `constraint = strike_market.outcome == Outcome::Unsettled` on mint_pair (programs/bell-markets/src/instructions/mint_pair.rs:161) — mint is locked the instant settle runs. |

**Trade-off:** We pay ~3-5× the lines-of-code overhead of `#[account(…)]` decorators on every Accounts struct in exchange for compile-time-validated, auditor-readable security boundaries. Every constraint is checked before the handler runs; nothing relies on the handler "remembering" to validate.

**Consequences:**
- Every new instruction must declare its constraints explicitly in the Accounts struct — there's no opt-out
- The audit punch list focuses on **(a)** new fund-moving paths (CPIs), **(b)** any handler logic that bypasses the Anchor primitives, **(c)** PDA seed derivation correctness
- "Where can funds go?" has a finite answer: read every `CpiContext::new[_with_signer]` for `Transfer { from: usdc_vault, to: ?, … }`. Today: `user_usdc` (redeem path), `fee_collector_usdc` (mint_pair fee), pool ATAs (mint_pair revenue split). That's it.
- Permissionless settle means we can't restrict who pays the settle-tx gas cost — but the cost (~5K lamports / ~$0.001) is negligible vs. the centralization benefit

**Alternatives considered:**

- **Admin-keypair vault authority (multi-sig or single):** rejected. Even multi-sig is a centralization vector and an audit-flag for a non-custodial dApp. PDA self-authority removes the question entirely.
- **Permissioned settle (admin-only):** rejected per kickoff §4.2 — auditor-enforced no-signer-beyond-the-cranker rule. Admin-only settle means our cranker dying = users locked out of redemption.
- **Trust handler-level checks instead of Anchor constraints:** rejected. Account-level constraints run as part of validation, before any state mutation. Handler-level checks would let partial mutations land on subtle bugs. Anchor's design exists precisely to prevent this category.
- **`withdraw_to_admin` emergency drain path:** rejected. No mechanism exists in v1 for admin to ever take vault funds. Users get made whole via `force_redeem` (which sends to user, not admin). The strict invariant — "vault USDC only flows to a user who provably held a winning/refundable token" — is load-bearing for the non-custodial narrative.

---

### DR-018 — Fee model v1.5: 25 bps mint + 10 bps Phoenix taker (amends DR-008)

**Date:** 2026-05-24
**Status:** Active — v1 submission ships with `mint_fee_bps=0` on devnet (no behavior change for demo); activates at admin flip post-DR-009 Model D deploy
**Made by:** Cory (Tate-routed)

**Context:** DR-008 specced a 2% mint-side fee under the assumption that Phoenix-side fees were unreachable. DR-009 Model D verification (2026-05-24) confirmed Phoenix `fee_recipient` is reachable via a ~6-8 hr CPI integration (locked as v1.5 P0). With both surfaces available, the original 2% mint design is over-rotated and structurally asymmetric:

- **Asymmetric YES/NO entry**: traders buying YES from existing inventory pay 0 fees; traders buying NO via the atomic `mint_pair + sell-YES` flow pay the full 2%
- **MM-hostile**: bootstrappers (e.g., Bob in scenario 1) pay the 2% on every mint they do to seed liquidity — discouraging the exact behavior we need most
- **Arbitrage-incentive**: sophisticated traders learn to never call `mint_pair`, freeloading on MMs who do
- **Outlier vs comparable Solana CLOBs**: Drift = 10 bps taker; dYdX = 10-15 bps; Hyperliquid = 2.5 bps; Polymarket = 0%

**Decision:** Move to a two-surface fee model with industry-standard taker-only Phoenix economics:

| Fee surface | Rate | Charged on |
|---|---|---|
| `mint_fee_bps` | **25 bps** (was 200 under DR-008) | Every `mint_pair` call EXCEPT the strike creator's own mints in their own strike (per DR-008 `creator_rebate_bps` mechanism — default 100% waiver) |
| `phoenix_taker_fee_bps` | **10 bps** (new, requires DR-009 Model D ship) | Every Phoenix fill where the user is the taker (aggressive crossing order). Accrues to our `fee_recipient` ATA at fill time. |
| `phoenix_maker_fee_bps` | **0 bps** (structural; Phoenix v1 doesn't support maker fees natively) | Limit orders that rest and get filled |
| Redeem / redeem_pair / redeem_invalid | 0 bps (unchanged) | — |

**Hardcoded program ceilings (defensive against admin compromise):**
- `mint_fee_bps ≤ 100` (max 1%)
- `phoenix_taker_fee_bps ≤ 50` (max 50 bps)
- Enforced via `require!` in `update_fee_config` and `create_strike_market`

**Fee split (admin-configurable via `update_fee_config`):**
- Mint fee: 70% to pools (50% weekly + 20% monthly) / 30% to platform retain
- Phoenix fee: 70% to pools / 30% to platform retain
- Note: "creator rebate" is a fee WAIVER (creator pays nothing on their own mints in their strike), NOT a kickback. There is no creator-direct payment surface.

**Trade-off:** Projected MVP revenue drops from ~$100K/yr (DR-008's 2% mint design) to ~$25.5K/yr (this design), in exchange for:
- Symmetric YES/NO entry pricing — every trader path now pays proportional to value extracted
- ~85% reduction in trader-facing fees on every Buy-NO / Sell-NO / MM-bootstrap path
- Aligned with Drift's 10 bps taker — easy interview defense ("we match the largest Solana perp DEX")
- Removes the arbitrage incentive to bypass `mint_pair`
- Preserves DR-005 creator's fee-waiver incentive to spawn strikes (creator personally mints at 0% while everyone else pays 25 bps)
- DR-010 pool funding preserved at ~$15-18K/yr (vs ~$60-70K under DR-008; smaller pools but still meaningful — ~$300-350/wk weekly leaderboard prize)

**Consequences:**
- DR-008's 2% mint design is **amended** (not superseded — the mint fee mechanism stays; only the rate changes from 200 → 25 bps)
- DR-018 activation gated on DR-009 Model D shipping (otherwise we have a mint fee but no Phoenix fee, and the asymmetry returns)
- v1 submission ships with `mint_fee_bps=0` on devnet (already current state per Aria's deploy_index=6) — zero migration risk, zero demo impact
- Post-DR-009 Model D + DR-018 activation: a single `update_fee_config` + `phoenix::ChangeFeeRecipient` CPI (admin-signed) flips both rates on simultaneously
- Frontend (Cleo): add Phoenix-fee surface to the fee preview in `trade-view.tsx` — show "25 bps mint + 10 bps Phoenix fill" breakdown alongside the existing tier display

**Alternatives considered:**

- **(a) Keep DR-008's 2% mint, no Phoenix fee:** rejected. Asymmetry, MM friction, arbitrage incentive, outlier vs comps. Already covered above.
- **(b) 0% mint + 25 bps Phoenix only:** rejected. Loses DR-005 creator's fee-waiver incentive (creator's "rebate" becomes meaningless at 0% mint). Also outlier-high vs Drift's 10 bps.
- **(c) 0% mint + 10 bps Phoenix only:** rejected. Same DR-005 issue. Plus pool funding drops to ~$10.5K/yr — sub-$200/wk leaderboard prizes feel anemic.
- **(d) 25 bps mint + 10 bps Phoenix + 5 bps maker fee:** rejected. Maker fee discourages limit-order liquidity provision; Phoenix v1 doesn't support it natively (would need fork — DR-009 Option 4); industry-standard CLOB economics is taker-only.
- **(e) 50 bps mint + 5 bps Phoenix:** rejected. Higher mint fee re-introduces some of DR-008's asymmetry; below-industry Phoenix rate looks underpriced and signals weak revenue confidence.

---

### DR-019 — NO-side trades are market-only (IOC) in v1; Limit Buy NO / Sell NO deferred to v1.5+

**Date:** 2026-05-24
**Status:** Active — v1 design lock; revisit when MVP usage data justifies Limit-NO mechanism choice
**Made by:** Cory (Tate-routed)

**Context:** The atomic Buy-NO and Sell-NO flows bundle `mint_pair` + Phoenix swap or Phoenix swap + `redeem_pair` into a single user-signed transaction (POV-3 atomicity). The current implementation uses Phoenix's `swap` instruction (IOC — immediate-or-cancel) which guarantees all-or-nothing execution. Adding a Limit variant of either flow raises orthogonal but real issues:

| Flow | If we shipped a Limit variant today |
|---|---|
| **Limit Buy NO** | `mint_pair` must fire BEFORE the Phoenix sell-YES leg can post (you can't sell YES you don't own). Mint fee taken upfront. If the Phoenix limit doesn't fill and user cancels → user stranded with unwanted YES+NO pair + sunk mint fee. Violates the "atomic, can't get stranded" promise of POV-3. |
| **Limit Sell NO** | Phoenix limit buy-YES posts safely (no fee). But `redeem_pair` requires the YES to already exist — can't run in the same tx as a limit that hasn't filled. Requires a 2-tx flow: (1) limit post; (2) when filled, user manually fires `redeem_pair`. UX gap; easy to forget step 2, leaving user with stranded YES+NO that needs manual cleanup. |

**Decision:** Lock v1 design as **NO-side trades are market-only (IOC).** The UI MUST disable the Limit toggle on Buy NO and Sell NO paths. The state-eval function in `trade-view.tsx` MUST return "disabled with tooltip" for any Buy/Sell × NO × Limit combination.

**Bonus protocol-level guarantee:** even if the UI is bypassed (e.g., direct CLI tx submission), the IOC + atomic-tx properties on `swap` mean a malformed Limit-NO attempt would fail at the Phoenix leg, which would revert the entire tx including the `mint_pair`. **There is no way to end up with a stranded fee from a malformed NO trade** — the protocol enforces atomicity even when the UI is wrong.

**Trade-off:** v1 NO-side traders can only express market orders (with slippage caps). No "I'll buy NO at exactly $0.40 if it ever gets there" patience. Sophisticated NO traders work around this by:
- Manually minting a pair via standalone `mint_pair` (paying the fee)
- Then placing a Phoenix Limit Sell YES at their target NO price (free)
- Keeping the unwanted NO until they redeem at settle

This works because once they own both tokens, the Phoenix limit YES sell is a clean atomic single-ix (no atomicity bundle needed). It's just less ergonomic than a one-click "Limit Buy NO" button.

**v1.5 reopen options (documented for future decision):**

| Option | Mechanism | Cost |
|---|---|---|
| **Option 2** — Auto-redeem on cancel | Frontend wires Phoenix order cancel to also fire `redeem_pair` for any stranded matched pair. User accepts they eat the mint fee as sunk cost if they bail mid-trade. | ~30-60 min Cleo + an event listener |
| **Option 3** — Custom matcher with atomic complementary-mint (Polymarket CTF pattern) | Fork Phoenix or build a custom matching engine that mints fresh pairs when two opposite-side limit orders meet. Removes the stranding issue entirely. | $40-80K + 1-2 weeks + new audit category (per DR-009 Option 4) |
| **Option 4** — Async-fill claim ix | Add a new `claim_after_fill` ix that the user can fire post-fill to atomically complete the Sell NO sequence. Indexer watches Phoenix fill events + notifies user. | ~2-3 hr Aria + indexer logic |

**Consequences:**
- Cleo MUST update `trade-view.tsx` to disable Limit toggle on Buy/Sell NO (single state-eval function update; ~10 lines)
- Drew adds an adversarial test confirming Limit-NO paths are unreachable (tx builder doesn't construct them; UI doesn't allow them; protocol would reject them anyway)
- v1.5 product decision: which Option to ship. Defer decision until MVP usage data reveals if Limit-NO demand is meaningful enough to justify the cost.

**Alternatives considered:**

- **(a) Ship Limit-NO with explicit "you'll eat the fee on cancel" warning:** rejected. Erodes POV-3 atomicity guarantee; users will angrily report "you stole my fee" without understanding the design.
- **(b) Don't ship NO paths at all (only Buy/Sell YES):** rejected. NO is a first-class product surface per PRD §3.2 / §3.4. Cutting it would mean users can only express bullish views — major UX regression.
- **(c) Ship Limit-NO + Option 2 (auto-redeem on cancel) in v1:** rejected. Adds Cleo scope + an event-listener dependency; v1 submission timeline doesn't accommodate the testing surface. v1.5+ work.

---

> Aim for 5–15 active DRs over a project's life. Fewer and you're not
> locking enough; more and the file becomes unscannable (rotate stable
> ones into `specs/architecture.md` if they've become "just how the
> system works" rather than "a choice we made").

> **Citation format:** "per `constitution/decisions.md` DR-007"
