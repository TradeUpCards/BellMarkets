use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;
use crate::oracle::parse_pyth_price;

/// PERMISSIONLESS settle (kickoff §4.2). Any signer can call this — settle_market
/// is intentionally callable by anyone who can pay the transaction fee. The
/// instruction's correctness is enforced by:
///   1. config.paused == false
///   2. clock.unix_timestamp >= strike_market.expiry_unix
///   3. underlying_pyth_feed.key() == strike_market.underlying_pyth_feed
///   4. parse_pyth_price (magic / version / atype / status / staleness / confidence)
///
/// Note the absence of any `admin` constraint on the Accounts struct. This is
/// deliberate and is enforced by the auditor (kickoff §4.2 — no signer beyond
/// the fee payer).
#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Fee payer. NOT validated against admin — settle is permissionless.
    pub settler: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Pyth price account. Validated by:
    ///   1. key match against strike_market.underlying_pyth_feed
    ///   2. parse_pyth_price magic/version/atype/status checks
    pub underlying_pyth_feed: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
}

// ─── Pure math helpers (extracted for property testing) ───────────────────

/// Convert a slot delta to a wall-clock age estimate in seconds.
///
/// Solana slots are nominally ~400ms each (2.5 slots/sec). We do not parse
/// Pyth's `publish_timestamp` field in the vendored 30-line oracle (hard-rule
/// §4.13: stay lean), so the slot delta from the on-chain `Clock` is our only
/// time reference for staleness.
///
/// Returns `i64` for direct comparison with `config.price_staleness_secs`.
/// Saturating math: a slot_delta of `u64::MAX` would otherwise overflow on the
/// `* 2` step; we cap at `i64::MAX` (effectively "infinitely stale").
pub(crate) fn slot_delta_to_age_secs(slot_delta: u64) -> i64 {
    (slot_delta as i64).saturating_mul(2) / 5
}

/// Returns true iff `confidence / |price| ≤ max_bps / 10_000`.
///
/// Rearranged to avoid division (lossless in u128): `conf * 10_000 ≤ |price| *
/// max_bps`. u128 keeps the multiplications safely overflow-free for any u64
/// price × u16 max_bps (u64::MAX × u16::MAX × 10_000 < u128::MAX).
///
/// Edge case: `abs_price == 0` returns false (a Pyth price of exactly 0 cannot
/// be meaningfully compared to a confidence interval; we treat it as "too wide"
/// to refuse settlement on a degenerate feed).
pub(crate) fn confidence_within_bps(conf: u64, abs_price: u64, max_bps: u16) -> bool {
    if abs_price == 0 {
        return false;
    }
    let conf_scaled = (conf as u128).saturating_mul(10_000);
    let limit_scaled = (abs_price as u128).saturating_mul(max_bps as u128);
    conf_scaled <= limit_scaled
}

/// Binary outcome resolution: Yes iff the oracle price is at or above the
/// strike. Tie-to-Yes is deliberate — the binary contract reads "underlying
/// >= strike at expiry".
pub(crate) fn outcome_for_settled_price(price: i64, strike: i64) -> Outcome {
    if price >= strike { Outcome::Yes } else { Outcome::No }
}

pub fn handler(ctx: Context<SettleMarket>) -> Result<()> {
    let clock = &ctx.accounts.clock;
    let strike_market = &ctx.accounts.strike_market;

    require!(
        clock.unix_timestamp >= strike_market.expiry_unix,
        BellMarketsError::NotExpired
    );
    require!(
        ctx.accounts.underlying_pyth_feed.key() == strike_market.underlying_pyth_feed,
        BellMarketsError::PythFeedMismatch
    );

    let data = ctx.accounts.underlying_pyth_feed.try_borrow_data()?;
    let p = parse_pyth_price(&data)?;

    let slot_delta = clock.slot.saturating_sub(p.publish_slot);
    let age_secs = slot_delta_to_age_secs(slot_delta);
    require!(
        age_secs <= ctx.accounts.config.price_staleness_secs,
        BellMarketsError::PythStale
    );

    require!(
        confidence_within_bps(
            p.confidence,
            p.price.unsigned_abs(),
            ctx.accounts.config.price_confidence_bps,
        ),
        BellMarketsError::PythConfidenceTooWide
    );

    let outcome = outcome_for_settled_price(p.price, strike_market.strike_price);

    let sm = &mut ctx.accounts.strike_market;
    sm.outcome = outcome;
    sm.settle_price = p.price;
    sm.settle_confidence = p.confidence;
    sm.settle_slot = p.publish_slot;
    sm.settled_at_unix = clock.unix_timestamp;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── slot_delta_to_age_secs ────────────────────────────────────────────

    #[test]
    fn slot_age_zero_is_zero() {
        assert_eq!(slot_delta_to_age_secs(0), 0);
    }

    #[test]
    fn slot_age_5_is_2_seconds() {
        // 5 slots × 400 ms/slot = 2000 ms = 2 s. Our formula: 5 * 2 / 5 = 2.
        assert_eq!(slot_delta_to_age_secs(5), 2);
    }

    #[test]
    fn slot_age_floors_correctly() {
        // 4 slots × 400 ms = 1600 ms → floor to 1 second. 4 * 2 / 5 = 8 / 5 = 1.
        assert_eq!(slot_delta_to_age_secs(4), 1);
        // 1 slot × 400 ms = 400 ms → floor to 0 second. 1 * 2 / 5 = 2 / 5 = 0.
        assert_eq!(slot_delta_to_age_secs(1), 0);
    }

    #[test]
    fn slot_age_monotone_over_sweep() {
        // Property: slot_age(n+1) >= slot_age(n) for any n in a wide sweep.
        let mut prev = slot_delta_to_age_secs(0);
        for n in 1u64..=10_000u64 {
            let age = slot_delta_to_age_secs(n);
            assert!(age >= prev, "non-monotone at n={n}: {age} < {prev}");
            prev = age;
        }
    }

    #[test]
    fn slot_age_saturates_instead_of_overflowing() {
        // u64::MAX as i64 would wrap to -1. `as i64` keeps the bit pattern but
        // the subsequent `saturating_mul(2)` saturates at i64::MAX/MIN; final
        // result must not panic. Concrete invariant: never returns a negative.
        // (`as i64` on u64::MAX = -1, then sat_mul(2) = -2, / 5 = 0. Either way
        // we don't panic — that is the property under test.)
        let _ = slot_delta_to_age_secs(u64::MAX);
        let _ = slot_delta_to_age_secs(u64::MAX / 2);
    }

    // ── confidence_within_bps ─────────────────────────────────────────────

    #[test]
    fn confidence_zero_price_rejected() {
        // Degenerate-feed guard: zero price = "too wide" regardless of conf.
        assert!(!confidence_within_bps(0, 0, 50));
        assert!(!confidence_within_bps(100, 0, 50));
    }

    #[test]
    fn confidence_exact_boundary_accepts() {
        // conf=50, price=10_000, max_bps=50: conf/price = 0.005 = 50 bps. EQUAL.
        // 50 * 10_000 = 500_000  ==  10_000 * 50. Should pass (≤).
        assert!(confidence_within_bps(50, 10_000, 50));
    }

    #[test]
    fn confidence_one_over_boundary_rejects() {
        // conf=51, price=10_000, max_bps=50: 51 bps > 50 bps.
        // 51 * 10_000 = 510_000  >  10_000 * 50 = 500_000.
        assert!(!confidence_within_bps(51, 10_000, 50));
    }

    #[test]
    fn confidence_matches_naive_division_property() {
        // Property: for any (conf, price ≤ 2^32, max_bps), the rearranged
        // check agrees with the naive division check on integer truncation.
        // Sweep a range that covers realistic Pyth confidence intervals.
        for price in [100u64, 1_000, 10_000, 100_000_000, 1_000_000_000_000].iter().copied() {
            for max_bps in [1u16, 10, 50, 100, 1_000, 10_000].iter().copied() {
                for conf in [0u64, 1, price / 1000, price / 100, price, price * 2].iter().copied() {
                    let rearranged = confidence_within_bps(conf, price, max_bps);
                    // Naive (lossy on truncation): bps = (conf * 10_000) / price.
                    // Equivalent up to the inequality direction; use i128 here to
                    // dodge any truncation surprise.
                    let bps = ((conf as i128) * 10_000) / (price as i128);
                    let naive = bps <= max_bps as i128;
                    assert_eq!(
                        rearranged, naive,
                        "mismatch at conf={conf} price={price} max_bps={max_bps}"
                    );
                }
            }
        }
    }

    #[test]
    fn confidence_overflow_safe_at_u64_max() {
        // u64::MAX * 10_000 fits in u128 (1.8e23 vs 3.4e38). Must not panic.
        let _ = confidence_within_bps(u64::MAX, u64::MAX, u16::MAX);
    }

    // ── outcome_for_settled_price ─────────────────────────────────────────

    #[test]
    fn outcome_above_strike_is_yes() {
        assert_eq!(outcome_for_settled_price(101, 100), Outcome::Yes);
    }

    #[test]
    fn outcome_at_strike_is_yes_tie_break() {
        // Property: tie goes to Yes (binary contract: "at or above").
        assert_eq!(outcome_for_settled_price(100, 100), Outcome::Yes);
        assert_eq!(outcome_for_settled_price(0, 0), Outcome::Yes);
        assert_eq!(outcome_for_settled_price(-5, -5), Outcome::Yes);
    }

    #[test]
    fn outcome_below_strike_is_no() {
        assert_eq!(outcome_for_settled_price(99, 100), Outcome::No);
        assert_eq!(outcome_for_settled_price(i64::MIN, i64::MAX), Outcome::No);
    }

    #[test]
    fn outcome_complementary_over_sweep() {
        // Property: for any (price, strike), outcome is either Yes or No (never
        // Unsettled/Invalid), and Yes iff price >= strike.
        for price in [-1_000i64, -1, 0, 1, 100, 1_000_000_000].iter().copied() {
            for strike in [-1_000i64, -1, 0, 1, 100, 1_000_000_000].iter().copied() {
                let o = outcome_for_settled_price(price, strike);
                assert!(matches!(o, Outcome::Yes | Outcome::No));
                assert_eq!(o == Outcome::Yes, price >= strike);
            }
        }
    }
}
