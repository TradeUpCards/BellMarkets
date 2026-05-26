//! `create_strike_market` — spawn one `StrikeMarket` PDA for a (pyth_feed,
//! expiry, strike_price) tuple. Admin-only.
//!
//! The instruction does four things in order:
//!   1. Validate strike > 0 and expiry > now.
//!   2. Verify the supplied Phoenix v1 market account by its 8-byte
//!      `MarketHeader.discriminant` prefix (loud-fails if not a real Phoenix
//!      market — see `adapters/phoenix.rs` for the upstream-verified value).
//!   3. Initialize three SPL accounts (YES mint, NO mint, USDC vault) as
//!      PDAs whose authority is the new `strike_market` PDA itself.
//!   4. Compute the admin-override-eligibility timestamp (= expiry + delay,
//!      checked add).
//!
//! All bump seeds are persisted so downstream instructions can construct
//! signer seeds without re-deriving via `Pubkey::find_program_address` (slow
//! in BPF).

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::adapters::phoenix::verify_phoenix_market;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
#[instruction(strike_price: i64, expiry_unix: i64)]
pub struct CreateStrikeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = usdc_mint,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        init,
        payer = admin,
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

    /// CHECK: Pyth price feed. Validated at settle time via vendored parser
    /// in oracle::parse_pyth_price. At creation we only bind its pubkey into
    /// the market state.
    pub underlying_pyth_feed: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"yes", strike_market.key().as_ref()],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = strike_market,
    )]
    pub yes_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"no", strike_market.key().as_ref()],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = strike_market,
    )]
    pub no_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault", strike_market.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = strike_market,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    pub usdc_mint: Box<Account<'info, Mint>>,

    /// CHECK: Phoenix v1 FIFO market — validated by 8-byte magic prefix in
    /// the handler via verify_phoenix_market. Per kickoff §4.12, this must
    /// remain UncheckedAccount (Phoenix is not an Anchor program; Account<T>
    /// would fail the discriminator check).
    pub phoenix_market: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

/// Compute the admin-override-eligibility timestamp = expiry + delay.
/// Returns `None` on i64 overflow so the handler can map to `MathOverflow`.
/// Extracted to make the overflow contract directly property-testable.
pub(crate) fn override_eligible_at(expiry_unix: i64, delay_secs: i64) -> Option<i64> {
    expiry_unix.checked_add(delay_secs)
}

pub fn handler(
    ctx: Context<CreateStrikeMarket>,
    strike_price: i64,
    expiry_unix: i64,
) -> Result<()> {
    require!(strike_price > 0, BellMarketsError::InvalidStrikePrice);
    let now = Clock::get()?.unix_timestamp;
    require!(expiry_unix > now, BellMarketsError::ExpiryInPast);
    require!(
        expiry_unix.saturating_sub(now) <= MAX_EXPIRY_HORIZON_SECS,
        BellMarketsError::ExpiryTooFar
    );
    // deploy_index=9: admin path intentionally elides the
    // `expiry_is_market_close_time` check that `user_create_strike_market`
    // enforces. Admin is trusted to spawn strikes at arbitrary expiries
    // for compressed-time simulation (short-expiry smoke tests, settlement
    // dry-runs, post-mortem replays). User path retains the close-time guard
    // as typo protection for permissionless callers.

    verify_phoenix_market(&ctx.accounts.phoenix_market.to_account_info())?;

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
    // DR-005: admin-pathed creation marks creator as zero pubkey. Distinguishes
    // admin-spawned markets from user_create_strike_market (where creator =
    // signer pubkey) for the DR-008 creator-rebate path in mint_pair.
    sm.creator = Pubkey::default();
    sm.pairs_outstanding = 0;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_zero_plus_zero_is_zero() {
        assert_eq!(override_eligible_at(0, 0), Some(0));
    }

    #[test]
    fn override_typical_one_hour_delay() {
        // 1_700_000_000 (a 2023 timestamp) + 3600 = 1_700_003_600.
        assert_eq!(override_eligible_at(1_700_000_000, 3_600), Some(1_700_003_600));
    }

    #[test]
    fn override_returns_none_on_positive_overflow() {
        assert_eq!(override_eligible_at(i64::MAX, 1), None);
        assert_eq!(override_eligible_at(i64::MAX - 5, 10), None);
    }

    #[test]
    fn override_returns_none_on_negative_overflow() {
        // Delay should always be positive (enforced by initialize_config bounds
        // = MAX_ADMIN_OVERRIDE_DELAY_SECS = 7 days), but if a future bug allowed
        // a negative delay this guards us.
        assert_eq!(override_eligible_at(i64::MIN, -1), None);
        assert_eq!(override_eligible_at(i64::MIN + 5, -10), None);
    }

    #[test]
    fn override_property_round_trip_within_safe_range() {
        // Property: for any (expiry, delay) where both are within a reasonable
        // range (no overflow), override - delay == expiry. Roundtrip check.
        for expiry in [0i64, 1, 1_700_000_000, i64::MAX / 2 - 1].iter().copied() {
            for delay in [0i64, 1, 3600, 86_400, 7 * 86_400].iter().copied() {
                let oe = override_eligible_at(expiry, delay).expect("safe range");
                assert_eq!(oe - delay, expiry, "expiry={expiry} delay={delay}");
            }
        }
    }
}
