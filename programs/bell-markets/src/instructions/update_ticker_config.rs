//! `update_ticker_config` — admin-only updater for per-ticker DR-005/DR-006
//! parameters. One `TickerConfig` PDA per Pyth feed (seed = [b"ticker",
//! pyth_feed]). Uses `init_if_needed` so the first call per-feed creates the
//! PDA; subsequent calls update fields in place.
//!
//! Read by `user_create_strike_market`:
//!   - `max_user_strike_deviation_bps` — loose cap on user-proposed strikes
//!     (measured against LIVE Pyth spot at create time)
//!   - `strike_tick_size` — grid alignment (same scaled-i64 units as
//!     `StrikeMarket.strike_price`)
//!
//! Read by off-chain (Bram's cron): `cap_center`, `allowed_strikes`,
//! `threshold_bps`. The on-chain user_create path does NOT check
//! `allowed_strikes` membership (that's UX scope; on-chain enforcement is
//! tick-alignment + live-spot deviation cap — sufficient to bound malicious
//! strikes per DR-005's design).

use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

// Outer bounds — see initialize_config.rs for the rationale pattern.
//   - deviation_bps must be > 0 (zero would reject every strike) and ≤ 5000
//     (50% would allow nearly any strike against a normal feed; DR-005 table
//     tops out at 3000 = 30% for NVDA/META/TSLA + DR-011 earnings-eve expansion
//     to 50% for the same tickers → 5000 is the operational ceiling)
//   - tick_size must be > 0 (rem_euclid by 0 panics)
//   - threshold_bps follows the same bounds as deviation (informational)
//   - strike_count must be > 0 AND ≤ MAX_ALLOWED_STRIKES
//     (strike_count > 0: post-P1 audit footgun guard — DR-006 phase-1/2/3
//     cron updates fire every 30 min during AH/PM windows, so a time-based
//     staleness lock would break legitimate updates. Instead we require the
//     grid never go to zero in a single update — admin must explicitly pause
//     via `pause` ix if they want to halt new markets for a ticker, which
//     surfaces intent unambiguously vs. a silent grid wipe.)
//     (≤ MAX_ALLOWED_STRIKES: compile-time enforced by [i64; MAX_ALLOWED_STRIKES];
//     we still validate the runtime count.)
pub const MAX_DEVIATION_BPS: u16 = 5_000;
pub const MAX_THRESHOLD_BPS: u16 = 5_000;

#[derive(Accounts)]
pub struct UpdateTickerConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    /// CHECK: Pyth price feed pubkey — used only as PDA seed material. Not
    /// validated as a parseable Pyth account here; that check fires at
    /// user_create_strike_market time against the live feed account. Off-chain
    /// operator is responsible for binding the right pubkey to the right ticker.
    pub pyth_feed: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = admin,
        space = TickerConfig::LEN,
        seeds = [b"ticker", pyth_feed.key().as_ref()],
        bump,
    )]
    pub ticker_config: Box<Account<'info, TickerConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<UpdateTickerConfig>,
    cap_center: i64,
    allowed_strikes: [i64; MAX_ALLOWED_STRIKES],
    strike_count: u8,
    max_user_strike_deviation_bps: u16,
    strike_tick_size: i64,
    threshold_bps: u16,
) -> Result<()> {
    require!(
        max_user_strike_deviation_bps > 0
            && max_user_strike_deviation_bps <= MAX_DEVIATION_BPS,
        BellMarketsError::InvalidTickerParam
    );
    require!(strike_tick_size > 0, BellMarketsError::InvalidTickerParam);
    require!(
        threshold_bps > 0 && threshold_bps <= MAX_THRESHOLD_BPS,
        BellMarketsError::InvalidTickerParam
    );
    require!(
        strike_count > 0 && (strike_count as usize) <= MAX_ALLOWED_STRIKES,
        BellMarketsError::InvalidTickerParam
    );
    require!(cap_center > 0, BellMarketsError::InvalidTickerParam);

    let now = Clock::get()?.unix_timestamp;
    let tc = &mut ctx.accounts.ticker_config;
    tc.pyth_feed = ctx.accounts.pyth_feed.key();
    tc.cap_center = cap_center;
    tc.allowed_strikes = allowed_strikes;
    tc.strike_count = strike_count;
    tc.max_user_strike_deviation_bps = max_user_strike_deviation_bps;
    tc.strike_tick_size = strike_tick_size;
    tc.threshold_bps = threshold_bps;
    tc.last_updated_unix = now;
    tc.bump = ctx.bumps.ticker_config;
    Ok(())
}
