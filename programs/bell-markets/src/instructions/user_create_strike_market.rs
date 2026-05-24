//! `user_create_strike_market` — permissionless variant of
//! `create_strike_market`. Per DR-005: first user to want to trade a strike
//! pays the ~$0.90 SOL rent to spawn the `StrikeMarket` PDA + YES/NO mints +
//! USDC vault. Platform funds zero working capital for strike PDAs.
//!
//! On-chain enforcement against malicious / nonsensical strikes:
//!   1. Strike is aligned to `TickerConfig.strike_tick_size` grid
//!   2. Strike is within ±`max_user_strike_deviation_bps` of LIVE Pyth spot
//!      (read via vendored parser; full staleness + confidence gates apply)
//!   3. Expiry is exactly 1:00 PM ET or 4:00 PM ET (half-day or full-day close,
//!      either EDT or EST) — modular check against UTC seconds-since-midnight
//!   4. Expiry is in the future + within MAX_EXPIRY_HORIZON_SECS (7 days)
//!   5. Phoenix market magic-prefix passes (same check as admin path)
//!
//! `creator` is set to the signer pubkey. Used by DR-008 fee path in
//! `mint_pair` to identify creator-rebate eligibility.
//!
//! Pure-math helpers (`strike_within_deviation`, `strike_aligned_to_tick`,
//! `expiry_is_market_close_time`) extracted for property testing.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::adapters::phoenix::verify_phoenix_market;
use crate::errors::BellMarketsError;
use crate::oracle::parse_pyth_price;
use crate::instructions::create_strike_market::override_eligible_at;
use crate::instructions::settle_market::{slot_delta_to_age_secs, confidence_within_bps};

// ─── Pure math helpers ──────────────────────────────────────────────────────

/// Returns true iff `|strike - spot| / |spot| ≤ max_bps / 10_000`.
///
/// Rearranged to dodge division (mirrors `confidence_within_bps` pattern).
/// `spot` and `strike` are both in the same scaled-i64 unit (Pyth feed
/// exponent applied). u128 keeps the multiplication safe for any realistic
/// price range.
///
/// Edge cases: `spot == 0` returns false (degenerate feed; cannot compute
/// percentage). Negative spot is rejected at the call site
/// (`PythNegativePrice`).
pub(crate) fn strike_within_deviation(strike: i64, spot: i64, max_bps: u16) -> bool {
    if spot <= 0 {
        return false;
    }
    let diff = (strike as i128 - spot as i128).unsigned_abs();
    let abs_spot = (spot as i128).unsigned_abs();
    let limit_scaled = abs_spot.saturating_mul(max_bps as u128);
    diff.saturating_mul(10_000) <= limit_scaled
}

/// Returns true iff `strike` is a multiple of `tick_size` (signed).
///
/// `tick_size <= 0` returns false (defensive — `rem_euclid` on zero panics,
/// and a non-positive tick is meaningless). Negative strikes are technically
/// permitted (rem_euclid handles them) but the calling instruction rejects
/// strike <= 0 separately.
pub(crate) fn strike_aligned_to_tick(strike: i64, tick_size: i64) -> bool {
    if tick_size <= 0 {
        return false;
    }
    strike.rem_euclid(tick_size) == 0
}

/// Returns true iff `expiry_unix` falls at exactly 1:00 PM ET or 4:00 PM ET,
/// in either EDT (UTC-4, summer) or EST (UTC-5, winter).
///
/// Computed via UTC seconds-since-midnight modulo:
///   - 1 PM ET EDT = 17:00 UTC = 61_200 s
///   - 1 PM ET EST = 18:00 UTC = 64_800 s
///   - 4 PM ET EDT = 20:00 UTC = 72_000 s
///   - 4 PM ET EST = 21:00 UTC = 75_600 s
///
/// The program does NOT check which timezone is active (Bram's off-chain
/// calendar resolves that); on-chain we only verify the expiry hits one of the
/// recognized close times. This catches typos (e.g., 4:00 AM, 3:00 PM) while
/// staying simple — no DST table on chain (per DR-007).
pub(crate) fn expiry_is_market_close_time(expiry_unix: i64) -> bool {
    if expiry_unix < 0 {
        return false;
    }
    let secs_in_day = expiry_unix.rem_euclid(86_400);
    matches!(secs_in_day, 61_200 | 64_800 | 72_000 | 75_600)
}

// ─── Accounts ───────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(strike_price: i64, expiry_unix: i64)]
pub struct UserCreateStrikeMarket<'info> {
    /// Rent payer. Signs but holds no privileged role beyond paying.
    /// `creator` is set to this signer's pubkey.
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        seeds = [b"ticker", underlying_pyth_feed.key().as_ref()],
        bump = ticker_config.bump,
        constraint = ticker_config.pyth_feed == underlying_pyth_feed.key()
            @ BellMarketsError::TickerConfigFeedMismatch,
    )]
    pub ticker_config: Box<Account<'info, TickerConfig>>,

    #[account(
        init,
        payer = user,
        space = StrikeMarket::LEN,
        seeds = [
            b"strike",
            underlying_pyth_feed.key().as_ref(),
            &expiry_unix.to_le_bytes(),
            &strike_price.to_le_bytes(),
        ],
        bump,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    /// CHECK: Pyth price feed. Validated by `parse_pyth_price` in the handler
    /// (magic / version / atype / status / staleness / confidence). Pubkey is
    /// bound into `strike_market.underlying_pyth_feed`.
    pub underlying_pyth_feed: UncheckedAccount<'info>,

    #[account(
        init,
        payer = user,
        seeds = [b"yes", strike_market.key().as_ref()],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = strike_market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = user,
        seeds = [b"no", strike_market.key().as_ref()],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = strike_market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = user,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: Phoenix v1 FIFO market — validated by 8-byte magic prefix in
    /// the handler via verify_phoenix_market. Per kickoff §4.12, this remains
    /// UncheckedAccount (Phoenix is not an Anchor program; Account<T> would
    /// fail the discriminator check).
    pub phoenix_market: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<UserCreateStrikeMarket>,
    strike_price: i64,
    expiry_unix: i64,
) -> Result<()> {
    // ── Static validation: strike + expiry shape ────────────────────────
    require!(strike_price > 0, BellMarketsError::InvalidStrikePrice);

    let clock = &ctx.accounts.clock;
    let now = clock.unix_timestamp;
    require!(expiry_unix > now, BellMarketsError::ExpiryInPast);
    require!(
        expiry_unix.saturating_sub(now) <= MAX_EXPIRY_HORIZON_SECS,
        BellMarketsError::ExpiryTooFar
    );
    require!(
        expiry_is_market_close_time(expiry_unix),
        BellMarketsError::ExpiryNotMarketClose
    );

    // ── Tick alignment + Phoenix prefix ─────────────────────────────────
    let tc = &ctx.accounts.ticker_config;
    require!(
        strike_aligned_to_tick(strike_price, tc.strike_tick_size),
        BellMarketsError::StrikeTickMisaligned
    );
    verify_phoenix_market(&ctx.accounts.phoenix_market.to_account_info())?;

    // ── Pyth read: full staleness + confidence + status gates ───────────
    let data = ctx.accounts.underlying_pyth_feed.try_borrow_data()?;
    let p = parse_pyth_price(&data)?;
    require!(p.price > 0, BellMarketsError::PythNegativePrice);

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

    // ── Deviation cap against live spot ─────────────────────────────────
    require!(
        strike_within_deviation(strike_price, p.price, tc.max_user_strike_deviation_bps),
        BellMarketsError::StrikeOutsideDeviationCap
    );

    // ── PDA + state init ────────────────────────────────────────────────
    let override_eligible_at = override_eligible_at(
        expiry_unix,
        ctx.accounts.config.admin_override_delay_secs,
    )
    .ok_or(BellMarketsError::MathOverflow)?;

    let sm = &mut ctx.accounts.strike_market;
    sm.config = ctx.accounts.config.key();
    sm.underlying_pyth_feed = ctx.accounts.underlying_pyth_feed.key();
    sm.strike_price = strike_price;
    sm.expiry_unix = expiry_unix;
    sm.yes_mint = ctx.accounts.yes_mint.key();
    sm.no_mint = ctx.accounts.no_mint.key();
    sm.usdc_vault = ctx.accounts.usdc_vault.key();
    sm.phoenix_market = ctx.accounts.phoenix_market.key();
    sm.settle_price = 0;
    sm.settle_confidence = 0;
    sm.settle_slot = 0;
    sm.settled_at_unix = 0;
    sm.outcome = Outcome::Unsettled;
    sm.admin_override_eligible_at = override_eligible_at;
    sm.bump = ctx.bumps.strike_market;
    sm.yes_mint_bump = ctx.bumps.yes_mint;
    sm.no_mint_bump = ctx.bumps.no_mint;
    sm.vault_bump = ctx.bumps.usdc_vault;
    // DR-005: user-pathed creation marks creator as the signer.
    sm.creator = ctx.accounts.user.key();
    sm.pairs_outstanding = 0;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── strike_within_deviation ────────────────────────────────────────

    #[test]
    fn deviation_exact_boundary_accepts() {
        // strike=110, spot=100, max_bps=1000 (10%). |110-100|/100 = 10%. Equal.
        // 10 * 10_000 = 100_000  ==  100 * 1000. Should pass (≤).
        assert!(strike_within_deviation(110, 100, 1_000));
        // Symmetric below: strike=90 against spot=100 at 10%
        assert!(strike_within_deviation(90, 100, 1_000));
    }

    #[test]
    fn deviation_one_over_boundary_rejects() {
        // strike=111, spot=100, max_bps=1000 (10%). |111-100|/100 = 11%.
        assert!(!strike_within_deviation(111, 100, 1_000));
        // Symmetric below
        assert!(!strike_within_deviation(89, 100, 1_000));
    }

    #[test]
    fn deviation_zero_spot_rejected() {
        // Degenerate-feed guard: zero spot rejects any strike.
        assert!(!strike_within_deviation(50, 0, 1_000));
        assert!(!strike_within_deviation(0, 0, 1_000));
    }

    #[test]
    fn deviation_negative_spot_rejected() {
        // Negative spot should never reach the helper (the call site rejects
        // via PythNegativePrice), but defensive: returns false.
        assert!(!strike_within_deviation(50, -100, 1_000));
    }

    #[test]
    fn deviation_realistic_meta_scaled_values() {
        // META spot $609.34 at expo -8 = 60_934_000_000. Max dev 3000 bps (30%).
        // Outer boundary: 60_934_000_000 * 1.30 = 79_214_200_000.
        let spot: i64 = 60_934_000_000;
        let max_bps: u16 = 3_000;
        assert!(strike_within_deviation(spot, spot, max_bps));        // exact match
        assert!(strike_within_deviation(79_214_200_000, spot, max_bps));  // +30% exact
        assert!(!strike_within_deviation(79_214_200_001, spot, max_bps)); // +30%+1 unit
        assert!(strike_within_deviation(42_653_800_000, spot, max_bps));  // -30% exact
        assert!(!strike_within_deviation(42_653_799_999, spot, max_bps)); // -30%-1 unit
    }

    #[test]
    fn deviation_overflow_safe_at_extreme_values() {
        // i64::MAX / 2 to leave room for the subtraction; u16::MAX max_bps.
        // Must not panic.
        let _ = strike_within_deviation(i64::MAX / 2, i64::MAX / 2 - 1, u16::MAX);
        let _ = strike_within_deviation(i64::MIN / 2, 1, u16::MAX);
        let _ = strike_within_deviation(i64::MAX, 1, u16::MAX);
    }

    // ── strike_aligned_to_tick ─────────────────────────────────────────

    #[test]
    fn tick_alignment_accepts_multiples() {
        // Strike $230 with $5 tick at expo -8: strike=23_000_000_000, tick=500_000_000.
        // 23_000_000_000 % 500_000_000 = 0. Aligned.
        assert!(strike_aligned_to_tick(23_000_000_000, 500_000_000));
        // Strike $230.50 (NOT a multiple of $5): 23_050_000_000 % 500_000_000 = 50_000_000.
        assert!(!strike_aligned_to_tick(23_050_000_000, 500_000_000));
    }

    #[test]
    fn tick_alignment_accepts_zero_strike_at_any_tick() {
        // 0 % anything == 0. (Strike 0 would be rejected by InvalidStrikePrice
        // upstream; helper itself returns true.)
        assert!(strike_aligned_to_tick(0, 100));
    }

    #[test]
    fn tick_alignment_rejects_nonpositive_tick() {
        // tick=0 would panic on rem_euclid; negative tick is meaningless.
        assert!(!strike_aligned_to_tick(100, 0));
        assert!(!strike_aligned_to_tick(100, -5));
    }

    #[test]
    fn tick_alignment_handles_negative_strikes() {
        // Defensive — strike < 0 is rejected upstream, but rem_euclid is
        // signed-safe.
        assert!(strike_aligned_to_tick(-15, 5));
        assert!(!strike_aligned_to_tick(-13, 5));
    }

    // ── expiry_is_market_close_time ────────────────────────────────────

    #[test]
    fn expiry_close_accepts_1pm_et_edt() {
        // 1 PM ET EDT = 17:00 UTC. Pick an arbitrary day in 2026: Mon May 25 2026
        // 17:00 UTC = 1748192400.
        assert!(expiry_is_market_close_time(1_748_192_400));
        // Pure modular check: any day at 61_200 s past midnight
        assert!(expiry_is_market_close_time(61_200));
        assert!(expiry_is_market_close_time(86_400 + 61_200));
    }

    #[test]
    fn expiry_close_accepts_1pm_et_est() {
        // 1 PM ET EST = 18:00 UTC = 64_800 s past midnight
        assert!(expiry_is_market_close_time(64_800));
        assert!(expiry_is_market_close_time(86_400 * 30 + 64_800));
    }

    #[test]
    fn expiry_close_accepts_4pm_et_edt() {
        // 4 PM ET EDT = 20:00 UTC = 72_000 s
        assert!(expiry_is_market_close_time(72_000));
        // Mon May 25 2026 20:00 UTC = 1748203200
        assert!(expiry_is_market_close_time(1_748_203_200));
    }

    #[test]
    fn expiry_close_accepts_4pm_et_est() {
        // 4 PM ET EST = 21:00 UTC = 75_600 s
        assert!(expiry_is_market_close_time(75_600));
        assert!(expiry_is_market_close_time(86_400 * 100 + 75_600));
    }

    #[test]
    fn expiry_close_rejects_off_hours() {
        // 9:30 AM ET = open; 12:00 PM ET = lunch; 3:00 PM ET = pre-close.
        // None are recognized closes.
        assert!(!expiry_is_market_close_time(0));         // midnight UTC
        assert!(!expiry_is_market_close_time(50_400));    // 14:00 UTC = 10 AM ET EDT
        assert!(!expiry_is_market_close_time(57_600));    // 16:00 UTC = noon ET EDT
        assert!(!expiry_is_market_close_time(68_400));    // 19:00 UTC = 3 PM ET EDT (off by 1 hr from valid 1 PM EST!)
        // (Note: 19:00 UTC = 2 PM EST = 3 PM EDT. NOT a market close.)
        assert!(!expiry_is_market_close_time(61_201));    // 1 PM ET EDT + 1 sec
        assert!(!expiry_is_market_close_time(72_001));    // 4 PM ET EDT + 1 sec
    }

    #[test]
    fn expiry_close_rejects_negative_timestamp() {
        // Defensive: a negative expiry should fail upstream but also here.
        assert!(!expiry_is_market_close_time(-1));
        assert!(!expiry_is_market_close_time(-61_200));
    }

    #[test]
    fn expiry_close_property_only_four_valid_modular_values() {
        // Property: across an entire day's worth of seconds, exactly 4 values
        // pass the close-time check (61200, 64800, 72000, 75600).
        let valid: Vec<i64> = (0..86_400)
            .filter(|s| expiry_is_market_close_time(*s))
            .collect();
        assert_eq!(valid, vec![61_200, 64_800, 72_000, 75_600]);
    }

    /// ADVERSARIAL: someone tries to spawn a strike market that expires at
    /// US-equity MARKET OPEN (9:30 AM ET) instead of close. Under the user
    /// path, this could let the spawner mint pairs at open and trade in a
    /// market that "expires" mere seconds after creation — settling against
    /// whatever Pyth spot happens to be at that moment, before normal price
    /// discovery has occurred for the session.
    ///
    /// 9:30 AM ET UTC seconds-since-midnight values:
    ///   - EDT (UTC-4): 13:30 UTC = 48_600 s
    ///   - EST (UTC-5): 14:30 UTC = 52_200 s
    ///
    /// DR-007 locks expiries to 1 PM ET or 4 PM ET (close times only).
    /// `expiry_is_market_close_time` rejects both open-time values + a
    /// pre-market value (4:00 AM ET = 8:00 UTC = 28_800 s) + after-hours
    /// (7:00 PM ET = 23:00 UTC = 82_800 s).
    #[test]
    fn user_create_strike_at_market_open_rejected_adversarial() {
        // 9:30 AM ET EDT = 13:30 UTC = 48_600 s past midnight
        assert!(
            !expiry_is_market_close_time(48_600),
            "expiry at 9:30 AM ET EDT (market OPEN) MUST be rejected per DR-007"
        );

        // 9:30 AM ET EST = 14:30 UTC = 52_200 s
        assert!(
            !expiry_is_market_close_time(52_200),
            "expiry at 9:30 AM ET EST MUST be rejected per DR-007"
        );

        // Same day, multiple days into the epoch — modular check stays consistent.
        for day_idx in [0i64, 1, 100, 10_000].iter().copied() {
            let day_secs = day_idx * 86_400;
            assert!(!expiry_is_market_close_time(day_secs + 48_600),
                "day {day_idx}: 9:30 AM EDT rejected");
            assert!(!expiry_is_market_close_time(day_secs + 52_200),
                "day {day_idx}: 9:30 AM EST rejected");
        }

        // --- Other adversarial off-hours expiries (should all be rejected):
        let off_hours_secs = [
            ("pre-market 4 AM ET EDT", 8 * 3600),         // 28_800
            ("pre-market 4 AM ET EST", 9 * 3600),         // 32_400
            ("market open 9:30 AM ET EDT", 13 * 3600 + 30 * 60), // 48_600
            ("noon 12 PM ET EDT",       16 * 3600),         // 57_600
            ("after-hours 7 PM ET EDT", 23 * 3600),         // 82_800
            ("midnight UTC",            0i64),
            ("11:59 PM UTC",            86_399),
            ("3 PM ET EDT (pre-close)", 19 * 3600),         // 68_400 — common bait
            ("4:01 PM ET EDT (right after close)", 20 * 3600 + 60), // 72_060
        ];
        for &(name, secs) in &off_hours_secs {
            assert!(
                !expiry_is_market_close_time(secs),
                "off-hours expiry {name} (={secs} s past midnight UTC) MUST be rejected"
            );
        }

        // --- Sanity contrast: the 4 valid close times all accept.
        assert!(expiry_is_market_close_time(61_200), "1 PM ET EDT close accepts");
        assert!(expiry_is_market_close_time(64_800), "1 PM ET EST close accepts");
        assert!(expiry_is_market_close_time(72_000), "4 PM ET EDT close accepts");
        assert!(expiry_is_market_close_time(75_600), "4 PM ET EST close accepts");
    }
}
