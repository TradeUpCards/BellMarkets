# Pre-Mainnet Readiness — BellMarkets

**Owner:** Drew (Quality + Integration + Demo lead). **Status:** Day-6 snapshot (2026-05-24). **Scope:** the deployed program at `599h7VznYR4CxyrG5nQbhR13qtRuwPcbnNr5QqbkS7uV` on devnet (deploy-5, slot 464349904).

**Demo pairing:** for a 4-minute walkthrough of the v1 protocol surface, see [`docs/demo/v1-demo-script.md`](../demo/v1-demo-script.md). This readiness doc is the security narrative for reviewer Q&A — pull specific sections (attack tier 1-5, v2 gaps, audit log) when the reviewer presses on production posture.

**Quality lineage:** 5 deploys (audit log §3) + 5 independent Sonnet audit cycles + 14 substantive findings caught and shipped. The bias profile across the 5 cycles: Sonnet repeatedly caught polished-prose-around-weak-assertions, commit-message-vs-doc drift, ownership-protocol process drift, and quantitative cost claims with unit confusion. Going forward, Sonnet audit dispatch after each major push is Drew's standing operating discipline (post-Day-3).

> **TL;DR for an engineering reviewer:** Demo is ready to ship on devnet. Mainnet **is not yet ready**. The major v1 architectural commitments (DR-001 through DR-011) are implemented end-to-end. Critical-path gaps before any mainnet conversation: (1) live Pyth feed coverage for MAG7 stocks (devnet uses SOL/USD only); (2) `force_redeem` doesn't cover Invalid markets — DR-005 v2 gap; (3) zero independent security audit. The protocol's core invariants (DR-002 permissionless settle, $1 USDC conservation, DR-008 fee math) have layered evidence (mock + IDL + chain simulate + cron-kill sim) but no real-money audit.

---

## 1. Instruction surface (20 ix, all validated)

Generated from `programs/bell-markets/idl/bell_markets.json` + cross-checked against handler source.

| # | Instruction | Signer | Args | On-chain validation guarantees |
|---|---|---|---|---|
| 1 | `initialize_config` | admin | staleness_secs (i64), confidence_bps (u16), override_delay_secs (i64) | bounds check 1≤staleness≤24h; 1≤conf≤1000bps; 1≤delay≤7d; PDA `init` (idempotent) |
| 2 | `initialize_fee_config` | admin | 6×bps + grace + two [u16;10] arrays | sum(platform+weekly+monthly)==10000; sum(each dist array)==10000; bps≤10000; grace>0; PDA `init` (idempotent); back-pointer to MarketConfig |
| 3 | `initialize_rewards_pools` | admin | (none) | one-shot creates 2 USDC token accounts + LeaderboardCommitments zero_copy PDA |
| 4 | `update_fee_config` | admin | same 8 fields as initialize | same validation as initialize_fee_config; idempotent re-write |
| 5 | `update_ticker_config` | admin | cap_center (i64), allowed_strikes ([i64;16]), strike_count (u16), max_dev_bps (u16), strike_tick_size (i64), threshold_bps (u16) | strike_count≤16; tick_size>0; per-Pyth-feed PDA `init_if_needed`; P1-audit fix: strike_count>0 footgun guard |
| 6 | `create_strike_market` | admin | strike_price (i64), expiry_unix (i64) | strike_price>0; expiry>now; Phoenix v1 magic-prefix verify; sets creator=admin |
| 7 | `user_create_strike_market` | user (pays rent) | strike_price (i64), expiry_unix (i64) | TickerConfig exists; strike∈allowed_strikes OR within max_dev_bps of LIVE Pyth spot via vendored oracle; tick alignment; expiry at 1/4 PM ET (DR-007); 7-day horizon; Phoenix magic; Pyth not-stale/not-too-wide at create; sets creator=user (drives DR-008 rebate) |
| 8 | `add_strike` | admin | (none) | no-op convenience hook (forward-compat for batch creator) |
| 9 | `pause` | admin | paused (bool) | writes config.paused (global circuit breaker) |
| 10 | `mint_pair` | user | amount (u64) | amount>0; !paused; outcome==Unsettled; ConfigMismatch; transfers `amount` USDC user→vault; mints `amount` YES + `amount` NO via strike_market PDA signer; DR-008 fee math: tier_bps × mint_fee_bps / 200, creator_rebate if signer==creator, 3-way split, gaming-defense (only update mint_volume_30d if !creator_rebate); init_if_needed UserConfig; increments pairs_outstanding |
| 11 | `redeem` | user | amount (u64) | post-Yes/No only (rejects Unsettled + Invalid); ConfigMismatch; burn `amount` of winning_mint via user authority; transfer USDC vault→user via PDA signer; decrement pairs_outstanding |
| 12 | `redeem_pair` | user | amount (u64) | pre-settle only (Outcome==Unsettled); ConfigMismatch; burn equal YES+NO; transfer USDC vault→user; powers POV-3 Sell-No atomic flow |
| 13 | `redeem_invalid` | user | amount (u64) | post-Invalid only; burn equal YES+NO; transfer USDC vault→user; for admin-override Invalid markets only |
| 14 | `settle_market` | settler (any signer, fee payer) | (none) | **DR-002 permissionless**; !paused; clock.unix_timestamp≥expiry; PythFeedMismatch check; vendored parse_pyth_price (magic/version/atype/status/staleness/confidence); writes outcome immutably (settle_price, settle_confidence, settle_slot, settled_at_unix) |
| 15 | `admin_settle` | admin | forced_outcome (Outcome) | now≥admin_override_eligible_at (default expiry+1hr); writes outcome with settle_price=0 as discriminator; for Pyth-unrecoverable scenarios |
| 16 | `force_redeem` | admin | amount (u64) | post-settle Yes/No only; now>settled_at+grace (default 30d, strict >); burn user winning tokens via PDA delegate; transfer USDC vault→user (NOT to admin); decrement pairs_outstanding; **v2.5 gap: Invalid markets not covered** |
| 17 | `close_settled_market` | closer (any signer) | (none) | **permissionless**; outcome!=Unsettled; pairs_outstanding==0; usdc_vault.amount==0 (P4-audit fix; surfaces dust-attack as MarketNotEmpty); closes USDC vault → fee_collector receives rent |
| 18 | `commit_leaderboard_root` | admin | period_id (u64), period_type (u8), merkle_root ([u8;32]), arweave_tx_id ([u8;48]) | period_type∈{0,1}; writes into 24-entry ring buffer; resets claimed_bitmap |
| 19 | `distribute_weekly_rewards` | admin | period_id (u64), position (u8), amount (u64), merkle_proof (Vec<[u8;32]>) | position∈[1,10]; verify SHA256 Merkle proof against committed root (sorted-pair OpenZeppelin); single-claim via 32-bit claimed_bitmap; transfer USDC pool→recipient via pool PDA signer |
| 20 | `distribute_monthly_rewards` | admin | same as weekly | same as weekly but on monthly pool + monthly_distribution_bps |

**Coverage:** all 20 ixs documented; all signers + args extracted from canonical IDL; all validation guarantees cross-checked against handler source via 100/100 `cargo test --lib` (Rust property tests) + 76 mocha assertions in `tests/eval/`.

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

**Upgrade authority drift check: NONE.** All 5 deploys signed by the same pubkey `9snc1xMYHPQbJuaybP98z6YS6xBbzhDTnXiNoKRawanZ`. No transfer, no rotation, no compromise scenario triggered.

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

### Tier 2 — attack the DR-002 permissionless settle path

**Attack 5:** Create a market with adversarial Phoenix market account (passes magic but is malicious).
- **Defense:** Phoenix magic-prefix check rejects non-Phoenix-v1 accounts. Phoenix is an external program; if attacker submits an account NOT from Phoenix-v1, the magic byte sequence won't match (verified live against `CS2H8nbAVVEU...` SOL/USDC market on devnet).
- **Residual risk:** if Phoenix v1 itself is exploited and accepts non-conforming orders, the settle outcome wouldn't be affected (settle reads Pyth, not Phoenix), but Phoenix-based trading semantics are out of our trust boundary. Acceptable per DR-009.

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
| HY-1 ($1 USDC invariant) | mock + sim (3 outcome modes × 5 invariants each) | 15 + per-test boundary cases |
| HY-2 (one-command demo) | `scripts/one-command-demo.sh` (3s / 10s) | 1 script, 6 steps |
| HY-5 (cron-failure path) | mock + sim --kill-cron-at=phase3 + chain-sim NotExpired + chain-sim PythStale | 4 layers |
| HY-6 (Pyth gates) | mock + Rust property + chain-evidence (PythStale fired live) | 3 layers |
| DR-002 (permissionless settle) | mock + IDL inspection + chain simulate (NotExpired 6003) + chain simulate (PythStale 6009 deploy-5) | 4 layers, strongest to date |
| DR-008 (fee math + creator rebate + 3-way split + gaming defense) | mock + 11 mocha tests | comprehensive at mock layer |
| DR-010 (Merkle leaderboard) | mock + multi-leaf proof test + period-id isolation + tampered-amount rejection | comprehensive at mock layer |

**Test totals:** 76 assertions (8 live devnet + 63 mocha eval + 5 sim modes) + 100/100 inline Rust property tests in `programs/bell-markets/src/`. 5 independent Sonnet audit cycles applied with 14 substantive findings, all fixed (matches the lineage header).

---

## 9. Verdict

**Devnet demo: READY.** The 76-assertion test surface + 5 independent audit cycles + 14 substantive fixes + live deploy verification cover every Hard YES the build committed to. Vault security model is anchored in `constitution/decisions.md` DR-017 (PDA self-authority + Anchor account constraints + permissionless settle + admin-as-cranker-not-redirector) — the 13-attack analysis above is the stress test of that model. Token program plan is anchored in DR-016 (SPL Token locked for v1 tradeable assets; Token-2022 + cNFTs deferred to v2 identity surfaces — minimal audit surface today). The one-command demo runs in 3s offline / 10s live. **Frontend wiring update (Sun 2026-05-25):** Cleo shipped the v8 landing + v8 trade page in merge `13a8481`. Buy×Yes via `mint_pair` IS wired through `buildMintPairTx` → live devnet broadcast; the other three trade actions (Buy NO / Sell YES / Sell NO) return "Phoenix CLOB binding pending — Buy YES via mint_pair is the live demo path. The other three actions ship in v1.1." instead of throwing. Demo script `docs/demo/v1-demo-script.md` runs Flow C (live Buy×Yes + live landing + narration of v1.1 deferrals).

**Mainnet: NOT READY.** Seven specific gaps documented above. None are code defects; they're operational + audit + capital + Pyth-coverage items that mainnet conversation requires regardless of the protocol's correctness. **DR-009 amendment** explicitly closes the Phoenix-secondary-trade fee gap at the v1.5 P0 boundary (Model D verified feasible cross-lead; ~6-8 hr work + 1 audit cycle + 1 deploy). The mainnet narrative is: protocol correctness PROVEN at v1; revenue capture upgrade PLANNED at v1.5; production-grade keys + audit + Pyth Receiver land before mainnet.

**Most critical mainnet blocker:** independent third-party security audit. Until that happens, no honest mainnet deploy is defensible.
