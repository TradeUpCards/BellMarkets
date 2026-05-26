//! `update_admin_override_delay_secs` — admin ix to retune
//! `MarketConfig.admin_override_delay_secs` without redeploying.
//!
//! Unlocks compressed-time simulation: the 1-hour default delay between
//! `expiry_unix` and `admin_settle` eligibility is the right value in
//! production (give the oracle a window to recover before admin overrides
//! it) but blocks fast smoke tests. Admin can dial it to 0 for a test
//! sequence, run the smoke, dial it back to 3600. Reusable across
//! settlement dry-runs and post-mortem replays.
//!
//! ## Scope of effect
//!
//! Mutates `MarketConfig.admin_override_delay_secs` for FUTURE strikes only.
//! Existing `StrikeMarket.admin_override_eligible_at` fields were computed
//! at create time using whatever delay was active then — they are NOT
//! retroactively recomputed. So the operational pattern is:
//!   1. update_admin_override_delay_secs(0)         — relax for test
//!   2. create_strike_market(...)                    — eligible_at = expiry + 0
//!   3. <wait until expiry>
//!   4. admin_settle(...)                            — immediately eligible
//!   5. update_admin_override_delay_secs(3600)       — restore production default
//!
//! ## Bounds
//!
//! Range [0, MAX_ADMIN_OVERRIDE_DELAY_SECS = 7 days]. Allowing 0 (vs.
//! initialize_config's strict > 0) is the load-bearing change for
//! compressed-time testing — admin must be able to set delay = 0 to make
//! admin_settle fire immediately at expiry.

use anchor_lang::prelude::*;
use crate::errors::BellMarketsError;
use crate::state::MarketConfig;

/// Max value matches `initialize_config::MAX_ADMIN_OVERRIDE_DELAY_SECS`.
/// 7 days = defensible upper bound for human-intervention windows.
const MAX_ADMIN_OVERRIDE_DELAY_SECS: i64 = 7 * 24 * 60 * 60;

#[derive(Accounts)]
pub struct UpdateAdminOverrideDelaySecs<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ BellMarketsError::NotAdmin,
    )]
    pub config: Box<Account<'info, MarketConfig>>,
}

pub fn handler(ctx: Context<UpdateAdminOverrideDelaySecs>, new_secs: i64) -> Result<()> {
    require!(
        (0..=MAX_ADMIN_OVERRIDE_DELAY_SECS).contains(&new_secs),
        BellMarketsError::InvalidConfigParam
    );
    let config = &mut ctx.accounts.config;
    config.admin_override_delay_secs = new_secs;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bound_zero_accepts() {
        // 0 is the compressed-time-testing target — admin_settle fires
        // immediately at expiry.
        assert!((0..=MAX_ADMIN_OVERRIDE_DELAY_SECS).contains(&0i64));
    }

    #[test]
    fn bound_one_hour_accepts() {
        // Production default.
        assert!((0..=MAX_ADMIN_OVERRIDE_DELAY_SECS).contains(&3_600i64));
    }

    #[test]
    fn bound_seven_days_accepts_upper() {
        assert!((0..=MAX_ADMIN_OVERRIDE_DELAY_SECS).contains(&MAX_ADMIN_OVERRIDE_DELAY_SECS));
    }

    #[test]
    fn bound_eight_days_rejects() {
        // 1 second over MAX must reject.
        assert!(!(0..=MAX_ADMIN_OVERRIDE_DELAY_SECS).contains(&(MAX_ADMIN_OVERRIDE_DELAY_SECS + 1)));
    }

    #[test]
    fn bound_negative_rejects() {
        assert!(!(0..=MAX_ADMIN_OVERRIDE_DELAY_SECS).contains(&-1i64));
    }
}
