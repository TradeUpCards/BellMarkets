//! `pause` — global circuit breaker. Sets `config.paused`; every mutating
//! instruction (mint_pair, create_strike_market, settle_market, redeem,
//! redeem_invalid, admin_settle) refuses when paused. Read-side ops and
//! existing balances are unaffected.
//!
//! Per-market pause is intentionally not implemented — the design is global
//! kill-switch for an incident response, not granular per-strike control.

use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

#[derive(Accounts)]
pub struct Pause<'info> {
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

pub fn handler(ctx: Context<Pause>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    Ok(())
}
