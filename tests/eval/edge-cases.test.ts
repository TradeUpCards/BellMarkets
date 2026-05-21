// edge-cases.test.ts — parameterized mocha cases that supplement the
// compressed-time simulation (Hard YES #1 primary verification).
//
// Day-1 status (Thu 2026-05-21): ALL CASES ARE `it.skip(...)`. The mocha
// harness is wired up so a smoke run confirms toolchain + types resolve; real
// assertions land progressively as Aria's instructions become testable on
// devnet (first deploy: Sat 2026-05-23).
//
// Sources:
//   - tests/eval/invariants.md (the 5-invariant proof set)
//   - constitution/hard-rules.md §4.4, §4.5 (settle gates), §4.6 ($1 invariant)
//   - constitution/decisions.md DR-002 (permissionless settle), DR-003 (Pyth)
//   - BRAINLIFT.md Hard YES #1, #5, #6, #7
//
// Run (Sat 2026-05-23 onward, once devDeps land per
//   .project/bell-markets/coordination/monorepo-config.md):
//
//   pnpm --filter @bell-markets/tests test:eval

import { expect } from "chai";
import { createMockAria, ONE_USDC, type Pubkey, type Ticker } from "../integration/mocks/aria-interface.js";

const TICKER: Ticker = "AAPL";
const STRIKE = 680_000_000n;            // $680
const ADMIN: Pubkey  = "admin-pubkey";
const USER: Pubkey   = "user-pubkey";
const PYTH: Pubkey   = "pyth-aapl-feed-mock";

describe("BellMarkets edge cases (Drew, eval supplement)", () => {

  // ─── I2 — at-strike outcome (close == strike) ───────────────────────
  it.skip("I2: at-strike outcome (close == strike) settles to YesWins per Outcome::YesWins rule", async () => {
    // close == strike  →  YesWins per `Outcome::YesWins` = `close >= strike`.
    // This is the boundary case our settle logic must handle correctly.
    // Aria's settle_market: close_price >= strike → YesWins; else NoWins.
    const { program, state } = createMockAria();
    state.blockTime = 1n;
    await program.initializeConfig({ admin: ADMIN, supportedTickers: [TICKER], pythFeedMap: [{ ticker: TICKER, feed: PYTH }] });
    const { marketId } = await program.createStrikeMarket({ caller: ADMIN, ticker: TICKER, strike: STRIKE, settlementWindow: 0n, pythFeed: PYTH });
    await program.mintPair({ caller: USER, marketId, pairs: 1n });
    state.blockTime = 100n;
    // TODO: settleMarket with close_price === STRIKE; expect outcome === "YesWins".
    expect(marketId).to.be.a("string");
  });

  // ─── I3 — second settle (immutability) ──────────────────────────────
  it.skip("I3: second settle_market call rejects with 'outcome already written'", async () => {
    // Outcome is immutable once written (specs/architecture.md §3 invariants table row 3).
    // First settle writes; second settle from any caller MUST revert.
    // TODO: instantiate market, settle once, attempt second settle, expect throw.
  });

  it.skip("I3: admin_settle after a successful settle_market also rejects", async () => {
    // Cross-instruction immutability: settle_market THEN admin_settle must reject.
    // TODO: covers the "admin tries to override a normal settle" attack surface.
  });

  // ─── I4 — settle-before-window ──────────────────────────────────────
  it.skip("I4 negative: settle_market before settlement_window reverts", async () => {
    // hard-rules.md §4.2 (permissionless settle is safe under arbitrary signers BUT
    // only after time + Pyth gates pass). Calling before block_time >= window
    // must revert regardless of caller.
    // TODO: instantiate market with future window, attempt settle, expect throw.
  });

  // ─── Pyth gates (hard-rules.md §4.4) ───────────────────────────────
  it.skip("Pyth: settle_market with stale price rejects (staleness gate)", async () => {
    // pythBehavior: "stale" — the vendored parser would return a slot too old.
    // Program-side check: current_slot - price.publish_slot < staleness_threshold_sec.
    // TODO: mock pythBehavior=stale, expect throw with stale-price error.
  });

  it.skip("Pyth: settle_market with wide confidence rejects (confidence gate)", async () => {
    // pythBehavior: "wide" — confidence_bps > confidence_threshold_bps (default 50).
    // TODO: mock pythBehavior=wide, expect throw with confidence-too-wide error.
  });

  // ─── Admin override time-delay (hard-rules.md §4.5 / Hard YES #7) ───
  it.skip("admin_settle before window + delay reverts (≥1hr time-delay gate)", async () => {
    // admin_settle is gated by `block_time >= settlement_window + admin_override_delay_sec`
    // (default 3600s). Calling earlier must revert even from the admin signer.
    // TODO: settle at window + 1s; expect throw. settle at window + 3600s; expect success.
  });

  // ─── Permissionless settle (DR-002 / hard-rules.md §4.2) ────────────
  it.skip("DR-002: settle_market succeeds when called by an arbitrary unfunded keypair", async () => {
    // The DR-002 evidence test. settle_market must NOT have any "caller is admin"
    // assertion. The negative test fails if any signer check creeps in.
    // TODO: create market, advance past window, settle from a fresh random keypair
    // (no admin authority, no funds beyond gas), expect success.
  });

  // ─── Redeem discipline (I4) ─────────────────────────────────────────
  it.skip("I4 negative: double-redeem of the same tokens reverts", async () => {
    // After a successful redeem burning all winning tokens, a second redeem call
    // with the same caller + market must revert (insufficient balance).
    // TODO: redeem, attempt second redeem, expect throw.
  });

  it.skip("I4 negative: redeem with yes_amount > balance reverts (no over-redeem)", async () => {
    // Token-supply discipline: a caller cannot redeem more than they hold.
    // TODO: mint 1 pair, attempt redeem yesAmount=999, expect throw.
  });

  // ─── Cron-failure path (Hard YES #5 / DR-002 demo evidence) ─────────
  it.skip("DR-002 demo: user wallet can settle when automation never ran (Hard YES #5)", async () => {
    // The simulation already exercises this in Phase 3 (CAROL settles instead of admin).
    // This mocha case is the parameterized version: sweep across (close_price > strike,
    // close_price < strike, close_price == strike) × (caller = ALICE, BOB, CAROL, fresh-keypair)
    // and assert each combination settles cleanly with the correct outcome.
    // TODO: parameterized sweep.
  });
});
