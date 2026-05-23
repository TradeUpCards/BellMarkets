//! `update_fee_config` — admin updater for the DR-008 + DR-010 economic
//! parameters stored on the `FeeConfig` PDA. All params re-validated by
//! `validate_fee_params` (also reused by `initialize_fee_config`) so the
//! sum-to-10000 + bps-bound invariants are enforced symmetrically across
//! init and update paths.
//!
//! Demo narrative knob: admin can promo-mode by flipping `platform_retain_bps`
//! to 0 + raising weekly/monthly pool bps. See DR-010 § "Promo mode example".

use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
        constraint = !config.paused @ BellMarketsError::Paused,
    )]
    pub config: Box<Account<'info, MarketConfig>>,

    #[account(
        mut,
        seeds = [b"fee_config"],
        bump = fee_config.bump,
        constraint = fee_config.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub fee_config: Box<Account<'info, FeeConfig>>,
}

pub fn handler(
    ctx: Context<UpdateFeeConfig>,
    mint_fee_bps: u16,
    platform_retain_bps: u16,
    weekly_pool_bps: u16,
    monthly_pool_bps: u16,
    creator_rebate_bps: u16,
    force_redeem_grace_secs: i64,
    weekly_distribution_bps: [u16; 10],
    monthly_distribution_bps: [u16; 10],
) -> Result<()> {
    validate_fee_params(
        mint_fee_bps,
        platform_retain_bps,
        weekly_pool_bps,
        monthly_pool_bps,
        creator_rebate_bps,
        force_redeem_grace_secs,
        &weekly_distribution_bps,
        &monthly_distribution_bps,
    )?;

    let fc = &mut ctx.accounts.fee_config;
    fc.mint_fee_bps = mint_fee_bps;
    fc.platform_retain_bps = platform_retain_bps;
    fc.weekly_pool_bps = weekly_pool_bps;
    fc.monthly_pool_bps = monthly_pool_bps;
    fc.creator_rebate_bps = creator_rebate_bps;
    fc.force_redeem_grace_secs = force_redeem_grace_secs;
    fc.weekly_distribution_bps = weekly_distribution_bps;
    fc.monthly_distribution_bps = monthly_distribution_bps;
    Ok(())
}

/// Shared validator — reused by `initialize_fee_config::handler` and
/// `update_fee_config::handler`. Enforces the DR-008 + DR-010 invariants.
pub fn validate_fee_params(
    mint_fee_bps: u16,
    platform_retain_bps: u16,
    weekly_pool_bps: u16,
    monthly_pool_bps: u16,
    creator_rebate_bps: u16,
    force_redeem_grace_secs: i64,
    weekly_distribution_bps: &[u16; 10],
    monthly_distribution_bps: &[u16; 10],
) -> Result<()> {
    require!(mint_fee_bps <= 10_000, BellMarketsError::InvalidFeeParam);
    require!(creator_rebate_bps <= 10_000, BellMarketsError::InvalidFeeParam);
    require!(force_redeem_grace_secs > 0, BellMarketsError::InvalidFeeParam);

    // DR-010 sum-to-10000 — pool split
    let pool_sum = (platform_retain_bps as u32)
        + (weekly_pool_bps as u32)
        + (monthly_pool_bps as u32);
    require!(pool_sum == 10_000, BellMarketsError::BpsSumMismatch);

    // DR-010 sum-to-10000 — distribution arrays
    let weekly_sum: u32 = weekly_distribution_bps.iter().map(|x| *x as u32).sum();
    require!(weekly_sum == 10_000, BellMarketsError::BpsSumMismatch);
    let monthly_sum: u32 = monthly_distribution_bps.iter().map(|x| *x as u32).sum();
    require!(monthly_sum == 10_000, BellMarketsError::BpsSumMismatch);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_accepts_defaults() {
        // DR-008 + DR-010 default values
        let weekly = [2500u16, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400];
        let monthly = weekly;
        assert!(validate_fee_params(0, 5000, 2500, 2500, 10_000, DEFAULT_FORCE_REDEEM_GRACE_SECS, &weekly, &monthly).is_ok());
    }

    #[test]
    fn validate_accepts_promo_mode() {
        // DR-010 § Promo mode: 1% fee, 0% platform, 50/50 pools
        let pool_split = [5000u16, 5000, 0, 0, 0, 0, 0, 0, 0, 0];
        assert!(validate_fee_params(100, 0, 5000, 5000, 10_000, 86_400, &pool_split, &pool_split).is_ok());
    }

    #[test]
    fn validate_rejects_pool_sum_off_by_one() {
        let weekly = [2500u16, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400];
        // 5001 + 2500 + 2500 = 10001
        assert!(validate_fee_params(0, 5001, 2500, 2500, 10_000, 86_400, &weekly, &weekly).is_err());
        // 5000 + 2500 + 2499 = 9999
        assert!(validate_fee_params(0, 5000, 2500, 2499, 10_000, 86_400, &weekly, &weekly).is_err());
    }

    #[test]
    fn validate_rejects_weekly_distribution_sum_wrong() {
        let pool_split = [5000u16, 2500, 2500, 0, 0, 0, 0, 0, 0, 0];
        // sum = 5000 + 2500 + 2500 = 10000 ✓ for pool split shape
        // But as a distribution it should also sum to 10000 — works for this case
        let bad_weekly = [3000u16, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400]; // sum = 10500
        assert!(validate_fee_params(0, 5000, 2500, 2500, 10_000, 86_400, &bad_weekly, &pool_split).is_err());
    }

    #[test]
    fn validate_rejects_mint_fee_over_max() {
        let weekly = [2500u16, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400];
        assert!(validate_fee_params(10_001, 5000, 2500, 2500, 10_000, 86_400, &weekly, &weekly).is_err());
    }

    #[test]
    fn validate_rejects_rebate_over_max() {
        let weekly = [2500u16, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400];
        assert!(validate_fee_params(200, 5000, 2500, 2500, 10_001, 86_400, &weekly, &weekly).is_err());
    }

    #[test]
    fn validate_rejects_zero_or_negative_grace() {
        let weekly = [2500u16, 1800, 1200, 1000, 800, 700, 600, 500, 500, 400];
        assert!(validate_fee_params(0, 5000, 2500, 2500, 10_000, 0, &weekly, &weekly).is_err());
        assert!(validate_fee_params(0, 5000, 2500, 2500, 10_000, -1, &weekly, &weekly).is_err());
    }
}
