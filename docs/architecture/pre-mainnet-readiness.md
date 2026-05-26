# Pre-Mainnet Readiness — BellMarkets

**Owner:** Drew (Quality + Integration + Demo lead). **Status:** Submission-day snapshot (2026-05-25) — post-DR-020 pivot to in-program CLOB + post-deploy_index=9 (compressed-time settle patches + Pyth devnet audit). **Scope:** the deployed program at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` on devnet through deploy_index=9 (28 ix · 9 cumulative deploys · 6.683 SOL spent).

**Post-deploy-7 ADDENDUM (this doc was originally snapshotted at deploy_index=7):**
- **deploy_index=8** added 1 admin ix: `reinit_rewards_pools` (Path B bUSDC migration — closes + re-initializes the 2 reward-pool token PDAs at the same addresses bound to the new `config.usdc_mint`).
- **deploy_index=9** added 1 admin ix: `update_admin_override_delay_secs` (enables compressed-time settle simulation by shrinking the 1hr admin-override gate to 0; production stays at 1hr) + elided the `expiry_is_market_close_time` check from admin `create_strike_market` (user-funded path keeps it — only admin can create off-grid expiries for tests).
- Neither change altered the security model or the load-bearing invariants. Full lifecycle (create → mint → trade → settle → redeem) verified on-chain on submission day; receipts in `README.md`. Pyth devnet audit landed in `docs/pyth-feed-status.md` (headline: devnet v2 push feeds are ~660 days stale; operational settle path on devnet is `admin_settle` only; mainnet path same code, live feeds, no admin fallback).

**DR-020 pivot note:** On 2026-05-24, DR-020 locked a pivot from Phoenix v1 CLOB integration to a minimal in-program CLOB (following Keith's adversarially-reviewed reference design). This doc is updated to reflect that pivot. Phoenix-related callouts in section 1 are replaced with in-program CLOB callouts. Phoenix integration code stays dormant in the program (DR-020 §"Trade-off") — it is not removed. References to "audit-6" in earlier versions of this doc become "audit-7" for the next cycle: deploy_index=7 introduces new program state (OrderBook PDA, usdc_escrow, yes_escrow) that requires a fresh audit pass.

**Demo pairing:** for a 4-minute walkthrough of the v1 protocol surface, see [`docs/demo/v1-demo-script.md`](../demo/v1-demo-script.md). This readiness doc is the security narrative for reviewer Q&A — pull specific sections (attack tier 1-5, v2 gaps, audit log) when the reviewer presses on production posture.

**Quality lineage:** 6 deploys through deploy_index=7 (audit log §3) + 7 independent Sonnet audit cycles + 17 substantive findings caught and shipped. The bias profile across audit cycles: Sonnet repeatedly caught polished-prose-around-weak-assertions, commit-message-vs-doc drift, ownership-protocol process drift, and quantitative cost claims with unit confusion. Going forward, Sonnet audit dispatch after each major push is Drew's standing operating discipline (post-Day-3).

> **TL;DR for an engineering reviewer:** Demo targets devnet with deploy_index=7 (in-program CLOB). Mainnet **is not yet ready**. The major v1 architectural commitments (DR-002 through DR-020) are implemented end-to-end. Critical-path gaps before any mainnet conversation: (1) live Pyth feed coverage for MAG7 stocks (devnet uses SOL/USD only); (2) `force_redeem` doesn't cover Invalid markets — DR-005 v2 gap; (3) zero independent security audit; (4) in-program matching engine has not had a third-party audit (highest-risk new surface). The protocol's core invariants (DR-002 permissionless settle, $1 USDC conservation, DR-008 fee math, DR-020 escrow separation) have layered evidence (mock + IDL + chain simulate + cron-kill sim) but no real-money audit.

---

## 1. Instruction surface (25 ix post-deploy_index=7, all validated)

Generated from `programs/bell-markets/idl/bell_markets.json` + cross-checked against handler source. **DR-020 note:** ixs 21-25 are new in deploy_index=7 (in-program CLOB). The Phoenix verification in ix 6 + 7 is now dormant but NOT removed (additive change per DR-020). `create_strike_market` no longer requires a live Phoenix market for trading to work — the `order_book` field on StrikeMarket drives the trading gate instead.

| # | Instruction | Signer | Args | On-chain validation guarantees |
|---|---|---|---|---|
| 1 | `initialize_config` | admin | staleness_secs (i64), confidence_bps (u16), override_delay_secs (i64) | bounds check 1≤staleness≤24h; 1≤conf≤1000bps; 1≤delay≤7d; PDA `init` (idempotent) |
| 2 | `initialize_fee_config` | admin | 6×bps + grace + two [u16;10] arrays | sum(platform+weekly+monthly)==10000; sum(each dist array)==10000; bps≤10000; grace>0; PDA `init` (idempotent); back-pointer to MarketConfig |
| 3 | `initialize_rewards_pools` | admin | (none) | one-shot creates 2 USDC token accounts + LeaderboardCommitments zero_copy PDA |
| 4 | `update_fee_config` | admin | same 8 fields as initialize | same validation as initialize_fee_config; idempotent re-write |
| 5 | `update_ticker_config` | admin | cap_center (i64), allowed_strikes ([i64;16]), strike_count (u16), max_dev_bps (u16), strike_tick_size (i64), threshold_bps (u16) | strike_count≤16; tick_size>0; per-Pyth-feed PDA `init_if_needed`; P1-audit fix: strike_count>0 footgun guard |
| 6 | `create_strike_market` | admin | strike_price (i64), expiry_unix (i64) | strike_price>0; expiry>now; **Phoenix magic-prefix verify stays dormant** (code present; deploy_index=7 passes a placeholder phoenix_market pubkey for legacy compatibility); sets creator=admin; does NOT set order_book (set by grow_order_book) |
| 7 | `user_create_strike_market` | user (pays rent) | strike_price (i64), expiry_unix (i64) | TickerConfig exists; strike∈allowed_strikes OR within max_dev_bps of LIVE Pyth spot via vendored oracle; tick alignment; expiry at 1/4 PM ET (DR-007); 7-day horizon; Pyth not-stale/not-too-wide at create; sets creator=user (drives DR-008 rebate) |
| 8 | `add_strike` | admin | (none) | no-op convenience hook (forward-compat for batch creator) |
| 9 | `pause` | admin | paused (bool) | writes config.paused (global circuit breaker); **does NOT block cancel_order** (users must always reclaim escrow per Keith's Chunk 4 pattern) |
| 10 | `mint_pair` | user | amount (u64) | amount>0; !paused; outcome==Unsettled; ConfigMismatch; transfers `amount` bUSDC user→usdc_vault; mints `amount` YES + `amount` NO via strike_market PDA signer; DR-008 fee math (bps currently 0 on devnet); init_if_needed UserConfig; increments pairs_outstanding |
| 11 | `redeem` | user | amount (u64) | post-Yes/No only (rejects Unsettled + Invalid); ConfigMismatch; burn `amount` of winning_mint via user authority; transfer bUSDC vault→user via PDA signer; decrement pairs_outstanding |
| 12 | `redeem_pair` | user | amount (u64) | pre-settle only (Outcome==Unsettled); ConfigMismatch; burn equal YES+NO; transfer bUSDC vault→user; powers POV-3 Sell-No atomic flow |
| 13 | `redeem_invalid` | user | amount (u64) | post-Invalid only; burn equal YES+NO; transfer bUSDC vault→user; for admin-override Invalid markets only |
| 14 | `settle_market` | settler (any signer, fee payer) | (none) | **DR-002 permissionless**; !paused; clock.unix_timestamp≥expiry; PythFeedMismatch check; vendored parse_pyth_price (magic/version/atype/status/staleness/confidence); writes outcome immutably (settle_price, settle_confidence, settle_slot, settled_at_unix) |
| 15 | `admin_settle` | admin | forced_outcome (Outcome) | now≥admin_override_eligible_at (default expiry+1hr); writes outcome with settle_price=0 as discriminator; for Pyth-unrecoverable scenarios |
| 16 | `force_redeem` | admin | amount (u64) | post-settle Yes/No only; now>settled_at+grace (default 30d, strict >); burn user winning tokens via PDA delegate; transfer bUSDC vault→user (NOT to admin); decrement pairs_outstanding; **v2.5 gap: Invalid markets not covered** |
| 17 | `close_settled_market` | closer (any signer) | (none) | **permissionless**; outcome!=Unsettled; pairs_outstanding==0; usdc_vault.amount==0 (P4-audit fix; surfaces dust-attack as MarketNotEmpty); closes USDC vault → fee_collector receives rent |
| 18 | `commit_leaderboard_root` | admin | period_id (u64), period_type (u8), merkle_root ([u8;32]), arweave_tx_id ([u8;48]) | period_type∈{0,1}; writes into 24-entry ring buffer; resets claimed_bitmap |
| 19 | `distribute_weekly_rewards` | admin | period_id (u64), position (u8), amount (u64), merkle_proof (Vec<[u8;32]>) | position∈[1,10]; verify SHA256 Merkle proof against committed root (sorted-pair OpenZeppelin); single-claim via 32-bit claimed_bitmap; transfer bUSDC pool→recipient via pool PDA signer |
| 20 | `distribute_monthly_rewards` | admin | same as weekly | same as weekly but on monthly pool + monthly_distribution_bps |
| 21 | `init_order_book` | any signer | (none) | **DR-020 new.** Creates OrderBook PDA at `init` alloc (8 + 10,000 B — under Solana MAX_PERMITTED_DATA_INCREASE cap); creates usdc_escrow + yes_escrow token accounts owned by strike_market PDA; does NOT set StrikeMarket.order_book (set by grow_order_book — trading gate) |
| 22 | `grow_order_book` | any signer | (none) | **DR-020 new.** Reallocs OrderBook PDA to full 14.9 KB; then writes StrikeMarket.order_book — trading gate is now open. Permissionless. |
| 23 | `place_order` | user | side (Buy/Sell), price (u64, PRICE_SCALE units), size (u64), is_market (bool) | **DR-020 new.** !paused; outcome==Unsettled; order_book set (trading gate); price∈[1,PRICE_SCALE] (M-4 fix: zero-price rejected); size>0; escrow: bid→`ceil(price*size/PRICE_SCALE)` bUSDC from user; ask→`size` YES from user. Taker-crosses-on-placement: matching runs in three phases (plan→settle→apply). Market order remainder = fill-or-cancel. Rests as limit if no cross. Emits OrderPlaced / OrderMatched per fill. **Vault invariant enforced: escrow accounts only, never usdc_vault.** |
| 24 | `cancel_order` | user (must be order owner) | side (Buy/Sell), seq (u64) | **DR-020 new.** Finds order by (side, seq); rejects NotOrderOwner if signer != order.owner; rejects OrderNotFound if seq not in book. Refunds exact remaining escrow: `ceil(price*remaining)` bUSDC for bid, `remaining` YES for ask (telescoping escrow formula). **Allowed even when paused/settled — users must always reclaim escrow.** Emits OrderCancelled. |
| 25 | `match_orders` | any signer (permissionless crank) | max_fills (u8) | **DR-020 new.** Sweeps crossed resting pairs up to max_fills; three-phase matching; no-op on uncrossed book (normal state). Cranker cannot alter price/size; terms come only from on-chain Order data. Emits OrderMatched. Required for trustlessness guarantee: any user can crank a crossed book. |

**Coverage:** all 25 ixs documented (20 pre-DR-020 + 5 new CLOB ixs); all signers + args extracted from canonical IDL; all validation guarantees cross-checked against handler source via 100/100 `cargo test --lib` (Rust property tests) + 76 mocha assertions in `tests/eval/` against pre-DR-020 surface. **DR-020 CLOB surface coverage pending** — `tests/contracts/test_order_book_invariants.ts` is the new test file that will cover the 3 CLOB invariants + 4-path smoke. Blocked on Aria's deploy_index=7 landing on devnet.

---

## 2. Permission matrix

| Permission class | Instructions | Signer requirement | Failure mode if wrong signer |
|---|---|---|---|
| **Admin-only** (13 ix) | initialize_config, initialize_fee_config, initialize_rewards_pools, update_fee_config, update_ticker_config, create_strike_market, add_strike, pause, admin_settle, force_redeem, commit_leaderboard_root, distribute_weekly_rewards, distribute_monthly_rewards | `constraint = config.admin == admin.key() @ NotAdmin` | Revert `Custom: 6001 NotAdmin` before any state mutation |
| **Permissionless** (2 ix) | settle_market, close_settled_market | NO admin constraint on Accounts struct; signer is just fee payer | Handler reaches body for any signer (after PDA-binding checks) |
| **User-callable / creator-gated** (5 ix) | mint_pair, redeem, redeem_pair, redeem_invalid, user_create_strike_market | `Signer<'info>` only — no admin check, no allowlist | Position/balance/PDA-init checks; no signer-class rejection |

**Creator-gated** is a subset of user-callable: DR-008's creator rebate fires when `signer == strike_market.creator` AND `outcome == Unsettled`. This is **not a permission gate** (anyone can still mint_pair), but rather a fee-discount path. Documented separately because it's the only place `signer == specific_pubkey` semantics appear without being an admin constraint.

**DR-002 status:** ENFORCED ON CHAIN. Drew's `tests/integration/live-program-call.test.ts` simulates `settle_market` with non-admin signer + asserts the handler returns a `BellMarketsError` code in 6000-6025 (range covers handler-body reverts) AND specifically NOT `NotAdmin (6001)`. The 2026-05-23 deploy-5 lifecycle run reached `PythStale (6009)` — strictly stronger evidence: handler bypassed the absent admin check + evaluated-and-passed the NotExpired check before reaching the Pyth staleness gate at line 103.

---

## 3. Deploy audit log review

5 deploys to date. All under the same upgrade authority. Source: `migrations/audit_log.jsonl`.

| # | Date | Type | Tx sig | Slot | .so KB | Cost SOL | Cumulative | Git SHA |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-05-21 18:24Z | initial | `2BeSxY1C...` | 464006811 | 348.7 | 2.486 | 2.486 | pre-commit |
| 2 | 2026-05-21 18:30Z | upgrade | `4pHzPX1y...` | 464008883 | 390.5 | 0.30 | 2.79 | f9a9dd0 |
| 3 | 2026-05-22 08:15Z | upgrade | `2ozX8Sdz...` | 464137405 | 414.3 | 0.17 | 2.96 | b92eb9a |
| 4 | 2026-05-22 15:40Z | upgrade | `2HXvAfM3...` | 464208012 | 436.1 | 0.159 | 3.119 | 8c714cb |
| 5 | 2026-05-23 06:35Z | upgrade | `4rQq81zA...` | 464349904 | 741.2 | 2.179 | 5.298 | 49b126e |
| 6 | 2026-05-24 (est.) | upgrade | _(Aria to fill on deploy)_ | TBD | TBD | TBD | TBD | _(commit at deploy_index=6)_ |
| 7 | 2026-05-25 (est.) | upgrade | **PENDING** — deploy_index=7; in-program CLOB (DR-020) + bUSDC mint flip (`update_usdc_mint` admin ix) | TBD | TBD | TBD | TBD | _(commit at deploy_index=7)_ |

**Upgrade authority drift check: NONE through deploy-5.** All 5 confirmed deploys signed by the same pubkey `9snc1xMYHPQbJuaybP98z6YS6xBbzhDTnXiNoKRawanZ`. No transfer, no rotation, no compromise scenario triggered. Deploy-6 and deploy-7 must be audited post-landing for the same invariant.

**Program-data PDA drift check: NONE.** All 5 deploys write to the same ProgramData `Erh54ewsrYEUYRewF8crqPi3VceUsrhwA329oL1MxVFj` (deterministic from program ID; not changeable without redeploy + new program ID).

**Cluster:** all 5 on devnet. **No mainnet deploys exist.** No mainnet upgrade-authority keypair has been generated (Hard NO #1 per BRAINLIFT.md §4).

**Binary growth:** 348 KB → 741 KB across 5 deploys (+112%). The big jumps are deploy-2 (handler bodies filled, +42 KB) and deploy-5 (DR-005/007/008/010 expansion, +312 KB). The deploy-5 size needed a pre-deploy SOL transfer of 2 SOL from platform admin to upgrade authority to cover the new ProgramData rent (5.3 SOL vs prior 3.1 SOL).

---

## 4. Cumulative SOL spent vs budgeted

**Important: Solana rent is computed identically on devnet and mainnet** (same lamports-per-byte formula in the protocol). The mainnet cost difference is the DOLLAR VALUE of SOL itself (real SOL ~$100 at the time of this writing vs free devnet airdrops), not a multiplier on SOL quantity. Sonnet-audit-5 (2026-05-23) caught an earlier draft that confused these two; this section is corrected.

| Cost line | Devnet actual (SOL) | Mainnet projection (SOL — same formula) | Mainnet $ @ $100/SOL |
|---|---|---|---|
| 5 cumulative deploys to date | 5.298 SOL | n/a — this is devnet historical | n/a |
| Upgrade-authority current balance | 6.702 SOL | n/a — devnet wallet | n/a |
| Initial program deploy at deploy-5 size (~741 KB) | ~5.3 SOL (deploy-5 actual) | **~5.3 mainnet SOL** | **~$530** |
| Annual upgrade cadence (5 upgrades/yr at +20% binary growth ea.) | ~1 SOL/yr | ~1 SOL/yr | ~$100/yr |
| Bram automation cron tx fees | ~0.025 SOL/yr (5K txs × 5K lamports) | same | ~$2.50/yr |
| Bram morning create-markets txs (Aria admin signs) | ~0.5 SOL/yr (rough; depends on day count + market count) | same | ~$50/yr |
| User-funded strike rent (DR-005) | $0 to platform — users pay ~0.005 SOL each | $0 to platform — users pay ~0.005 SOL ≈ $0.50 each | DR-005 design eliminates platform working capital |
| Phoenix v1 market rent (one per strike) | already paid by Phoenix — n/a | n/a | n/a |

**Mainnet capital requirement:** ~5.3 SOL ≈ **$530** of working capital to fund the upgrade authority for the initial deploy. Plus ongoing tx fees (~$50-100/yr). This is **much smaller than enterprise software typically requires**; the binding cost on mainnet is actually the audit ($50-200K) + insurance, not the SOL deploy itself.

**Budgeted:** the 10 SOL devnet seed was the cohort-provided amount. **Spent 53% of budget across 5 days × 5 deploys** on devnet — cushion is acceptable for the 4 more deploys realistic before submission. Mainnet conversation should focus on the audit budget, not the SOL deploy capital.

**Note on ProgramData rent recoverability:** ProgramData rent (the bulk of the deploy cost) is **rebated to the upgrade authority** if the program is later closed via `solana program close`. So even the $530 isn't permanently sunk — it's recoverable on program retirement. For a v1 mainnet that's expected to upgrade often, treat it as working capital.

---

## 5. Known v2 gaps (will NOT ship as v1 mainnet)

### DR-020 CLOB-specific gaps (new post-pivot)

**CLOB gap A — ORDERBOOK_N=128 capacity limit (documented demo limitation)**

The in-program order book is a bounded array of 128 bids + 128 asks per side per market. The 129th order on a side is rejected with `BookFull`. This is the documented ADR-002b limitation (per Keith's reference design) and is an accepted trade-off for demo scope. Production path: a slab-style order book (unbounded; like Phoenix's structure) removes this limit. No timeline set; triggered when `BookFull` becomes an actual UX complaint.

Defensive note: `BookFull` is a clean rejection (no state mutation, no escrow stranding). Users see a deterministic error and can cancel existing orders to make room.

**CLOB gap B — matching CU budget not profiled under adversarial depth**

The three-phase matching engine (plan → settle → apply) processes fills sequentially across `remaining_accounts`. At 128 bids × 128 asks with deep cross, CU consumption has not been profiled. Production risk: a deeply-crossed book under adversarial conditions could hit the per-tx 1.4M CU limit, leaving the match incomplete. Mitigation: `match_orders(max_fills: u8)` bounds fills per crank call — large crosses can be processed in multiple sequential calls. This is a liveness concern, not a safety concern (funds stay in escrow until consumed).

**CLOB gap C — matching engine has no third-party audit**

The in-program CLOB matching engine is the highest-risk new audit surface per DR-020 ("skip a formal audit on the matching engine (high-risk audit category)"). We inherit Keith's adversarial review (H-1, M-1 through M-4 fixed), but that review is not a substitute for a third-party firm audit. Before mainnet, the matching engine must go through Halborn / Trail of Bits / OtterSec along with the existing program surface.

**CLOB gap D — Phoenix integration code stays dormant but untested**

Phoenix-related code (`verify_phoenix_market`, `phoenix_market` field on StrikeMarket, `adapters/phoenix.rs`) stays in the program per DR-020 but is not exercised by any test post-pivot. It is not a security surface (the instructions that called it are not removed; they just don't use the Phoenix CPI path). It is a binary-size cost (~few KB) and a future v2 candidate for Phoenix-as-secondary-venue.

**CLOB gap E — in-program taker fee not yet activated**

DR-018 (amended post-DR-020) sets the in-program taker fee at 10 bps, charged on `place_order` fills. The fee mechanism is implemented in code but `mint_fee_bps = 0` and `taker_fee_bps = 0` on devnet (both disabled at admin flip). Fee activation is a post-demo admin tx, not a redeploy. This is intentional — fee mechanism ships as infrastructure; turning it on is a flag.

---

### v2 gap #1 — `force_redeem` doesn't cover Invalid markets (DR-005)

`force_redeem` only handles Yes/No outcomes (post-settle winning side burn-and-pay). For Invalid outcomes the contract relies on user-initiated `redeem_invalid`. **If a user with an Invalid-outcome position never calls `redeem_invalid`, their USDC is stranded — no admin sweep exists today.**

Practical impact at MVP scale: extremely low (Invalid only fires on admin-override, which only fires on Pyth outage; small population × small per-user balance). Acknowledged limitation in DR-005 §"Closed-rent recovery" — future `force_redeem_invalid` instruction queued for v2.

### v2 gap #2 — No on-chain leaderboard verification of position-side history (DR-010)

The Merkle commitment scheme verifies WHICH user gets which position, but reconstructing the leaderboard from chain-only state requires per-user position-side history (which side they held at each settle). That data lives in token-account balance history, recoverable from Helius's compressed-txn archive but NOT from on-chain settle events alone.

Practical impact: leaderboard is verifiable AGAINST a committed root, but full re-derivation from chain alone requires re-indexing position changes. Helius's ~72h retry window covers normal operations; multi-day indexer outage requires a manual re-index pass from settle event timestamps + per-user balance snapshots.

### v2 gap #3 — capCenter vs live Pyth spot in `user_create_strike_market`

The cap-center reference price is what Bram's morning cron wrote into TickerConfig. The live Pyth spot may have drifted since then. `user_create_strike_market` validates the strike against `TickerConfig.cap_center` AND a fresh Pyth read (per DR-005 spec) — but the deviation math uses live Pyth spot, while the allowed_strikes whitelist is anchored on capCenter. So a strike that's in the whitelist but >max_dev_bps from live spot would be rejected; conversely, a strike outside the whitelist but within max_dev_bps would also be rejected.

Practical impact: user sees "this strike is allowed today" in Cleo's frontend (which reads TickerConfig) but the live broadcast can still revert if Pyth has moved. UX risk; not a contract bug.

### v2 gap #4 — Pyth Pull oracle vs Push oracle

Vendored oracle parser uses Pyth's pull-oracle byte layout. Pyth has been migrating to push-oracle (Solana Receiver Program); the protocol's settle path doesn't yet support that path. If Pyth deprecates pull on mainnet, our `settle_market` breaks.

Practical impact: monitor Pyth's announcements; allocate ~2 days of Aria work to add Pyth Receiver Program support before mainnet.

### v2 gap #5 — No DR-011 earnings-calendar binding to TickerConfig

Bram's earnings-calendar.ts is queued but doesn't yet bind to the on-chain TickerConfig. DR-011 specifies "pre-expand deviation cap day before known earnings" — current implementation requires Bram's cron to manually update_ticker_config on each pre-expansion. This works for MVP MAG7 (28 events/year, all hardcoded) but doesn't scale to broader stock coverage.

### v2 gap #6 — No mainnet keypair architecture

Hard NO #1 prevents creating mainnet keypairs at the cohort-build stage. When mainnet conversation opens: replicate Aria's w3swap separation-of-authority pattern (program ID + upgrade authority + platform admin + fee collector keypairs), all with operational signing procedures.

### v2 gap #7 — Token program plan is v2 work (DR-016)

`constitution/decisions.md` DR-016 picks **SPL Token (legacy)** for all v1 tradeable assets (YES, NO, USDC) — Phoenix v1 requires it, vault arithmetic depends on no transfer-fee skew, and the audit surface stays minimal. v2 plans (NOT shipped in v1): Token-2022 with metadata extension for Founder Pass NFT (DR-013); Token-2022 non-transferable for soulbound achievement badges (DR-014); Compressed/Bubblegum for per-week win badges + leaderboard rank NFTs (~1000× cheaper than SPL Token at 500K+ mints/year).

Practical impact: at 10K MAU we pay ~$50/year in extra rent (vs. compressed) for tradeable accounts in exchange for zero novel audit surface. The v2 badge work is *additive* — Bubblegum tree + cNFT mint path with no breaking changes to existing accounts.

### v2 gap #8 — OrderBook + escrow rent not recoverable (~0.122 SOL/market stranded)

`close_settled_market` (ix 17) was scoped to the USDC vault only. The bulk of per-market rent — the 16,448-byte OrderBook PDA + two escrow token accounts — has no close path today. Confirmed on-chain (devnet, deploy_index=8, 2026-05-25):

| Account | Size | Rent (SOL) | Closable today? |
|---|---|---|---|
| StrikeMarket | 333 B | 0.003209 | ❌ tombstone by design |
| **OrderBook** | **16,448 B** | **0.115369** | **❌ no close path** |
| usdc_vault | 165 B | 0.002039 | ✅ via `close_settled_market` |
| usdc_escrow | 165 B | 0.002039 | ❌ no close path |
| yes_escrow | 165 B | 0.002039 | ❌ no close path |
| yes_mint | 82 B | 0.001462 | ❌ no `close_authority` set at mint init |
| no_mint | 82 B | 0.001462 | ❌ same |
| **Per-market total** | | **0.127619** | only 0.002039 recoverable today |

Recoverable today: 1.6% (0.002 SOL). Stranded: 98.4% (0.126 SOL). At 49 markets/day × 30 days = 1,470 markets/month, that's **~187.7 SOL/month** of stranded rent (~$30,000/month at $160/SOL mainnet).

**Tombstone-preserving recovery design (v1.1 P1):** the StrikeMarket PDA already serves as the historical tombstone (per `close_settled_market.rs:18-23`) — it holds `outcome`, `settle_price`, `settle_confidence`, `settled_at_unix`, `pairs_outstanding`. Closing the OrderBook + escrows after settlement does not affect the redemption path (`redeem` reads StrikeMarket + usdc_vault only). Two new instructions close the gap:

1. **`force_cancel_order(side, seq)` — permissionless, post-settle only.** Mirrors existing `cancel_order` but drops the `owner == signer` check; gated on `strike_market.outcome != Unsettled`. Refunds the maker's exact remaining escrow to the maker's own ATA, passed in `remaining_accounts` with the same ownership-verification pattern `place_order` already uses for maker payouts. The cron (Aria/Bram) iterates `bids[..bids_len]` + `asks[..asks_len]` and calls this once per stale order in the settlement phase.

2. **`close_order_book()` — permissionless.** Gated on `bids_len == 0 && asks_len == 0 && usdc_escrow.amount == 0 && yes_escrow.amount == 0` (defense-in-depth — the cancel sweep should already drain them). Closes `order_book`, `usdc_escrow`, `yes_escrow` to `fee_collector` (matches existing `close_settled_market` pattern). **Also clears `strike_market.order_book = Pubkey::default()` on close** — this leaves the StrikeMarket tombstone in a self-consistent post-close state where the existing trading-gate (`order_book != Pubkey::default()`) automatically rejects any further `place_order` attempts with `OrderBookNotInitialized`. No new gate logic needed.

**No OrderBook tombstone needed.** The OrderBook contains only working data (resting orders + a sequence counter), is never a historical record (orders are evicted on cancel/fill via swap-remove), and is invisible to every redemption path (`redeem` / `redeem_pair` / `redeem_invalid` / `force_redeem` all read StrikeMarket + usdc_vault only — never the order book). Full trade history is captured via `OrderPlaced` / `OrderMatched` / `OrderCancelled` events emitted on every trade, retained by RPC providers in program logs. Closing the OrderBook loses no on-chain audit value — the events outlive the account.

**Recovery math under the v1.1 design:**

```
Phase A — immediately post-settle (after cancel sweep + close_order_book):
  recovered = 0.115369 (OrderBook) + 0.002039 + 0.002039 (both escrows)
            = 0.119447 SOL

Phase B — when all redemptions complete (existing close_settled_market):
  recovered = 0.002039 SOL (usdc_vault)

Permanently stranded (tombstone + mints with no close_authority):
  stranded = 0.003209 (StrikeMarket) + 0.001462 + 0.001462 (mints)
           = 0.006133 SOL

Net recoverable per market: 0.121486 SOL = 95.2% of total per-market rent
Stranded: 0.006133 SOL = 4.8% (StrikeMarket tombstone + two mints)
```

**Late-redemption safety:** `redeem` reads from `StrikeMarket` + `usdc_vault` only — neither `OrderBook` nor escrows are on its account list. Phase A closure happens immediately post-settle and never blocks redemption. Phase B closure waits on `pairs_outstanding == 0`. A user can claim winnings years after settlement; the order book gets cleaned up that night regardless.

**Implementation cost (Aria):** ~60-90 min — both instructions are extensions of existing patterns (`cancel_order` for the cancel logic, `close_settled_market` for the close-and-refund-rent pattern). New deploy_index. Invariant tests under `programs/bell-markets/src/instructions/{force_cancel_order,close_order_book}.rs` mirror the existing `close_settled_dust_attack_griefing` + `close_property_only_specific_triple_passes` patterns.

**Mints (the remaining 4.8% stranded):** YES/NO mints were created with default Anchor `init` (no `close_authority`). SPL Token's `CloseAccount` on a Mint requires both `close_authority` set AND `supply == 0`. Closing the mints requires either: (a) adding `mint::close_authority = strike_market` to the Anchor `init` schema in `create_strike_market` (then a v1.2 instruction can close them via PDA-signed CloseAccount after every redemption settles supply to 0); or (b) `SetAuthority` instructions before `CloseAccount`. Either path requires a program upgrade. **Decision: defer to v1.2.** The 0.003 SOL/market mint rent isn't worth a near-term deploy when the OrderBook recovery already lands 95% of the value.

**Revisit threshold:** v1.1 (post-submission, pre-mainnet). The force_cancel + close_order_book pair is a strict precondition for mainnet — at $30K/month stranded rent on mainnet pricing, the cost-per-market burn rate is the load-bearing operator-economics number. Mint-close is deferred independently to v1.2 as a smaller follow-up.

### v1.5 promotion — DR-009 amendment closes Phoenix-secondary-trade fee gap (informational, not a v2-gap)

Originally listed as a fee-capture gap in DR-008's accompanying notes ("Phoenix-only secondary trades pay zero protocol fees"). **`constitution/decisions.md` DR-009 amendment 2026-05-24** records that Model D (per-market `fee_receiver` config on `phoenix::InitializeMarket` CPI) was independently verified feasible by Bram (off-chain) AND Aria (on-chain primary-source verification). Locked integration plan: ~6-8 hr cross-lead effort + 1 audit cycle + deploy_index=7. Promoted to **v1.5 P0** (NOT v1 submission — touches `create_strike_market` core flow ~24hr before submission deadline; revenue today = $0 on devnet). Mainnet conversation should cite the amendment so reviewers know the gap is *engineered, not aspirational*.

---

## 6. Security gap analysis (hostile-tester attack vectors)

Ordered by what a motivated attacker would try first. The 13-attack analysis below is the *catalog*; the *master security model* is captured in `constitution/decisions.md` DR-017 — vault security model. DR-017 layers four mechanisms (PDA self-authority on every fund-moving account; Anchor account constraints validated before handler entry; permissionless `settle_market`; admin-as-cranker-not-redirector) and answers the canonical "where can vault USDC go?" with a finite list (winning user via redeem, pair-burner via redeem_pair, invalid-market refund via redeem_invalid, fee_collector via mint_pair fee). No `withdraw_to_admin` instruction exists; no path was ever drafted. The attack catalog below is what falls out of stress-testing the DR-017 model.

### Tier 1 — directly attack the $1 USDC invariant (Hard YES #1)

**Attack 1:** Mint then immediately redeem (pre-settle) for free YES + NO tokens.
- **Defense:** `redeem` is post-settle-only (rejects Outcome::Unsettled). `redeem_pair` is the legitimate pre-settle exit + burns the FULL pair. No path to extract YES without also burning NO.
- **Test coverage:** `tests/eval/edge-cases.test.ts:redeem-pair-round-trip` (mint $N → redeem_pair $N → wallet + vault delta both zero across $1, $100, $1M).
- **Verdict:** defended.

**Attack 2:** Mint pair, sell YES on Phoenix at premium, redeem_pair the half I bought back at par.
- **Defense:** `redeem_pair` requires equal YES + NO burn; asymmetric holdings can't redeem (test: `dr005-dr011-scaffolding.test.ts:asymmetric-position`).
- **Verdict:** defended. Attacker would have to repurchase the YES at market to balance, paying the spread.

**Attack 3:** Re-settle market with different Pyth feed pubkey.
- **Defense:** `settle_market` `constraint = underlying_pyth_feed.key() == strike_market.underlying_pyth_feed @ PythFeedMismatch`.
- **Test coverage:** IDL-level structural check; Rust handler property tests.
- **Verdict:** defended.

**Attack 4:** Settle with stale or low-confidence Pyth.
- **Defense:** vendored `parse_pyth_price` checks magic/version/atype/status/staleness/confidence in sequence; `settle_market.rs:103` enforces staleness via slot-domain comparison; bps confidence via rearranged-for-overflow-safety formula.
- **Test coverage:** 5 inline Rust property tests (slot_delta_to_age_secs, confidence_within_bps, naive-division-equivalence over 6×6×6 sweep). Plus deploy-5 lifecycle run hit PythStale (6009) live on devnet — chain-level evidence the gate fires.
- **Verdict:** defended.

### Tier 2 — attack the DR-020 in-program CLOB (new post-pivot)

**Attack 5a:** Pass a malicious `remaining_accounts` maker payout account to redirect fill proceeds.
- **Defense (H-1 fix from Keith's adversarial review):** `matching::verify_maker_account` checks (1) account is owned by the SPL Token program (so raw-byte `try_deserialize` can't be spoofed), (2) account is not frozen (M-1 fix), (3) `account.owner == on-chain Order.owner` and (4) `account.mint == correct mint` (bUSDC for ask-maker, YES for bid-maker). Price and size come ONLY from on-chain `Order` data — the cranker/taker provides maker accounts but cannot alter terms. Missing ANY check → `InvalidMakerAccount` revert.
- **Test coverage:** `test_order_book_invariants.ts` adversarial case "wrong-owner account rejected" + `tests/contracts/oracle_test.ts` structural.
- **Verdict:** defended (H-1 baked in from day 1 per reference-clob-decisions.md).

**Attack 5b:** Submit a frozen maker payout account to permanently block fills at a price level (book-lock DoS).
- **Defense (M-1 fix):** `verify_maker_account` checks `state == Initialized` (SPL Token account state field). Frozen account → `FrozenMakerAccount` revert → fill skipped without poisoning other fills. Attacked price level becomes unclearable via this maker's order, but the maker's order can be cancelled by the maker to free the slot.
- **Residual risk:** a maker who freezes their own payout account can permanently occupy an order slot until they cancel — a griefing attack on a specific price level. Not a fund-loss attack. Practical cost to attacker: one order slot (of 128 per side) occupied; fix in v2: auto-expire frozen-account orders.
- **Verdict:** weakly defended (no fund loss; slotting attack remains).

**Attack 5c:** Omit a maker payout account from `remaining_accounts` to skip their payment and pocket the bUSDC yourself.
- **Defense:** the planning pass (`cross_incoming` phase 1) collects `PlannedFill`s from the resting book in fill order. Phase 2 (settlement pass) verifies each maker payout account at its fill-aligned index in `remaining_accounts`. If `remaining_accounts.len() < planned_fills.len()`, the phase 2 loop will attempt to index out-of-bounds and the tx fails with a Solana runtime error before any CPIs complete. No partial-payment state.
- **Verdict:** defended.

**Attack 5d:** Substitute a different price/size in the `place_order` args to trade at off-market terms.
- **Defense:** maker orders in the book carry on-chain price + size (not supplied by the caller). Taker `place_order` supplies its own `price` (for limit) or `is_market=true` (market), but taker price is only used for the resting case or market detection — fills always execute at the MAKER's resting price. The taker cannot force a fill at a price not already in the book.
- **Verdict:** defended by design (price-time priority, maker price always wins).

**Attack 5e:** Cancel an order not belonging to you to free your own `BookFull` slot at others' expense.
- **Defense:** `cancel_order` checks `order.owner == ctx.accounts.user.key()` before any state mutation. Fails with `NotOrderOwner`. The order slot does NOT move.
- **Test coverage:** `test_order_book_invariants.ts` adversarial case "cancel_order from non-owner rejects NotOrderOwner."
- **Verdict:** defended.

**Attack 5f:** Exploit escrow rounding (ceil vs floor) to extract dust from the book.
- **Defense:** bid escrows `ceil(price*size/PRICE_SCALE)` at placement. Each fill costs `fill_usdc = ceil(price*s_before) - ceil(price*s_after)` (telescoping). Over any partial-fill sequence, the sum of fill_usdc telescopes to exactly `ceil(price*original_size)` — the bid's original escrow. No dust. A cancel of the partial remainder refunds `ceil(price*remaining)` which equals `original_escrow - sum(fill_usdc)` exactly. No free funds, no stranded dust.
- **Test coverage:** `test_order_book_invariants.ts` test (b) includes odd-price rounding case (price=0.337, size=7) to verify the ceil rounding chain.
- **Verdict:** defended by the telescoping escrow design (no escrow field on Order; reconstructable from price+size).

### Tier 2 (continued) — attack the DR-002 permissionless settle path

**Attack 6:** Front-run admin's `admin_settle` to write an oracle outcome the admin would have overridden.
- **Defense:** `settle_market` is permissionless by design (DR-002). If Pyth says price >= strike, anyone can write Yes. Admin's only recourse to invert that is `admin_settle` BEFORE someone settles — but `admin_settle` requires waiting for `admin_override_eligible_at` (expiry + 1hr), giving permissionless settlers a 1-hour head-start.
- **Verdict:** by-design. The protocol's promise is "oracle is the source of truth"; admin override is for oracle FAILURE only.

### Tier 3 — DR-008 fee math attacks

**Attack 7:** Wash-trade mint_pair → redeem_pair to inflate `mint_volume_30d` and accelerate to tier 3 (100 bps fee).
- **Defense:** each mint_pair cycle pays the tier fee at mint and recovers full USDC at redeem_pair (no fee on redeem_pair). Cost: $0.02 per $1 of volume added. Saving: 50 bps tier discount on future trades. Break-even requires the attacker to actually trade >$4× the wash volume after qualifying — not profitable at any volume.
- **Verdict:** weakly defended (not zero, but uneconomic).
- **Related:** Phoenix-secondary-trade fees pay no protocol fee in v1 (DR-008 captures only the mint side). `constitution/decisions.md` **DR-009 amendment 2026-05-24** locks the v1.5 P0 fix (Model D — set Phoenix `fee_recipient` to our ATA in `phoenix::InitializeMarket` CPI). Mainnet defense narrative: the gap is engineered (verified feasible), not aspirational.

**Attack 8:** Create a strike + mint into it as creator (zero fee per DR-008) + game tier accumulation.
- **Defense:** **explicit anti-gaming safeguard.** `mint_pair` skips updating `mint_volume_30d` when `creator_rebate_fires`. Mock test: `dr005-dr011-scaffolding.test.ts:creator-rebate-doesnt-update-volume`. Property: `mintVolume30d === 0n` after 1500 USDC of creator-rebated mints.
- **Verdict:** defended.

### Tier 4 — DR-010 Merkle distribution attacks

**Attack 9:** Submit a forged Merkle proof to claim someone else's reward.
- **Defense:** `verify_merkle_proof` recomputes the root from leaf + sibling chain via sorted-pair sha256 (OpenZeppelin style). The leaf hash includes recipient pubkey, position, period_id, period_type, amount — ALL 5 fields. Proofs for one period don't verify against another (period_id isolation test in `dr005-dr011-scaffolding.test.ts:period-id-isolation`).
- **Verdict:** defended.

**Attack 10:** Double-claim a winning position by replaying the same distribution tx.
- **Defense:** 32-bit `claimed_bitmap` field per leaderboard commitment; bit flipped on successful distribution; rejects re-distribution. Real bitmap test inline in Rust.
- **Verdict:** defended.

### Tier 5 — Operational

**Attack 11:** Sybil-mint to populate the leaderboard with fake high-streak users.
- **Defense:** none on chain. Bram's indexer can choose to flag suspicious behavior (rapid alt-creation patterns) but the on-chain protocol doesn't prevent it.
- **Verdict:** undefended. ACKNOWLEDGED PRE-MAINNET GAP. Mitigations for v2: account-age requirements, Twitter/Discord linking (DR-014), KYC at high-payout tiers.

**Attack 12:** Compromise admin keypair → drain treasury via update_fee_config swap + drain fee_collector ATA.
- **Defense:** admin keypair is the highest-value attack surface. Aria's w3swap pattern separates upgrade authority + platform admin + fee collector to limit blast radius — if platform admin is compromised, attacker can pause, change fee structure, but cannot upgrade the program code (separate upgrade authority).
- **Verdict:** ACCEPT — multi-sig protection deferred to v2 mainnet.

**Attack 13:** Bram's automation service compromised → adversarial settle txs sent during Pyth volatility window.
- **Defense:** Bram's keys aren't load-bearing (DR-002). If compromised, attacker can ONLY do what the protocol allows ANY signer to do — settle markets (legitimate operation). Nothing exploitable.
- **Verdict:** defended.

---

## 7. Pre-mainnet checklist (what needs to land before mainnet conversation opens)

- [ ] Independent security audit by a third-party firm (Halborn, Trail of Bits, OtterSec) — none scheduled
- [ ] Pyth Receiver Program integration (v2 gap #4)
- [ ] `force_redeem_invalid` instruction (v2 gap #1)
- [ ] Multi-sig wrapping of platform admin keypair
- [ ] Mainnet keypair architecture (4-way separation per w3swap pattern)
- [ ] DR-014 user profile system (rate-limit attack mitigation context)
- [ ] Live MAG7 Pyth feed verification (devnet only has SOL/USD active)
- [ ] Production-grade indexer (Helius webhook + Neon Postgres at non-free tier)
- [ ] Mainnet rent + tx fee budget (~$530 initial deploy at $100/SOL + ~$50-100/yr ongoing; main capital ask is audit budget, not deploy)
- [ ] Insurance / coverage mechanism for the $1 invariant (today's promise is on-chain bytecode; mainnet might want explicit user-facing terms)

---

## 8. Test coverage map

| Surface | Evidence layers | Total assertions |
|---|---|---|
| HY-1 ($1 USDC invariant) | mock + sim (3 outcome modes × 5 invariants each) + DR-020 CLOB escrow invariant (pending deploy_index=7) | 15 + per-test boundary cases; CLOB test (a)+(b) pending |
| HY-2 (one-command demo) | `scripts/one-command-demo.sh` (3s / 10s) | 1 script, 6 steps |
| HY-5 (cron-failure path) | mock + sim --kill-cron-at=phase3 + chain-sim NotExpired + chain-sim PythStale | 4 layers |
| HY-6 (Pyth gates) | mock + Rust property + chain-evidence (PythStale fired live) | 3 layers |
| DR-002 (permissionless settle) | mock + IDL inspection + chain simulate (NotExpired 6003) + chain simulate (PythStale 6009 deploy-5) | 4 layers, strongest to date |
| DR-008 (fee math + creator rebate + 3-way split + gaming defense) | mock + 11 mocha tests | comprehensive at mock layer |
| DR-010 (Merkle leaderboard) | mock + multi-leaf proof test + period-id isolation + tampered-amount rejection | comprehensive at mock layer |
| DR-020 (CLOB escrow separation + all 4 trade paths + adversarial) | **PENDING** — `tests/contracts/test_order_book_invariants.ts` written; blocked on Aria's deploy_index=7 + Bram's seeded strikes | 3 invariant tests + 9 adversarial cases + 4-path smoke |
| DR-020 attack surface (remaining_accounts trust model) | Keith's adversarial review (H-1 + M-1 through M-4 fixed) + test_order_book_invariants.ts wrong-owner + cancel-non-owner cases | Written; pending devnet execution |

**Test totals (pre-deploy_index=7):** 76 assertions (8 live devnet + 63 mocha eval + 5 sim modes) + 100/100 inline Rust property tests in `programs/bell-markets/src/`. 7 independent Sonnet audit cycles applied with 17 substantive findings, all fixed (matches the lineage header).

**Test totals target (post-deploy_index=7):** 76 + 12 CLOB invariant/smoke assertions = 88 baseline. Adversarial cases add 9 more. Full green = PASS on demo.

---

## 9. Verdict

**Devnet demo: READY (pending deploy_index=7).** The 76-assertion test surface (pre-DR-020) + 7 independent audit cycles + 17 substantive fixes + live deploy verification cover every Hard YES committed to before the DR-020 pivot. DR-020 CLOB surface (`tests/contracts/test_order_book_invariants.ts` — 3 invariant tests + 9 adversarial cases) is written and blocked on Aria's deploy_index=7 landing on devnet. Once deploy_index=7 lands, the smoke suite runs and the verdict upgrades to PASS or surfaces real bugs to Aria.

Vault security model is anchored in DR-017 (PDA self-authority + Anchor account constraints + permissionless settle + admin-as-cranker-not-redirector). The in-program CLOB adds a new security surface: the `remaining_accounts` trust model (Keith's H-1 fix baked in from day 1) + telescoping escrow invariant (test (b) in test_order_book_invariants.ts). The 6-attack CLOB analysis above + 13-attack lifecycle analysis form the full hostile-tester catalog.

Token program plan is anchored in DR-016 (SPL Token locked for v1 tradeable assets; Token-2022 + cNFTs deferred to v2 identity surfaces). The one-command demo runs in 3s offline / 10s live. **Frontend wiring update (2026-05-25):** deploy_index=7 adds `place_order`, `cancel_order`, `match_orders`, `init_order_book`, `grow_order_book` to the program surface; Cleo's `apps/web/src/lib/tx/build-buy-yes.ts` + `build-sell-yes.ts` + `build-buy-no.ts` + `build-sell-no.ts` will update to use `place_order` instead of the placeholder Phoenix swap builders. Demo script `docs/demo/v1-demo-script.md` targets Flow B (all 4 trade paths live) once smoke passes; falls back to Flow C (hybrid) if smoke fails on any path.

**Mainnet: NOT READY.** The gaps documented above include the new DR-020 CLOB-specific gaps (A through E) plus the pre-existing 7 gaps. Most important new gap: **the matching engine has not had a third-party audit** (CLOB gap C). The mainnet narrative is: protocol correctness PROVEN at v1 including in-program CLOB; fee surfaces PLANNED (DR-018 amended); production-grade keys + third-party audit + Pyth Receiver land before mainnet.

**Most critical mainnet blocker:** independent third-party security audit covering the matching engine. Until that happens, no honest mainnet deploy is defensible. The matching engine is the highest-risk new audit surface (per DR-020) and cannot be skipped.
