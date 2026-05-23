// edge-cases.test.ts — parameterized mocha cases that supplement the
// compressed-time simulation (Hard YES #1 primary verification).
//
// Day-3 status (Fri 2026-05-22): IDL-reconciled mock + full coverage of I3,
// DR-002, I4, redeem discipline, mint_pair guards, pause discipline, and the
// NEW redeem_invalid Day-3 instruction. 2 Pyth gate tests are deliberately
// `it.skip` until live RPC mode validates the vendored parser byte handling
// against a forked Pyth account (Day-4 work).
//
// Sources:
//   - programs/bell-markets/idl/bell_markets.json (Anchor 0.31 spec v0.1.0; 9 ix)
//   - programs/bell-markets/src/{state,instructions/*}.rs
//   - tests/eval/invariants.md
//   - constitution/hard-rules.md §4.2, §4.4, §4.5, §4.6
//   - constitution/decisions.md DR-002 (permissionless settle), DR-003 (Pyth)
//   - BRAINLIFT.md Hard YES #1, #5, #6, #7
//
// Run:  pnpm --filter @bell-markets/tests test:eval

import { expect } from "chai";
import {
  createMockAria,
  outcomeKind,
  ONE_USDC,
  OUTCOME_YES,
  OUTCOME_NO,
  OUTCOME_INVALID,
  OUTCOME_UNSETTLED,
  type Pubkey,
} from "../integration/mocks/aria-interface";

const STRIKE_PRICE = 680_000_000n;         // $680 micro-USDC
const ADMIN: Pubkey     = "admin-pubkey";
const USER: Pubkey      = "user-pubkey";
const USER2: Pubkey     = "user2-pubkey";
const SETTLER: Pubkey   = "unfunded-keypair-pubkey";
const PYTH: Pubkey      = "pyth-aapl-feed-mock";
const PHOENIX: Pubkey   = "phoenix-aapl-fifo-market-mock";
const USDC_MINT: Pubkey = "usdc-mint-mock";
const TREASURY: Pubkey  = "treasury-mock";

const DEFAULT_INIT = {
  admin: ADMIN,
  usdcMint: USDC_MINT,
  treasury: TREASURY,
  priceStalenessSecs: 300n,
  priceConfidenceBps: 50,
  adminOverrideDelaySecs: 3600n,
};

/** Setup helper: init config, create a market with expiry 60s out, mint $1 to USER. */
async function settleableMarket(opts: Parameters<typeof createMockAria>[0] = {}) {
  const { program, state } = createMockAria(opts);
  state.blockTime = 1_000_000n;
  state.slot      = 250_000_000n;
  await program.initializeConfig(DEFAULT_INIT);
  const created = await program.createStrikeMarket({
    admin: ADMIN, underlyingPythFeed: PYTH, strikePrice: STRIKE_PRICE,
    expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
  });
  await program.mintPair({ user: USER, marketId: created.marketId, amount: ONE_USDC });
  state.blockTime += 70n;
  state.slot += 175n;
  return { program, state, marketId: created.marketId };
}

describe("BellMarkets edge cases (Drew, eval supplement)", () => {

  // ─── I3 — outcome immutability ──────────────────────────────────────
  describe("I3: outcome is immutable once written", () => {
    it("second settle_market call rejects with AlreadySettled", async () => {
      const { program, marketId } = await settleableMarket();
      await program.settleMarket({ settler: SETTLER, marketId });
      try {
        await program.settleMarket({ settler: SETTLER, marketId });
        expect.fail("expected second settle to throw AlreadySettled");
      } catch (e) {
        expect((e as Error).message).to.match(/AlreadySettled/);
      }
    });

    it("admin_settle after a successful settle_market also rejects", async () => {
      const { program, state, marketId } = await settleableMarket();
      await program.settleMarket({ settler: SETTLER, marketId });
      state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs * 2n;
      try {
        await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_NO });
        expect.fail("expected admin_settle on a settled market to throw AlreadySettled");
      } catch (e) {
        expect((e as Error).message).to.match(/AlreadySettled/);
      }
    });
  });

  // ─── DR-002 — permissionless settle (Hard NO #5 / hard-rules.md §4.2) ───
  describe("DR-002: settle_market is permissionless", () => {
    it("settles successfully when called by an arbitrary unfunded keypair", async () => {
      const { program, marketId } = await settleableMarket();
      const result = await program.settleMarket({ settler: SETTLER, marketId });
      expect(result.signature).to.match(/^mock-/);
      const m = await program.fetchStrikeMarket(marketId);
      expect(outcomeKind(m.outcome)).to.be.oneOf(["yes", "no"]);
      expect(m.settledAtUnix > 0n).to.equal(true);
    });

    it("rejects settle_market BEFORE expiry regardless of caller", async () => {
      const { program, state } = createMockAria();
      state.blockTime = 1_000_000n;
      state.slot      = 250_000_000n;
      await program.initializeConfig(DEFAULT_INIT);
      const created = await program.createStrikeMarket({
        admin: ADMIN, underlyingPythFeed: PYTH, strikePrice: STRIKE_PRICE,
        expiryUnix: state.blockTime + 1_000n, phoenixMarket: PHOENIX,
      });
      try {
        await program.settleMarket({ settler: SETTLER, marketId: created.marketId });
        expect.fail("expected settle before expiry to throw NotExpired");
      } catch (e) {
        expect((e as Error).message).to.match(/NotExpired/);
      }
    });

    it("parameterized cron-failure sweep — multiple distinct settlers each crank cleanly", async () => {
      const settlers: Pubkey[] = ["settler-1", "settler-2", "settler-3", "fresh-keypair-xyz"];
      for (const s of settlers) {
        const { program, marketId } = await settleableMarket();
        const result = await program.settleMarket({ settler: s, marketId });
        expect(result.signature).to.match(/^mock-/);
        const m = await program.fetchStrikeMarket(marketId);
        expect(outcomeKind(m.outcome)).to.be.oneOf(["yes", "no"]);
      }
    });
  });

  // ─── Pyth gates (hard-rules.md §4.4 / Hard YES #6) — mock today, live Day-4 ───
  it.skip("Pyth: settle_market with stale price rejects (PythStale)", async () => {
    const { program, marketId } = await settleableMarket({ pythBehavior: "stale" });
    try {
      await program.settleMarket({ settler: SETTLER, marketId });
      expect.fail("expected PythStale");
    } catch (e) {
      expect((e as Error).message).to.match(/PythStale/);
    }
  });

  it.skip("Pyth: settle_market with wide confidence rejects (PythConfidenceTooWide)", async () => {
    const { program, marketId } = await settleableMarket({ pythBehavior: "wide" });
    try {
      await program.settleMarket({ settler: SETTLER, marketId });
      expect.fail("expected PythConfidenceTooWide");
    } catch (e) {
      expect((e as Error).message).to.match(/PythConfidenceTooWide/);
    }
  });

  // ─── Admin override time-delay (hard-rules.md §4.5 / Hard YES #7) ───
  it("admin_settle BEFORE admin_override_eligible_at reverts (≥1hr time-delay gate)", async () => {
    const { program, state, marketId } = await settleableMarket();
    try {
      await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_YES });
      expect.fail("expected AdminOverrideTooEarly");
    } catch (e) {
      expect((e as Error).message).to.match(/AdminOverrideTooEarly/);
    }
    state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
    const result = await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_YES });
    expect(result.signature).to.match(/^mock-/);
    const m = await program.fetchStrikeMarket(marketId);
    expect(outcomeKind(m.outcome)).to.equal("yes");
    expect(m.settlePrice).to.equal(0n);          // admin-pathed discriminator
  });

  it("admin_settle rejects forcedOutcome === Unsettled (ForcedOutcomeUnsettled)", async () => {
    const { program, state, marketId } = await settleableMarket();
    state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
    try {
      await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_UNSETTLED });
      expect.fail("expected ForcedOutcomeUnsettled");
    } catch (e) {
      expect((e as Error).message).to.match(/ForcedOutcomeUnsettled/);
    }
  });

  // ─── redeem discipline (winning side only) ──────────────────────────
  describe("redeem (Yes/No only — single winning side)", () => {
    it("reverts when market is Unsettled (NotSettled)", async () => {
      const { program, state } = createMockAria();
      state.blockTime = 1_000_000n;
      await program.initializeConfig(DEFAULT_INIT);
      const created = await program.createStrikeMarket({
        admin: ADMIN, underlyingPythFeed: PYTH, strikePrice: STRIKE_PRICE,
        expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
      });
      await program.mintPair({ user: USER, marketId: created.marketId, amount: ONE_USDC });
      try {
        await program.redeem({ user: USER, marketId: created.marketId, amount: ONE_USDC });
        expect.fail("expected NotSettled");
      } catch (e) {
        expect((e as Error).message).to.match(/NotSettled/);
      }
    });

    it("reverts on Invalid outcome (InvalidOutcomeForRedeem — use redeem_invalid)", async () => {
      const { program, state, marketId } = await settleableMarket();
      state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
      await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_INVALID });
      try {
        await program.redeem({ user: USER, marketId, amount: ONE_USDC });
        expect.fail("expected InvalidOutcomeForRedeem");
      } catch (e) {
        expect((e as Error).message).to.match(/InvalidOutcomeForRedeem/);
      }
    });

    it("double-redeem of the same winning tokens reverts (insufficient balance)", async () => {
      const { program, marketId } = await settleableMarket();
      await program.settleMarket({ settler: SETTLER, marketId });
      await program.redeem({ user: USER, marketId, amount: ONE_USDC });
      try {
        await program.redeem({ user: USER, marketId, amount: ONE_USDC });
        expect.fail("expected insufficient winning balance");
      } catch (e) {
        expect((e as Error).message).to.match(/insufficient winning balance/);
      }
    });

    it("over-redeem (amount > winning balance) reverts", async () => {
      const { program, marketId } = await settleableMarket();
      await program.settleMarket({ settler: SETTLER, marketId });
      try {
        await program.redeem({ user: USER, marketId, amount: 999n * ONE_USDC });
        expect.fail("expected insufficient winning balance");
      } catch (e) {
        expect((e as Error).message).to.match(/insufficient winning balance/);
      }
    });

    it("zero amount reverts (ZeroAmount)", async () => {
      const { program, marketId } = await settleableMarket();
      await program.settleMarket({ settler: SETTLER, marketId });
      try {
        await program.redeem({ user: USER, marketId, amount: 0n });
        expect.fail("expected ZeroAmount");
      } catch (e) {
        expect((e as Error).message).to.match(/ZeroAmount/);
      }
    });
  });

  // ─── redeem_invalid (Day-3 new 9th instruction) ─────────────────────
  describe("redeem_invalid (refund pair deposit for Invalid markets)", () => {
    it("succeeds for Invalid outcome: drains both sides + vault by `amount`", async () => {
      const { program, state, marketId } = await settleableMarket();
      state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
      await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_INVALID });

      const before = await program.fetchUserPosition(marketId, USER);
      expect(before.yesBalance).to.equal(ONE_USDC);
      expect(before.noBalance).to.equal(ONE_USDC);
      const vaultBefore = await program.fetchVaultBalance(marketId);
      expect(vaultBefore).to.equal(ONE_USDC);

      const result = await program.redeemInvalid({ user: USER, marketId, amount: ONE_USDC });
      expect(result.signature).to.match(/^mock-/);

      const after = await program.fetchUserPosition(marketId, USER);
      expect(after.yesBalance).to.equal(0n);
      expect(after.noBalance).to.equal(0n);
      expect(await program.fetchVaultBalance(marketId)).to.equal(0n);
    });

    it("reverts for Unsettled / Yes / No outcomes (InvalidOutcomeForRedeem)", async () => {
      // Unsettled
      const a = await settleableMarket();
      try {
        await a.program.redeemInvalid({ user: USER, marketId: a.marketId, amount: ONE_USDC });
        expect.fail("expected InvalidOutcomeForRedeem (Unsettled)");
      } catch (e) {
        expect((e as Error).message).to.match(/InvalidOutcomeForRedeem/);
      }
      // Yes (oracle-settled to YES via default pythClosePrice > strike)
      const b = await settleableMarket();
      await b.program.settleMarket({ settler: SETTLER, marketId: b.marketId });
      try {
        await b.program.redeemInvalid({ user: USER, marketId: b.marketId, amount: ONE_USDC });
        expect.fail("expected InvalidOutcomeForRedeem (Yes)");
      } catch (e) {
        expect((e as Error).message).to.match(/InvalidOutcomeForRedeem/);
      }
    });

    it("rejects ZeroAmount", async () => {
      const { program, state, marketId } = await settleableMarket();
      state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
      await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_INVALID });
      try {
        await program.redeemInvalid({ user: USER, marketId, amount: 0n });
        expect.fail("expected ZeroAmount");
      } catch (e) {
        expect((e as Error).message).to.match(/ZeroAmount/);
      }
    });

    it("rejects when user holds an asymmetric position (one side short)", async () => {
      // Earlier draft of this test had a misleading comment about asymmetric
      // positions but the body did over-redeem only. Audit caught the
      // mismatch (Sonnet review, 2026-05-22). Rewritten to actually create
      // an asymmetric YES/NO position and assert redeem_invalid rejects on
      // the short side.
      //
      // We mutate `state.positions` directly because the mock's only path
      // to asymmetric positions is "user traded YES or NO away on Phoenix
      // post-mint." The simulation script exercises that path via
      // _phoenixTrade; the mock here doesn't model Phoenix, so direct state
      // mutation is the cleanest setup.
      const { program, state, marketId } = await settleableMarket();
      // Set USER's position to 1 YES + 0 NO (asymmetric — NO was "sold off").
      state.positions.set(`${marketId}:${USER}`, {
        marketId, wallet: USER,
        yesBalance: ONE_USDC,
        noBalance: 0n,
      });
      state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
      await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_INVALID });
      // Try to redeem_invalid 1 USDC — needs 1 YES + 1 NO. Has 1 YES + 0 NO. Fail on NO.
      try {
        await program.redeemInvalid({ user: USER, marketId, amount: ONE_USDC });
        expect.fail("expected insufficient NO");
      } catch (e) {
        expect((e as Error).message).to.match(/insufficient NO/);
      }
      // Symmetry: same but other side short.
      state.positions.set(`${marketId}:${USER2}`, {
        marketId, wallet: USER2,
        yesBalance: 0n,
        noBalance: ONE_USDC,
      });
      try {
        await program.redeemInvalid({ user: USER2, marketId, amount: ONE_USDC });
        expect.fail("expected insufficient YES");
      } catch (e) {
        expect((e as Error).message).to.match(/insufficient YES/);
      }
    });
  });

  // ─── mint_pair guards ───────────────────────────────────────────────
  it("mint_pair rejects ZeroAmount", async () => {
    const { program, state } = createMockAria();
    state.blockTime = 1_000_000n;
    await program.initializeConfig(DEFAULT_INIT);
    const created = await program.createStrikeMarket({
      admin: ADMIN, underlyingPythFeed: PYTH, strikePrice: STRIKE_PRICE,
      expiryUnix: state.blockTime + 60n, phoenixMarket: PHOENIX,
    });
    try {
      await program.mintPair({ user: USER, marketId: created.marketId, amount: 0n });
      expect.fail("expected ZeroAmount");
    } catch (e) {
      expect((e as Error).message).to.match(/ZeroAmount/);
    }
  });

  it("mint_pair rejects when market is already Settled (AlreadySettled)", async () => {
    const { program, marketId } = await settleableMarket();
    await program.settleMarket({ settler: SETTLER, marketId });
    try {
      await program.mintPair({ user: USER2, marketId, amount: ONE_USDC });
      expect.fail("expected AlreadySettled");
    } catch (e) {
      expect((e as Error).message).to.match(/AlreadySettled/);
    }
  });

  // ─── pause discipline ───────────────────────────────────────────────
  it("pause + every mutating instruction respects config.paused", async () => {
    const { program, marketId } = await settleableMarket();
    await program.pause({ admin: ADMIN, paused: true });
    for (const attempt of [
      () => program.mintPair({ user: USER2, marketId, amount: ONE_USDC }),
      () => program.settleMarket({ settler: SETTLER, marketId }),
    ]) {
      try {
        await attempt();
        expect.fail("expected Paused");
      } catch (e) {
        expect((e as Error).message).to.match(/Paused/);
      }
    }
    await program.pause({ admin: ADMIN, paused: false });
    const result = await program.settleMarket({ settler: SETTLER, marketId });
    expect(result.signature).to.match(/^mock-/);
  });

  it("pause from non-admin reverts NotAdmin", async () => {
    const { program } = await settleableMarket();
    try {
      await program.pause({ admin: USER, paused: true });
      expect.fail("expected NotAdmin");
    } catch (e) {
      expect((e as Error).message).to.match(/NotAdmin/);
    }
  });

  // ─── I1/I2/I4 vault drain (end-to-end mock invariants) ──────────────
  it("I1+I2+I4: vault drains to zero when winning side fully redeems", async () => {
    const { program, marketId } = await settleableMarket();
    await program.settleMarket({ settler: SETTLER, marketId });           // outcome = yes (default)
    const before = await program.fetchVaultBalance(marketId);
    expect(before).to.equal(ONE_USDC);
    await program.redeem({ user: USER, marketId, amount: ONE_USDC });
    expect(await program.fetchVaultBalance(marketId)).to.equal(0n);
  });

  it("I1+I2+I4 (Invalid path): vault drains to zero when redeem_invalid burns full pair", async () => {
    const { program, state, marketId } = await settleableMarket();
    state.blockTime += DEFAULT_INIT.adminOverrideDelaySecs;
    await program.adminSettle({ admin: ADMIN, marketId, forcedOutcome: OUTCOME_INVALID });
    expect(await program.fetchVaultBalance(marketId)).to.equal(ONE_USDC);
    await program.redeemInvalid({ user: USER, marketId, amount: ONE_USDC });
    expect(await program.fetchVaultBalance(marketId)).to.equal(0n);
  });
});
