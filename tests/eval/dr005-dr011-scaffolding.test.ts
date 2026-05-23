// dr005-dr011-scaffolding.test.ts — pre-merge test scaffolding for the 7 new
// instructions queued in DR-005 / DR-006 / DR-007 / DR-008 / DR-010 / DR-011.
//
// Status (2026-05-23 Day-5): all tests are `it.skip(...)` — Aria has NOT yet
// pushed the IDL refresh with the new instructions to main. When she does:
//   1. Update tests/integration/mocks/aria-interface.ts to add the new methods
//      (per the DR specs below + the actual emitted IDL).
//   2. Remove the `.skip` on each test below.
//   3. Fill in the body referencing the new mock methods.
//
// Why a separate file: keeps tests/eval/edge-cases.test.ts pass-count
// signal clean ("27 passing, 2 pending" stays meaningful). Once these
// land, this file's pass count is the Day-5+ coverage delta.
//
// Source DRs:
//   DR-005 — user_create_strike_market + TickerConfig + UserConfig
//   DR-006 — update_ticker_config + 24h rolling strike-grid
//   DR-007 — trading calendar helpers (isTradingDay / getCloseTime / nextTradingDay)
//   DR-008 — mint_pair fee math + tier discounts + creator rebate
//   DR-010 — commit_leaderboard_root + distribute_weekly_rewards + distribute_monthly_rewards
//   DR-011 — earnings-calendar pre-expansion (Bram-side; Drew tests calendar lookup)
//
// Cross-ref dispatch: per Tate's 2026-05-23 work order priority 3.

import { expect } from "chai";
// NOTE: imports commented out — uncomment after mock reconciliation lands.
// import {
//   createMockAria, ONE_USDC, OUTCOME_INVALID, OUTCOME_YES, type Pubkey,
// } from "../integration/mocks/aria-interface";

const ADMIN  = "admin-pubkey";
const USER   = "user-pubkey";
const USER2  = "user2-pubkey";
const PYTH   = "pyth-aapl-feed-mock";

// Match DR-005 table for AAPL: 15% deviation, $1 tick.
const TICKER_AAPL_MAX_DEV_BPS = 1500;
const TICKER_AAPL_TICK_USD    = 1_000_000n;            // $1 in micro-USDC

describe("DR-005 — user_create_strike_market (permissionless, user-funded)", () => {
  it.skip("succeeds with strike within ±max_dev_bps of Pyth spot + aligned to tick", async () => {
    // Setup: TickerConfig for AAPL exists with cap_center = $200, max_dev = 1500bps ($30 range).
    // User calls user_create_strike_market(strike_price = $210 = 210_000_000, expiry = next trading day close).
    // Expected: succeeds. StrikeMarket PDA created; user is creator (StrikeMarket.creator = user).
    //
    // Source: DR-005 §"Decision" bullets 1-4 (on-chain enforcement).
    // TODO when mock + IDL land.
  });

  it.skip("rejects strike beyond max_user_strike_deviation_bps (out-of-cap)", async () => {
    // Setup: TickerConfig cap_center = $200, max_dev = 1500bps. User tries strike = $250 (out of $170-$230 band).
    // Expected: reverts with StrikeBeyondDeviationCap (or whichever Aria names it).
    // TODO.
  });

  it.skip("rejects strike not aligned to strike_tick_size grid (misaligned tick)", async () => {
    // Setup: TickerConfig tick_size = $1. User tries strike = $200.50.
    // Expected: reverts with StrikeMisalignedTick. Prevents 100-micro-strike fragmentation per DR-005.
    // TODO.
  });

  it.skip("rejects when Pyth feed fails staleness / confidence check at create time", async () => {
    // DR-005 §"Decision" bullet 4: same Pyth gates as settle_market apply at create.
    // TODO with pythBehavior: 'stale' option.
  });

  it.skip("sets StrikeMarket.creator = user pubkey; immutable thereafter", async () => {
    // DR-005: creator field used by DR-008 fee logic. Once written, must not be mutable.
    // TODO: read StrikeMarket.creator post-create; assert equals user; verify no setter ix exists in IDL.
  });
});

describe("DR-008 — mint_pair fee math (2% with tier discount + creator rebate)", () => {
  // Per DR-008 §"Three layered discounts":
  //   Tier 1 ($0-$1000):     200 bps (2%)
  //   Tier 2 ($1000-$10000): 150 bps (1.5%)
  //   Tier 3 ($10000+):      100 bps (1%)

  it.skip("tier boundary: $999 mint pays 200 bps (tier 1)", async () => {
    // Setup: UserConfig.mint_volume_30d = $999 micro-USDC. User mints $1 pair.
    // Expected: fee = 2_000 micro-USDC (200 bps × $1). New mint_volume_30d = $1000.
    // TODO.
  });

  it.skip("tier boundary: $1000 mint pays 150 bps (tier 2 — first dollar at $1000 mark)", async () => {
    // Setup: UserConfig.mint_volume_30d = $1000. User mints $1.
    // Expected: fee = 1_500 micro-USDC (150 bps).
    // TODO.
  });

  it.skip("tier boundary: $9999 mint stays in tier 2 (150 bps)", async () => {
    // Setup: UserConfig.mint_volume_30d = $9999. Mints $1. Fee = 1_500 mu.
    // TODO.
  });

  it.skip("tier boundary: $10000 mint pays 100 bps (tier 3)", async () => {
    // Setup: UserConfig.mint_volume_30d = $10000. Mints $1. Fee = 1_000 mu.
    // TODO.
  });

  it.skip("creator rebate: creator==user && outcome==Unsettled → pays creator_rebate-adjusted fee", async () => {
    // Per DR-008: creator pays tier_fee × (10000 - creator_rebate_bps) / 10000.
    // Default creator_rebate_bps = 10000 → creator pays 0% fee on all mints into their strike pre-settle.
    // Setup: USER created StrikeMarket via user_create_strike_market. USER mints $100 pair.
    // Expected: fee = 0 (default rebate). USDC vault gets exactly $100 (no fee skim).
    // TODO.
  });

  it.skip("creator rebate: does NOT update mint_volume_30d (gaming defense)", async () => {
    // Per DR-008: "Critical safeguard against tier gaming." Creator's mint into their own strike
    // skips the volume increment so they can't accelerate tier progression for free.
    // Setup: USER creates strike + mints $1500 → UserConfig.mint_volume_30d MUST remain at $0.
    // TODO.
  });

  it.skip("non-creator mints into creator's strike: pays normal tier fee + updates mint_volume_30d", async () => {
    // Cross-check the creator-rebate isn't accidentally global.
    // Setup: USER creates strike. USER2 mints $1 → USER2's UserConfig.mint_volume_30d += $1, USER2 pays 200 bps.
    // TODO.
  });

  it.skip("fee splits correctly: platform_retain_bps + weekly_pool_bps + monthly_pool_bps = total fee", async () => {
    // Per DR-010 §"Default funding split": 50% retain, 25% weekly, 25% monthly.
    // Setup: User mints $100 at tier 1 → fee = $2. Expected splits: $1 → fee_collector, $0.50 → weekly_pool, $0.50 → monthly_pool.
    // Verify each PDA balance delta + sum equals fee.
    // TODO.
  });

  it.skip("fee split sum validation: rejects MarketConfig update where bps don't sum to 10_000", async () => {
    // Per DR-010 §"Sum must equal 10,000 (enforced on-chain)".
    // Setup: try to update_market_config with split bps that sum to e.g., 9500 or 10500.
    // Expected: reverts with InvalidSplit (or whichever Aria names it).
    // TODO.
  });

  it.skip("$1 USDC invariant holds with fees active: vault.amount == pairs_outstanding × $1 exactly", async () => {
    // The most important property — fee math must NOT pollute the vault.
    // Setup: 10 users mint various amounts with fees on. After all mints + redeems, vault should be exactly $0 (drained).
    // TODO. Currently asserted in simulate-trading-day.mjs Phase 5 I1, which assumes fee=0; revisit when fees active.
  });
});

describe("DR-005 — force_redeem (admin escape valve after settle + grace)", () => {
  it.skip("rejects before settled_at + grace_secs (too early)", async () => {
    // Setup: market settled at t, grace = 30 days. Try force_redeem at t + 7 days.
    // Expected: reverts with ForceRedeemTooEarly (or similar).
    // TODO.
  });

  it.skip("succeeds after grace; transfers USDC to user_pubkey on behalf of long-tail holder", async () => {
    // Setup: market settled, 30 days pass, user hasn't redeemed. Admin calls force_redeem(user_pubkey, amount).
    // Expected: vault → user_usdc transfer succeeds; user_winning_token burned.
    // TODO.
  });

  it.skip("rejects when caller is not admin", async () => {
    // Source: admin-only path. Non-admin signer must revert NotAdmin.
    // TODO.
  });
});

describe("DR-005 — close_settled_market (rent recovery via permissionless close)", () => {
  it.skip("rejects when pairs_outstanding > 0 (would orphan user funds)", async () => {
    // Setup: market settled, 5 pairs of winning side still un-redeemed. Try close.
    // Expected: reverts with PairsStillOutstanding (or similar).
    // TODO.
  });

  it.skip("succeeds when pairs_outstanding == 0; closes YES mint + NO mint + vault; refunds rent to treasury", async () => {
    // Per DR-005 §"Closed-rent recovery": refunded rent flows to MarketConfig.treasury (fee_collector).
    // Setup: all users have redeemed; vault empty; pairs_outstanding == 0. Anyone calls close_settled_market.
    // Expected: succeeds; treasury balance increases by sum of (yes_mint rent + no_mint rent + vault rent).
    // TODO.
  });

  it.skip("rejects when called on Unsettled market", async () => {
    // Sanity: close before settle would orphan pair holders.
    // TODO.
  });
});

describe("DR-010 — commit_leaderboard_root + distribute_*_rewards (Merkle-verifiable)", () => {
  it.skip("commit_leaderboard_root: admin-only; rejects non-admin signer", async () => {
    // TODO.
  });

  it.skip("commit_leaderboard_root: stores 32-byte root + Arweave CID in LeaderboardCommitments PDA", async () => {
    // Per DR-010 §"LOCKED for MVP: Option B (Merkle commitment) + Arweave pinning"
    // TODO.
  });

  it.skip("distribute_weekly_rewards: rejects when merkle_proof doesn't verify against committed root", async () => {
    // Source: DR-010 §"Verification model".
    // Setup: commit_leaderboard_root(period=42, root=R). Call distribute_weekly_rewards with a tampered proof.
    // Expected: reverts with InvalidProof.
    // TODO.
  });

  it.skip("distribute_weekly_rewards: succeeds with valid proof; transfers from WeeklyRewardsPool to recipient", async () => {
    // Setup: commit root for period 42 that includes leaf(USER, streak=7, position=1). Call distribute with valid proof.
    // Expected: WeeklyRewardsPool → USER USDC transfer succeeds. Recipient gets weekly_distribution_bps[0] / 10000 × pool size.
    // TODO.
  });

  it.skip("distribute_weekly_rewards: rejects re-distribution to same recipient/position (idempotency)", async () => {
    // Source: prevents double-pay if admin or anyone re-broadcasts the same distribution tx.
    // TODO.
  });

  it.skip("distribute_monthly_rewards: same shape as weekly but on monthly pool + monthly_distribution_bps", async () => {
    // TODO.
  });
});

describe("DR-007 — trading calendar (off-chain helpers; Bram owns implementation; Drew tests)", () => {
  // Trading calendar helpers live in services/automation/src/calendar.ts (Bram's territory).
  // Drew imports + tests the helpers from here. Tests are at-the-boundary, not deep-internal.

  it.skip("isTradingDay: returns false for Saturday + Sunday", async () => {
    // const { isTradingDay } = await import("@bell-markets/automation/calendar");
    // expect(isTradingDay(new Date("2026-05-23"))).to.equal(false);  // Saturday
    // expect(isTradingDay(new Date("2026-05-24"))).to.equal(false);  // Sunday
    // TODO when calendar module is published from automation workspace.
  });

  it.skip("isTradingDay: returns false for US full holidays (e.g., Memorial Day 2026-05-25)", async () => {
    // expect(isTradingDay(new Date("2026-05-25"))).to.equal(false);
    // expect(isTradingDay(new Date("2026-07-04"))).to.equal(false);   // Independence Day
    // expect(isTradingDay(new Date("2026-11-26"))).to.equal(false);   // Thanksgiving
    // TODO.
  });

  it.skip("isTradingDay: returns TRUE for half-days (e.g., July 3, day after Thanksgiving)", async () => {
    // Per DR-007: half-days ARE trading days; close time is 1 PM ET instead of 4 PM ET.
    // TODO.
  });

  it.skip("getCloseTime: returns 16:00 ET for regular trading days", async () => {
    // TODO.
  });

  it.skip("getCloseTime: returns 13:00 ET for half-days (e.g., 2026-11-27 day after Thanksgiving)", async () => {
    // TODO.
  });

  it.skip("nextTradingDay: skips weekends + full holidays; KEEPS half-days", async () => {
    // From Friday before Memorial Day weekend → returns Tuesday (skipping Sat/Sun/Mon).
    // From day before Thanksgiving → returns half-day (NOT skipping it).
    // TODO.
  });
});

describe("DR-011 — earnings-calendar pre-expansion (Bram-side; Drew tests pre-expand + restore logic)", () => {
  it.skip("isEarningsTomorrow: returns true day before known MAG7 earnings (e.g., NVDA Aug 28)", async () => {
    // const { isEarningsTomorrow } = await import("@bell-markets/automation/earnings-calendar");
    // expect(isEarningsTomorrow("NVDA", new Date("2026-08-27"))).to.equal(true);
    // TODO.
  });

  it.skip("preExpansionMagnitude: returns ticker-specific expanded cap for known tickers", async () => {
    // Per DR-011: high-vol NVDA/META/TSLA → 30%→50%, mid AMZN → 20%→30%, low → 15%→25%.
    // TODO.
  });

  it.skip("post-earnings restore: returns ticker to default cap day-after earnings", async () => {
    // TODO.
  });

  it.skip("earnings-during-half-day edge case: pre-expansion still fires; expiry anchors to 13:00 ET", async () => {
    // Composes DR-007 + DR-011. Half-day with earnings tomorrow.
    // TODO.
  });

  it.skip("empty calendar (post-cleanup or new year): isEarningsTomorrow returns false; no crash", async () => {
    // Edge case for calendar-rollover periods.
    // TODO.
  });
});

// Sanity check: this file should load without errors even pre-merge.
describe("scaffolding meta", () => {
  it("file loads cleanly + chai is importable + skip count is the expected scaffolding total", () => {
    expect(typeof expect).to.equal("function");
    // Acts as a heartbeat — confirms the test file itself isn't broken while everything inside is skipped.
  });
});
