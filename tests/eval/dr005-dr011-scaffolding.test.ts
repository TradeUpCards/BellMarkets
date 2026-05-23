// dr005-dr011-scaffolding.test.ts — coverage for the 10 new instructions Aria
// shipped in the Day-5 merge (DR-005 / DR-006 / DR-008 / DR-010 / DR-011).
//
// Status (2026-05-23 Day-5 post-merge): 27 mock-side tests ACTIVE.
// 11 Bram-side tests (DR-007 trading calendar + DR-011 earnings calendar)
// remain `it.skip` because their helpers live in `services/automation/`
// (Bram's territory) and aren't yet exported as importable modules from
// his workspace. When Bram publishes calendar.ts + earnings-calendar.ts,
// flip the skip on each and fill in the import.
//
// Source DRs:
//   DR-005 — user_create_strike_market + TickerConfig + UserConfig + force_redeem + close_settled_market
//   DR-006 — update_ticker_config + 24h rolling strike-grid
//   DR-007 — trading calendar helpers (Bram-side)
//   DR-008 — mint_pair fee math + tier discounts + creator rebate + initialize_fee_config + update_fee_config
//   DR-010 — commit_leaderboard_root + distribute_weekly_rewards + distribute_monthly_rewards + Merkle verify
//   DR-011 — earnings-calendar pre-expansion (Bram-side)

import { expect } from "chai";
import { createHash } from "node:crypto";
import {
  createMockAria, ONE_USDC, OUTCOME_INVALID, OUTCOME_YES,
  DEFAULT_FEE_CONFIG, type Pubkey, type MockState, type AriaProgram,
} from "../integration/mocks/aria-interface";

const ADMIN  = "admin-pubkey";
const USER   = "user-pubkey";
const USER2  = "user2-pubkey";
const PYTH   = "pyth-aapl-feed-mock";
const PHOENIX = "phoenix-aapl-fifo-market-mock";
const USDC_MINT = "usdc-mint-mock";
const TREASURY  = "treasury-mock";

const DEFAULT_INIT = {
  admin: ADMIN, usdcMint: USDC_MINT, treasury: TREASURY,
  priceStalenessSecs: 300n, priceConfidenceBps: 50, adminOverrideDelaySecs: 3600n,
};

// AAPL-tuned per DR-005 §"Decision" table.
const AAPL_MAX_DEV_BPS = 1500;          // 15%
const AAPL_TICK = ONE_USDC;             // $1 micro-USDC
const AAPL_SPOT = 200_000_000n;         // $200

/** Setup: init config, set TickerConfig for AAPL (centered at $200, 15% dev, $1 tick). */
async function setupWithTickerConfig(opts: Parameters<typeof createMockAria>[0] = {}): Promise<{ program: AriaProgram; state: MockState }> {
  const { program, state } = createMockAria(opts);
  state.blockTime = 1_000_000n;
  state.slot = 250_000_000n;
  await program.initializeConfig(DEFAULT_INIT);
  await program.updateTickerConfig({
    admin: ADMIN, pythFeed: PYTH,
    capCenter: AAPL_SPOT,
    maxUserStrikeDeviationBps: AAPL_MAX_DEV_BPS,
    strikeTickSize: AAPL_TICK,
    thresholdBps: 400,
  });
  return { program, state };
}

// ─── DR-005 — user_create_strike_market (permissionless, user-funded) ────

describe("DR-005 — user_create_strike_market (permissionless, user-funded)", () => {
  it("succeeds with strike within ±max_dev_bps of Pyth spot + aligned to tick", async () => {
    const { program } = await setupWithTickerConfig();
    const STRIKE = 210_000_000n;        // $210 — within $30 band of $200 spot
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: STRIKE,
      expiryUnix: 1_001_000n, phoenixMarket: PHOENIX,
    });
    expect(res.signature).to.match(/^mock-/);
    const m = await program.fetchStrikeMarket(res.marketId);
    expect(m.creator).to.equal(USER);   // DR-005 + DR-008: creator field for rebate logic
    expect(m.strikePrice).to.equal(STRIKE);
  });

  it("rejects strike beyond max_user_strike_deviation_bps (out-of-cap)", async () => {
    const { program } = await setupWithTickerConfig();
    const STRIKE = 250_000_000n;        // $250 — outside $170-$230 band (capCenter ± 15%)
    try {
      await program.userCreateStrikeMarket({
        user: USER, underlyingPythFeed: PYTH, strikePrice: STRIKE,
        expiryUnix: 1_001_000n, phoenixMarket: PHOENIX,
      });
      expect.fail("expected StrikeBeyondDeviationCap");
    } catch (e) {
      expect((e as Error).message).to.match(/StrikeBeyondDeviationCap/);
    }
  });

  it("rejects strike not aligned to strike_tick_size grid (misaligned tick)", async () => {
    const { program } = await setupWithTickerConfig();
    const STRIKE = 200_500_000n;        // $200.50 — not aligned to $1 tick
    try {
      await program.userCreateStrikeMarket({
        user: USER, underlyingPythFeed: PYTH, strikePrice: STRIKE,
        expiryUnix: 1_001_000n, phoenixMarket: PHOENIX,
      });
      expect.fail("expected StrikeMisalignedTick");
    } catch (e) {
      expect((e as Error).message).to.match(/StrikeMisalignedTick/);
    }
  });

  it("rejects when Pyth feed fails staleness check at create time", async () => {
    const { program } = await setupWithTickerConfig({ pythBehavior: "stale" });
    try {
      await program.userCreateStrikeMarket({
        user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
        expiryUnix: 1_001_000n, phoenixMarket: PHOENIX,
      });
      expect.fail("expected PythStale");
    } catch (e) {
      expect((e as Error).message).to.match(/PythStale/);
    }
  });

  it("sets StrikeMarket.creator = user pubkey (DR-008 fee logic depends on this)", async () => {
    const { program } = await setupWithTickerConfig();
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: 1_001_000n, phoenixMarket: PHOENIX,
    });
    const m = await program.fetchStrikeMarket(res.marketId);
    expect(m.creator).to.equal(USER);
    // No setter ix exists for creator — verified by absence in AriaProgram interface.
  });
});

// ─── DR-008 — mint_pair fee math (2% with tier discount + creator rebate) ─

describe("DR-008 — mint_pair fee math", () => {
  /** Setup with active fee config (2% mint fee, default split + rebate). */
  async function setupWithFeeActive(): Promise<{ program: AriaProgram; state: MockState; marketId: Pubkey }> {
    const { program, state } = await setupWithTickerConfig();
    await program.initializeFeeConfig({
      admin: ADMIN,
      mintFeeBps: 200,        // 2% — enable the fee mechanism
      // other fields stay defaults
    });
    const res = await program.userCreateStrikeMarket({
      user: ADMIN, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: 1_001_000n, phoenixMarket: PHOENIX,
    });
    return { program, state, marketId: res.marketId };
  }

  it("tier 1 ($0-$999): pays 200 bps", async () => {
    const { program, marketId } = await setupWithFeeActive();
    // USER has $0 mint_volume_30d → tier 1
    await program.mintPair({ user: USER, marketId, amount: 999n * ONE_USDC });
    const pools = await program.fetchPoolBalances();
    // Fee = 999 × 0.02 = 19.98 USDC. Default split 50/25/25.
    const fee = (999n * ONE_USDC * 200n) / 10_000n;
    expect(pools.feeCollector + pools.weekly + pools.monthly).to.equal(fee);
    const userCfg = await program.fetchUserConfig(USER);
    expect(userCfg.mintVolume30d).to.equal(999n * ONE_USDC);
  });

  it("tier boundary: at $1000 mint_volume_30d, NEXT mint pays 150 bps (tier 2)", async () => {
    const { program, marketId } = await setupWithFeeActive();
    // Build to exactly $1000 first
    await program.mintPair({ user: USER, marketId, amount: 1000n * ONE_USDC });
    const beforeFee = (await program.fetchPoolBalances());
    const beforeTotal = beforeFee.feeCollector + beforeFee.weekly + beforeFee.monthly;
    // Now mint $1 more — should be at tier 2 (150 bps)
    await program.mintPair({ user: USER, marketId, amount: 1n * ONE_USDC });
    const afterFee = (await program.fetchPoolBalances());
    const afterDelta = (afterFee.feeCollector + afterFee.weekly + afterFee.monthly) - beforeTotal;
    expect(afterDelta).to.equal((1n * ONE_USDC * 150n) / 10_000n);
  });

  it("tier 2 ($1000-$9999): pays 150 bps", async () => {
    const { program, marketId } = await setupWithFeeActive();
    await program.mintPair({ user: USER, marketId, amount: 5000n * ONE_USDC });
    const before = await program.fetchPoolBalances();
    const beforeTotal = before.feeCollector + before.weekly + before.monthly;
    await program.mintPair({ user: USER, marketId, amount: 100n * ONE_USDC });
    const after = await program.fetchPoolBalances();
    const delta = (after.feeCollector + after.weekly + after.monthly) - beforeTotal;
    expect(delta).to.equal((100n * ONE_USDC * 150n) / 10_000n);
  });

  it("tier 3 ($10000+): pays 100 bps", async () => {
    const { program, marketId } = await setupWithFeeActive();
    await program.mintPair({ user: USER, marketId, amount: 10_000n * ONE_USDC });
    const before = await program.fetchPoolBalances();
    const beforeTotal = before.feeCollector + before.weekly + before.monthly;
    await program.mintPair({ user: USER, marketId, amount: 100n * ONE_USDC });
    const after = await program.fetchPoolBalances();
    const delta = (after.feeCollector + after.weekly + after.monthly) - beforeTotal;
    expect(delta).to.equal((100n * ONE_USDC * 100n) / 10_000n);
  });

  it("creator rebate: creator==user && Unsettled → effective fee is 0 (default 100% rebate)", async () => {
    const { program, marketId } = await setupWithFeeActive();
    // Market was created by ADMIN above. Now ADMIN mints → creator rebate fires.
    const before = await program.fetchPoolBalances();
    await program.mintPair({ user: ADMIN, marketId, amount: 100n * ONE_USDC });
    const after = await program.fetchPoolBalances();
    // Default creator_rebate_bps = 10000 → creator pays 0%
    expect(after.feeCollector + after.weekly + after.monthly).to.equal(before.feeCollector + before.weekly + before.monthly);
  });

  it("creator rebate: does NOT update mint_volume_30d (gaming defense per DR-008)", async () => {
    const { program, marketId } = await setupWithFeeActive();
    // ADMIN created market; ADMIN mints $1500 → rebate fires; mint_volume_30d must NOT increment
    await program.mintPair({ user: ADMIN, marketId, amount: 1500n * ONE_USDC });
    const adminCfg = await program.fetchUserConfig(ADMIN);
    expect(adminCfg.mintVolume30d).to.equal(0n);
  });

  it("non-creator mints into creator's strike: pays normal tier fee + updates mint_volume_30d", async () => {
    const { program, marketId } = await setupWithFeeActive();
    // USER (not creator) mints $100 → tier 1 (200 bps), volume updates.
    await program.mintPair({ user: USER, marketId, amount: 100n * ONE_USDC });
    const userCfg = await program.fetchUserConfig(USER);
    expect(userCfg.mintVolume30d).to.equal(100n * ONE_USDC);
    const pools = await program.fetchPoolBalances();
    expect(pools.feeCollector + pools.weekly + pools.monthly).to.equal((100n * ONE_USDC * 200n) / 10_000n);
  });

  it("fee splits correctly: platform (50%) + weekly (25%) + monthly (25%) = total fee", async () => {
    const { program, marketId } = await setupWithFeeActive();
    await program.mintPair({ user: USER, marketId, amount: 100n * ONE_USDC });
    const pools = await program.fetchPoolBalances();
    const totalFee = (100n * ONE_USDC * 200n) / 10_000n;       // $2 micro-USDC = 2_000_000
    expect(pools.feeCollector).to.equal(totalFee / 2n);         // 50%
    expect(pools.weekly).to.equal(totalFee / 4n);                // 25%
    expect(pools.monthly).to.equal(totalFee - pools.feeCollector - pools.weekly);  // remainder = 25%
  });

  it("initializeFeeConfig rejects bps sum != 10000 (FeeBpsSumMismatch)", async () => {
    const { program } = await setupWithTickerConfig();
    try {
      await program.initializeFeeConfig({
        admin: ADMIN, platformRetainBps: 4000, weeklyPoolBps: 2500, monthlyPoolBps: 2500,  // sums to 9000
      });
      expect.fail("expected FeeBpsSumMismatch");
    } catch (e) {
      expect((e as Error).message).to.match(/FeeBpsSumMismatch/);
    }
  });

  it("$1 USDC invariant holds with fees active: vault stays exactly amount × pairs_minted (fees go to separate pools)", async () => {
    const { program, marketId } = await setupWithFeeActive();
    await program.mintPair({ user: USER,  marketId, amount: 100n * ONE_USDC });
    await program.mintPair({ user: USER2, marketId, amount: 50n  * ONE_USDC });
    // Vault should be exactly $150 — fees went to separate fee_collector/weekly/monthly pools.
    const vault = await program.fetchVaultBalance(marketId);
    expect(vault).to.equal(150n * ONE_USDC);
    const pools = await program.fetchPoolBalances();
    const expectedFees = (100n * ONE_USDC * 200n + 50n * ONE_USDC * 200n) / 10_000n;
    expect(pools.feeCollector + pools.weekly + pools.monthly).to.equal(expectedFees);
  });
});

// ─── DR-005 — force_redeem (admin escape valve after settle + grace) ─────

describe("DR-005 — force_redeem", () => {
  async function setupSettled(): Promise<{ program: AriaProgram; state: MockState; marketId: Pubkey }> {
    const { program, state } = await setupWithTickerConfig();
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
    });
    await program.mintPair({ user: USER, marketId: res.marketId, amount: ONE_USDC });
    state.blockTime += 70n;
    await program.settleMarket({ settler: USER, marketId: res.marketId });
    return { program, state, marketId: res.marketId };
  }

  it("rejects before settled_at + grace_secs (ForceRedeemTooEarly)", async () => {
    const { program, marketId } = await setupSettled();
    // Default grace = 30 days; we're just past expiry, so still too early.
    try {
      await program.forceRedeem({ admin: ADMIN, marketId, user: USER, amount: ONE_USDC });
      expect.fail("expected ForceRedeemTooEarly");
    } catch (e) {
      expect((e as Error).message).to.match(/ForceRedeemTooEarly/);
    }
  });

  it("succeeds after grace; transfers USDC out of vault", async () => {
    const { program, state, marketId } = await setupSettled();
    const grace = DEFAULT_FEE_CONFIG.forceRedeemGraceSecs;
    state.blockTime += grace + 1n;
    const before = await program.fetchVaultBalance(marketId);
    await program.forceRedeem({ admin: ADMIN, marketId, user: USER, amount: ONE_USDC });
    const after = await program.fetchVaultBalance(marketId);
    expect(after).to.equal(before - ONE_USDC);
  });

  it("rejects non-admin caller (NotAdmin)", async () => {
    const { program, state, marketId } = await setupSettled();
    state.blockTime += DEFAULT_FEE_CONFIG.forceRedeemGraceSecs + 1n;
    try {
      await program.forceRedeem({ admin: USER, marketId, user: USER, amount: ONE_USDC });
      expect.fail("expected NotAdmin");
    } catch (e) {
      expect((e as Error).message).to.match(/NotAdmin/);
    }
  });
});

// ─── DR-005 — close_settled_market (rent recovery) ───────────────────────

describe("DR-005 — close_settled_market", () => {
  it("rejects when pairs_outstanding > 0 (PairsStillOutstanding)", async () => {
    const { program, state } = await setupWithTickerConfig();
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
    });
    await program.mintPair({ user: USER, marketId: res.marketId, amount: ONE_USDC });
    state.blockTime += 70n;
    await program.settleMarket({ settler: USER, marketId: res.marketId });
    // Vault still has $1 (USER hasn't redeemed). Close should reject.
    try {
      await program.closeSettledMarket({ closer: USER, marketId: res.marketId });
      expect.fail("expected PairsStillOutstanding");
    } catch (e) {
      expect((e as Error).message).to.match(/PairsStillOutstanding/);
    }
  });

  it("succeeds when pairs_outstanding == 0; recovered rent flows to treasury (fee_collector)", async () => {
    const { program, state } = await setupWithTickerConfig();
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
    });
    await program.mintPair({ user: USER, marketId: res.marketId, amount: ONE_USDC });
    state.blockTime += 70n;
    await program.settleMarket({ settler: USER, marketId: res.marketId });
    await program.redeem({ user: USER, marketId: res.marketId, amount: ONE_USDC });
    expect(await program.fetchVaultBalance(res.marketId)).to.equal(0n);
    const before = (await program.fetchPoolBalances()).feeCollector;
    await program.closeSettledMarket({ closer: USER, marketId: res.marketId });   // permissionless
    const after = (await program.fetchPoolBalances()).feeCollector;
    expect(after > before).to.equal(true);   // chai doesn't compare BigInt with greaterThan
  });

  it("rejects when called on Unsettled market (NotSettled)", async () => {
    const { program, state } = await setupWithTickerConfig();
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
    });
    try {
      await program.closeSettledMarket({ closer: USER, marketId: res.marketId });
      expect.fail("expected NotSettled");
    } catch (e) {
      expect((e as Error).message).to.match(/NotSettled/);
    }
  });
});

// ─── DR-010 — commit_leaderboard_root + distribute_*_rewards (Merkle) ────

describe("DR-010 — commit_leaderboard_root + distribute_*_rewards (Merkle-verifiable)", () => {
  /** Helper: setup with fee config + some pool balance to distribute from.
   *  Mints from USER2 (NOT the creator) to avoid creator rebate zeroing the fee. */
  async function setupWithPoolFunds(): Promise<{ program: AriaProgram; state: MockState }> {
    const { program, state } = await setupWithTickerConfig();
    await program.initializeFeeConfig({ admin: ADMIN, mintFeeBps: 200 });
    const res = await program.userCreateStrikeMarket({
      user: USER, underlyingPythFeed: PYTH, strikePrice: 200_000_000n,
      expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
    });
    // USER2 (NOT creator) mints $10000 → tier 1 200bps fee = $200; split 50/25/25 → $50 weekly + $50 monthly.
    await program.mintPair({ user: USER2, marketId: res.marketId, amount: 10_000n * ONE_USDC });
    return { program, state };
  }

  /** Build a one-leaf Merkle tree (single-recipient). Root = leaf hash; proof = []. */
  function singleLeafProof(recipient: Pubkey, position: number, amount: bigint): { root: Uint8Array; proof: Uint8Array[] } {
    const leafStr = `${recipient}:${position}:${amount.toString()}`;
    const root = new Uint8Array(createHash("sha256").update(leafStr).digest());
    return { root, proof: [] };
  }

  it("commit_leaderboard_root: rejects non-admin (NotAdmin)", async () => {
    const { program } = await setupWithPoolFunds();
    const { root } = singleLeafProof(USER, 0, 100n);
    try {
      await program.commitLeaderboardRoot({
        admin: USER, periodId: 1n, periodType: 0,
        merkleRoot: root, arweaveTxId: new Uint8Array(48),
      });
      expect.fail("expected NotAdmin");
    } catch (e) {
      expect((e as Error).message).to.match(/NotAdmin/);
    }
  });

  it("commit_leaderboard_root: stores commitment in LeaderboardCommitments PDA", async () => {
    const { program, state } = await setupWithPoolFunds();
    const { root } = singleLeafProof(USER, 0, 100n);
    await program.commitLeaderboardRoot({
      admin: ADMIN, periodId: 42n, periodType: 0,
      merkleRoot: root, arweaveTxId: new Uint8Array(48),
    });
    expect(state.leaderboardCommitments.size).to.equal(1);
    const stored = state.leaderboardCommitments.get("0:42");
    expect(stored).to.exist;
    expect(stored!.periodId).to.equal(42n);
    expect(stored!.periodType).to.equal(0);
  });

  it("distribute_weekly_rewards: rejects when merkle_proof doesn't verify against committed root", async () => {
    const { program } = await setupWithPoolFunds();
    const { root } = singleLeafProof(USER, 0, 100n);
    await program.commitLeaderboardRoot({
      admin: ADMIN, periodId: 1n, periodType: 0, merkleRoot: root, arweaveTxId: new Uint8Array(48),
    });
    // Try to distribute to a DIFFERENT recipient — proof for original recipient should not match.
    try {
      await program.distributeWeeklyRewards({
        admin: ADMIN, periodId: 1n, recipient: USER2, position: 0, amount: 100n, merkleProof: [],
      });
      expect.fail("expected InvalidProof");
    } catch (e) {
      expect((e as Error).message).to.match(/InvalidProof/);
    }
  });

  it("distribute_weekly_rewards: succeeds with valid proof; transfers from weekly pool", async () => {
    const { program, state } = await setupWithPoolFunds();
    const distAmount = 10n * ONE_USDC;
    const { root, proof } = singleLeafProof(USER, 0, distAmount);
    await program.commitLeaderboardRoot({
      admin: ADMIN, periodId: 1n, periodType: 0, merkleRoot: root, arweaveTxId: new Uint8Array(48),
    });
    const before = state.weeklyPool;
    expect(before > distAmount).to.equal(true);  // pool has enough (chai BigInt)
    await program.distributeWeeklyRewards({
      admin: ADMIN, periodId: 1n, recipient: USER, position: 0, amount: distAmount, merkleProof: proof,
    });
    expect(state.weeklyPool).to.equal(before - distAmount);
  });

  it("distribute_weekly_rewards: rejects re-distribution to same recipient/position (AlreadyClaimed)", async () => {
    const { program } = await setupWithPoolFunds();
    const { root, proof } = singleLeafProof(USER, 0, 10n * ONE_USDC);
    await program.commitLeaderboardRoot({
      admin: ADMIN, periodId: 1n, periodType: 0, merkleRoot: root, arweaveTxId: new Uint8Array(48),
    });
    await program.distributeWeeklyRewards({
      admin: ADMIN, periodId: 1n, recipient: USER, position: 0, amount: 10n * ONE_USDC, merkleProof: proof,
    });
    try {
      await program.distributeWeeklyRewards({
        admin: ADMIN, periodId: 1n, recipient: USER, position: 0, amount: 10n * ONE_USDC, merkleProof: proof,
      });
      expect.fail("expected AlreadyClaimed");
    } catch (e) {
      expect((e as Error).message).to.match(/AlreadyClaimed/);
    }
  });

  it("distribute_monthly_rewards: same shape as weekly but operates on monthly pool", async () => {
    const { program, state } = await setupWithPoolFunds();
    const distAmount = 10n * ONE_USDC;
    const { root, proof } = singleLeafProof(USER, 0, distAmount);
    await program.commitLeaderboardRoot({
      admin: ADMIN, periodId: 1n, periodType: 1, merkleRoot: root, arweaveTxId: new Uint8Array(48),
    });
    const beforeWeekly = state.weeklyPool;
    const beforeMonthly = state.monthlyPool;
    await program.distributeMonthlyRewards({
      admin: ADMIN, periodId: 1n, recipient: USER, position: 0, amount: distAmount, merkleProof: proof,
    });
    expect(state.weeklyPool).to.equal(beforeWeekly);          // weekly unchanged
    expect(state.monthlyPool).to.equal(beforeMonthly - distAmount);  // monthly drained
  });
});

// ─── DR-007 — trading calendar (Bram-side; pending Bram's calendar.ts publish) ───

describe("DR-007 — trading calendar (skipped: Bram-side helpers not yet exported)", () => {
  it.skip("isTradingDay: returns false for Saturday + Sunday", async () => undefined);
  it.skip("isTradingDay: returns false for US full holidays (e.g., Memorial Day 2026-05-25)", async () => undefined);
  it.skip("isTradingDay: returns TRUE for half-days", async () => undefined);
  it.skip("getCloseTime: returns 16:00 ET for regular trading days", async () => undefined);
  it.skip("getCloseTime: returns 13:00 ET for half-days", async () => undefined);
  it.skip("nextTradingDay: skips weekends + full holidays; KEEPS half-days", async () => undefined);
});

// ─── DR-011 — earnings-calendar pre-expansion (Bram-side) ───

describe("DR-011 — earnings-calendar pre-expansion (skipped: Bram-side helpers not yet exported)", () => {
  it.skip("isEarningsTomorrow: returns true day before known MAG7 earnings", async () => undefined);
  it.skip("preExpansionMagnitude: returns ticker-specific expanded cap", async () => undefined);
  it.skip("post-earnings restore: returns ticker to default cap", async () => undefined);
  it.skip("earnings-during-half-day edge case", async () => undefined);
  it.skip("empty calendar: isEarningsTomorrow returns false; no crash", async () => undefined);
});

// Sanity heartbeat — confirms file loads cleanly post-merge.
describe("scaffolding meta", () => {
  it("file loads + mock + DEFAULT_FEE_CONFIG importable", () => {
    expect(DEFAULT_FEE_CONFIG.creatorRebateBps).to.equal(10000);
    expect(typeof createMockAria).to.equal("function");
  });
});
