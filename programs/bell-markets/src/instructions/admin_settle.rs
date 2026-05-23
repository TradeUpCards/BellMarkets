//! `admin_settle` — escape hatch when the oracle is unrecoverable past the
//! human-intervention delay window.
//!
//! Two discriminators distinguish admin-pathed settles from oracle-pathed
//! settles in the StrikeMarket record:
//!   - `settle_price == 0` => admin-pathed (this instruction)
//!   - `settle_price != 0` => oracle-pathed (settle_market)
//!
//! Downstream consumers (frontend display, analytics) use this to badge the
//! settlement source without needing a separate "source" field.

use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::BellMarketsError;

/// Admin escape hatch. Only callable AFTER `admin_override_delay_secs` past
/// expiry, by `config.admin`, and when the market is still Unsettled. Use:
/// the oracle is halted past the override window and we must manually rule
/// the market (Yes/No/Invalid) so users can redeem.
#[derive(Accounts)]
pub struct AdminSettle<'info> {
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
        constraint = strike_market.outcome == Outcome::Unsettled @ BellMarketsError::AlreadySettled,
        constraint = strike_market.config == config.key() @ BellMarketsError::ConfigMismatch,
    )]
    pub strike_market: Box<Account<'info, StrikeMarket>>,

    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<AdminSettle>, forced_outcome: Outcome) -> Result<()> {
    require!(
        forced_outcome != Outcome::Unsettled,
        BellMarketsError::ForcedOutcomeUnsettled
    );
    let now = ctx.accounts.clock.unix_timestamp;
    require!(
        now >= ctx.accounts.strike_market.admin_override_eligible_at,
        BellMarketsError::AdminOverrideTooEarly
    );

    let sm = &mut ctx.accounts.strike_market;
    sm.outcome = forced_outcome;
    sm.settled_at_unix = now;
    // settle_price / settle_confidence / settle_slot intentionally left at 0
    // to signal "admin-pathed settle" — downstream tooling can distinguish
    // oracle-derived settles (price != 0) from admin overrides (price == 0).
    Ok(())
}
